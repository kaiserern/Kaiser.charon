import { now, json } from '../utils.js';
import { numSetting, boolSetting, strategyById, slippageAdjustedMcap } from '../db/settings.js';
import { db } from '../db/connection.js';
import { firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, computeAtrPercent, dynamicStopLossPercent } from '../utils.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext, fetchJupiterWalletPnl, fetchTokenSpotViaQuote } from '../enrichment/jupiter.js';
import { liveWalletPubkey, fetchLiveTokenBalance } from '../liveExecutor.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { filterCandidate } from '../pipeline/candidateBuilder.js';
import { openPositions } from '../db/positions.js';
import { updateCandidateSnapshot } from '../db/candidates.js';
import { trending } from '../signals/trending.js';
import { executeLiveSell } from './router.js';
import { sendPositionExit } from '../telegram/send.js';

export async function freshEntryMarket(mint, candidate) {
  const gmgn = await fetchGmgnTokenInfo(mint, false);
  const asset = await fetchJupiterAsset(mint, { useCache: false });
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  return { gmgn, asset, priceUsd, marketCapUsd, refreshedAtMs: now() };
}

export async function refreshCandidateForExecution(row) {
  const candidate = row.candidate;
  const mint = candidate.token.mint;
  const route = candidate.signals?.route || '';
  const isFresh = route.includes('pumpportal_graduated');

  let gmgn, asset, holders, chart;

  if (isFresh) {
    // Fast path: skip GMGN (Cloudflare blocked) and chart (no data for freshly graduated)
    [asset, holders] = await Promise.all([
      fetchJupiterAsset(mint, { useCache: false }),
      fetchJupiterHolders(mint),
    ]);
    gmgn = null;
    chart = null;
  } else {
    [gmgn, asset, holders] = await Promise.all([
      fetchGmgnTokenInfo(mint, false),
      fetchJupiterAsset(mint, { useCache: false }),
      fetchJupiterHolders(mint),
    ]);
    chart = null;  // chart not used in buy path — saves 10s timeout
  }
  const selectedTrending = trending.get(mint) || candidate.trending || null;
  const selectedHolders = holders?.holders?.length ? holders : candidate.holders;
  const selectedSavedWalletExposure = selectedHolders
    ? await fetchSavedWalletExposure(mint, selectedHolders)
    : candidate.savedWalletExposure;
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), asset?.usdPrice, selectedTrending?.price, candidate.metrics?.priceUsd);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    asset?.mcap,
    asset?.fdv,
    selectedTrending?.market_cap,
    candidate.metrics?.marketCapUsd,
    candidate.metrics?.graduatedMarketCapUsd,
  );
  const refreshed = {
    ...candidate,
    token: {
      ...candidate.token,
      name: gmgn?.name || asset?.name || selectedTrending?.name || candidate.token.name,
      symbol: gmgn?.symbol || asset?.symbol || selectedTrending?.symbol || candidate.token.symbol,
      twitter: candidate.token.twitter || asset?.twitter || gmgn?.link?.twitter_username || selectedTrending?.twitter || '',
      website: candidate.token.website || asset?.website || gmgn?.link?.website || '',
      telegram: candidate.token.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      ...candidate.metrics,
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? candidate.metrics?.liquidityUsd ?? 0),
      holderCount: Number(gmgn?.holder_count ?? asset?.holderCount ?? selectedTrending?.holder_count ?? candidate.metrics?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? asset?.fees ?? candidate.metrics?.gmgnTotalFeesSol ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? candidate.metrics?.gmgnTradeFeesSol ?? 0),
      trendingVolumeUsd: Number(selectedTrending?.volume ?? candidate.metrics?.trendingVolumeUsd ?? 0),
      trendingSwaps: Number(selectedTrending?.swaps ?? candidate.metrics?.trendingSwaps ?? 0),
      trendingHotLevel: Number(selectedTrending?.hot_level ?? candidate.metrics?.trendingHotLevel ?? 0),
      trendingSmartDegenCount: Number(selectedTrending?.smart_degen_count ?? candidate.metrics?.trendingSmartDegenCount ?? 0),
    },
    gmgn,
    jupiterAsset: asset,
    trending: selectedTrending,
    holders: selectedHolders,
    chart,
    savedWalletExposure: selectedSavedWalletExposure,
    executionRefresh: {
      refreshedAtMs: now(),
      source: 'pre_execution',
      marketCapUsd,
      priceUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? asset?.liquidity ?? selectedTrending?.liquidity ?? 0),
      holdersRefreshed: Boolean(holders?.holders?.length),
    },
  };
  refreshed.filters = filterCandidate(refreshed);
  const executionFailures = [];
  if (!Number.isFinite(Number(refreshed.metrics.marketCapUsd)) || Number(refreshed.metrics.marketCapUsd) <= 0) {
    executionFailures.push('execution mcap: missing');
  }
  if (!Number.isFinite(Number(refreshed.metrics.priceUsd)) || Number(refreshed.metrics.priceUsd) <= 0) {
    executionFailures.push('execution price: missing');
  }
  if (executionFailures.length) {
    refreshed.filters = {
      ...refreshed.filters,
      passed: false,
      failures: [...(refreshed.filters?.failures || []), ...executionFailures],
    };
  }
  updateCandidateSnapshot(row.id, refreshed, refreshed.filters.passed ? 'candidate' : 'filtered');
  return { ...row, candidate: refreshed };
}

const sellInProgress = new Set();

export async function refreshPosition(position, { autoExit = true, jupiterPnl = null } = {}) {
  // Bug2 fix (2026-06-19): bypass 20s cache for live monitoring — flash crash detection requires fresh data
  // Quote-first (2026-07-24): dry_run exit decisions use executable Jupiter quote (live pool
  // reserves) as primary price — datapi mark is stale by design. Mark = fallback on 429/backoff.
  const useQuote = position.execution_mode !== 'live' && numSetting('exit_quote_enabled', 1);
  const [asset, qp] = await Promise.all([
    fetchJupiterAsset(position.mint, { useCache: false, ttlMs: 3000 }),
    useQuote ? fetchTokenSpotViaQuote(position.mint) : Promise.resolve(null),
  ]);
  const quotePrice = (Number.isFinite(qp) && qp > 0) ? qp : null;
  const quoteMcap = quotePrice && Number(position.entry_price) > 0
    ? Number(position.entry_mcap) * (quotePrice / Number(position.entry_price))
    : null;
  const jupiterPrice = Number(asset?.usdPrice);
  const jupiterMcap = firstPositiveNumber(asset?.mcap, asset?.fdv);
  // Guard 1 DISABLED (2026-07-17): can't distinguish crash vs stale data — single source (Jupiter) is unreliable
  const price = firstPositiveNumber(quotePrice, jupiterPrice || null, position.high_water_price, position.entry_price);
  const mcap = firstPositiveNumber(quoteMcap, jupiterMcap, position.high_water_mcap, position.entry_mcap);
  if (!Number.isFinite(Number(mcap)) || !Number.isFinite(Number(position.entry_mcap)) || Number(position.entry_mcap) <= 0) {
    return null;
  }
  // Guard 2 DISABLED (2026-07-17): drop >80% heuristic can't distinguish crash vs stale bonding curve data
  const highWaterMcap = Math.max(Number(position.high_water_mcap || 0), Number(mcap));
  const highWaterPrice = Math.max(Number(position.high_water_price || 0), Number(price || 0));
  let pnlPercent = (Number(mcap) / Number(position.entry_mcap) - 1) * 100;
  const markPnlPercent = pnlPercent;
  let pnlSol = Number(position.size_sol) * pnlPercent / 100;
  if (jupiterPnl && Number.isFinite(Number(jupiterPnl.totalPnlPercentageNative))) {
    pnlPercent = Number(jupiterPnl.totalPnlPercentageNative);
    pnlSol = Number.isFinite(Number(jupiterPnl.totalPnlNative)) ? Number(jupiterPnl.totalPnlNative) : pnlSol;
  }
  // Dynamic ATR-based stop loss: fetch chart context and compute ATR% to widen/narrow the static sl_percent.
  const stratForSl = strategyById(position.strategy_id);
  const useDynamicSl = (stratForSl?.use_dynamic_sl ?? numSetting('use_dynamic_sl', 1)) ? true : false;
  let effectiveSlPercent = Number(position.sl_percent);
  let atrPercent = null;
  if (useDynamicSl) {
    try {
      const chart = await fetchJupiterChartContext(position.mint);
      const windows = Array.isArray(chart?.windows) ? chart.windows : [];
      atrPercent = computeAtrPercent(windows, numSetting('atr_period', 14));
      effectiveSlPercent = dynamicStopLossPercent({
        baseSlPercent: Number(position.sl_percent),
        atrPercent,
        multiplier: Number(stratForSl?.atr_sl_multiplier ?? numSetting('atr_sl_multiplier', 1.5)),
        floorPercent: Number(stratForSl?.atr_sl_floor_percent ?? numSetting('atr_sl_floor_percent', -50)),
        ceilingPercent: Number(stratForSl?.atr_sl_ceiling_percent ?? numSetting('atr_sl_ceiling_percent', -8)),
        minAtrPercent: Number(stratForSl?.atr_sl_min_atr_percent ?? numSetting('atr_sl_min_atr_percent', 4)),
        maxAtrPercent: Number(stratForSl?.atr_sl_max_atr_percent ?? numSetting('atr_sl_max_atr_percent', 30)),
      });
    } catch (err) {
      console.log(`[atr] chart refresh failed for ${position.mint.slice(0, 8)}... ${err.message}`);
    }
  }
  const tpHit = pnlPercent >= Number(position.tp_percent);
  const slHit = pnlPercent <= effectiveSlPercent && pnlPercent < 0; // Lesson 3: don't SL if PnL positive
  const armThreshold = numSetting('trailing_arm_percent', Number(position.tp_percent));
  const armHit = pnlPercent >= armThreshold;
  const trailingArmed = position.trailing_armed || (position.trailing_enabled && armHit);
  const trailDrop = highWaterMcap > 0 ? (Number(mcap) / highWaterMcap - 1) * 100 : 0;
  // EXIT-FIX 2026-07-25 (backtest 933 trades 07-22..25: base +1,685% -> +8,766% ideal / +6,314% gap).
  // (1) TIGHT TRAIL: once peak pnl >= trailing_tight_from_percent (40), trail tightens from
  //     trailing_percent (10) to trailing_tight_percent (5). Rescues armed winners that round-trip
  //     to SL (97 armed+SL trades = -6,497% pnl in window).
  // (2) FLOOR: once armed, trailing may not exit below trailing_floor_percent (+8). Kills the
  //     +1.7% "gap-dump between 3s ticks" exits (dump lands below arm before next check).
  // Partial@arm REJECTED by backtest (-867%): caps the runners that carry total profit.
  const peakPnl = Number(position.entry_mcap) > 0
    ? (highWaterMcap / Number(position.entry_mcap) - 1) * 100
    : pnlPercent;
  const tightFrom = numSetting('trailing_tight_from_percent', 40);
  const effectiveTrailPct = peakPnl >= tightFrom
    ? numSetting('trailing_tight_percent', 5)
    : Math.abs(Number(position.trailing_percent));
  const trailingFloor = numSetting('trailing_floor_percent', 8);
  const trailingHit = trailingArmed && position.trailing_enabled && pnlPercent >= trailingFloor && trailDrop <= -effectiveTrailPct;
  let exitReason = null;
  let closed = false;

  // Max hold time check — tiered by entry mcap
  const strat = strategyById(position.strategy_id);
  const entryMcap = Number(position.entry_mcap) || 0;
  const isMicrocap = entryMcap > 0 && entryMcap < 15000;
  const isHighcap = entryMcap >= 60000;
  const effectiveMaxHold = strat?.max_hold_ms ?? 0;
  // === AUDIT MODE: tiered max_hold disabled for 3-day data collection (2026-07-05) ===
  // if (isMicrocap) {
  //   effectiveMaxHold = 600000; // 10 min for microcap <15K
  //   console.log(`[position] microcap <15K — max_hold reduced to 10min`);
  // } else if (isHighcap) {
  //   effectiveMaxHold = 900000; // 15 min for highcap >60K
  //   console.log(`[position] highcap >60K — max_hold reduced to 15min`);
  // }
  if (effectiveMaxHold > 0 && (now() - position.opened_at_ms) >= effectiveMaxHold) {
    exitReason = 'MAX_HOLD';
  }

  // Sideways timeout: if open too long with negligible PnL, exit to free up capital.
  if (!exitReason) {
    const sidewaysMinutes = Number(strat?.sideways_timeout_minutes ?? numSetting('sideways_timeout_minutes', 0));
    if (sidewaysMinutes > 0) {
      const ageSeconds = (now() - position.opened_at_ms) / 1000;
      if (ageSeconds > sidewaysMinutes * 60 && Math.abs(pnlPercent) < 2) {
        exitReason = 'SIDEWAYS_TIMEOUT';
      }
    }
  }

  // Partial TP check
  if (!exitReason && strat?.partial_tp && !position.partial_tp_done && pnlPercent >= strat.partial_tp_at_percent) {
    console.log(`[position] ${position.id} partial TP at ${pnlPercent.toFixed(1)}% (${strat.partial_tp_sell_percent}% sell)`);
    if (position.execution_mode === 'live' && position.token_amount_raw) {
      const recorded = Number(position.token_amount_raw);
      try {
        // O4 / P1-b: reconcile recorded balance against the on-chain wallet before selling.
        // If a prior partial sell landed but threw (network/RPC), token_amount_raw is stale and
        // re-selling from it would double-sell. Sync to wallet truth; if already reduced, done.
        // fetchLiveTokenBalance returns null ONLY on RPC failure (then we can't verify, fall through).
        // A real "0" returns the string "0" - that's authoritative and lower than recorded.
        const walletBalance = await fetchLiveTokenBalance(position.mint);
        if (walletBalance !== null && Number(walletBalance) < recorded) {
          console.log(`[position] ${position.id} partial TP reconcile: wallet ${walletBalance} < recorded ${recorded}, prior sell landed — marking done`);
          db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1, token_amount_raw = ? WHERE id = ?').run(String(Number(walletBalance)), position.id);
        } else {
          const sellAmount = Math.floor(recorded * (strat.partial_tp_sell_percent / 100));
          if (sellAmount > 0) {
            const sell = await executeLiveSell({ ...position, token_amount_raw: String(sellAmount) }, 'PARTIAL_TP');
            // O4: only mark partial_tp_done AFTER the sell succeeds, so a failed partial sell
            // retries on the next monitor pass instead of stranding the unsold remainder.
            db.prepare('UPDATE dry_run_positions SET partial_tp_done = 1, token_amount_raw = ? WHERE id = ?').run(
              String(recorded - sellAmount), position.id);
            db.prepare(`
              INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
              VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, 'PARTIAL_TP', ?)
            `).run(position.id, position.mint, now(), price, mcap,
              position.size_sol * (strat.partial_tp_sell_percent / 100), sellAmount,
              json({ pnlPercent, sell, partialSellPercent: strat.partial_tp_sell_percent, remaining: recorded - sellAmount }));
            console.log(`[position] ${position.id} partial TP sold ${sellAmount} tokens, ${recorded - sellAmount} remaining`);
          }
        }
      } catch (err) {
        console.log(`[position] ${position.id} partial sell failed (will retry): ${err.message}`);
      }
    }
  }

  // Standard exit checks
  if (!exitReason) {
    if (slHit) exitReason = 'SL';
    else if (tpHit && !position.trailing_enabled) exitReason = 'TP';
    else if (trailingHit) exitReason = 'TRAILING_TP';
  }


  // Live exits will override these with realized SOL values
  let finalPnlPercent = pnlPercent;
  let finalPnlSol = pnlSol;

  db.prepare(`
    UPDATE dry_run_positions
    SET high_water_mcap = ?, high_water_price = ?, trailing_armed = ?
    WHERE id = ?
  `).run(highWaterMcap, highWaterPrice, trailingArmed ? 1 : 0, position.id);

  if (exitReason && autoExit && position.execution_mode === 'live') {
    if (sellInProgress.has(position.id)) return { ...position, exitReason: null };
    sellInProgress.add(position.id);
    let sell;
    try {
      sell = await executeLiveSell(position, exitReason);
    } finally {
      sellInProgress.delete(position.id);
    }
    const receivedLamports = Number(sell.outputAmount || 0);
    const receivedSol = receivedLamports > 0 ? receivedLamports / 1_000_000_000 : null;
    if (receivedSol != null) {
      finalPnlSol = receivedSol - Number(position.size_sol);
      finalPnlPercent = (receivedSol / Number(position.size_sol) - 1) * 100;
    }
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?,
          pnl_percent = ?, pnl_sol = ?, exit_signature = ?
      WHERE id = ?
    `).run(now(), price, mcap, exitReason, finalPnlPercent, finalPnlSol, sell.signature, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), price, mcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: finalPnlPercent, pnlSol: finalPnlSol, receivedSol: receivedSol ?? null, sell, effectiveSlPercent, atrPercent, baseSlPercent: Number(position.sl_percent) }));
    closed = true;
  } else if (exitReason && autoExit) {
    // Apply exit slippage for dry_run PnL
    const exitMcap = slippageAdjustedMcap(quotePrice ? Number(position.entry_mcap) * (quotePrice / Number(position.entry_price)) : mcap, 'exit');
    const dryExitPrice = quotePrice || price;
    const dryExitMcap = quotePrice ? Number(position.entry_mcap) * (quotePrice / Number(position.entry_price)) : mcap;
    const dryPnlPercent = (Number(exitMcap) / Number(position.entry_mcap) - 1) * 100;
    const dryPnlSol = Number(position.size_sol) * dryPnlPercent / 100;
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_price = ?, exit_mcap = ?, exit_reason = ?, pnl_percent = ?, pnl_sol = ?
      WHERE id = ?
    `).run(now(), dryExitPrice, dryExitMcap, exitReason, dryPnlPercent, dryPnlSol, position.id);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?)
    `).run(position.id, position.mint, now(), dryExitPrice, dryExitMcap, position.size_sol, position.token_amount_est, exitReason, json({ pnlPercent: dryPnlPercent, pnlSol: dryPnlSol, effectiveSlPercent, atrPercent, baseSlPercent: Number(position.sl_percent), slippage_pct: numSetting('dry_run_slippage_percent', 0) }));
    finalPnlPercent = dryPnlPercent;
    finalPnlSol = dryPnlSol;
    closed = true;
  }
  return {
    ...position,
    status: closed ? 'closed' : position.status,
    closed_at_ms: closed ? now() : position.closed_at_ms,
    asset,
    price,
    mcap,
    highWaterMcap,
    high_water_mcap: highWaterMcap,
    high_water_price: highWaterPrice,
    pnlPercent: finalPnlPercent,
    pnl_percent: finalPnlPercent,
    pnlSol: finalPnlSol,
    pnl_sol: finalPnlSol,
    exitReason: closed ? exitReason : null,
    exit_reason: closed ? exitReason : position.exit_reason,
    exit_mcap: closed ? mcap : position.exit_mcap,
    exit_price: closed ? price : position.exit_price,
  };
}

export async function monitorPositions() {
  const positions = openPositions();
  let walletPnlData = {};
  const pubkey = liveWalletPubkey();
  if (pubkey && positions.some(p => p.execution_mode === 'live')) {
    walletPnlData = await fetchJupiterWalletPnl(pubkey);
  }
  for (const position of positions) {
    const jupiterPnl = position.execution_mode === 'live'
      ? (walletPnlData[position.mint]?.pnl || null)
      : null;
    const result = await refreshPosition(position, { autoExit: true, jupiterPnl }).catch((err) => {
      console.log(`[position] ${position.id} ${err.message}`);
      return null;
    });
    if (result?.exitReason) await sendPositionExit(result);
  }
}
