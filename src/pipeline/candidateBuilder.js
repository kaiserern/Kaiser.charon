import { now, firstPositiveNumber, marketCapFromGmgn, tokenPriceFromGmgn, lamToSol } from '../utils.js';
import { activeStrategy } from '../db/settings.js';
import { JUPITER_ASSET_FRESH_TTL_MS } from '../config.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { fetchJupiterAsset, fetchJupiterHolders, fetchJupiterChartContext } from '../enrichment/jupiter.js';
import { fetchSavedWalletExposure } from '../enrichment/wallets.js';
import { fetchTwitterNarrative } from '../enrichment/twitter.js';
import { gmgnLink } from '../format.js';
import { effectivePositionSizeSol } from './llm.js';
import { openPositionCount } from '../db/positions.js';

export function buildFeeSnapshot(fee, signature) {
  return {
    mint: fee.mint,
    signature,
    distributedSol: lamToSol(fee.distributed),
    recipients: fee.shareholders.map(holder => ({
      address: holder.pubkey,
      bps: holder.bps,
      percent: holder.bps / 100,
    })),
  };
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

// Detect freshly graduated tokens: route is pumpportal_graduated (token just graduated, filters relaxed)
function isFreshlyGraduated(candidate) {
  const route = candidate.signals?.route || '';
  return route.includes('pumpportal_graduated') || route.includes('pumpfun_pregrad');
}

export function filterCandidate(candidate) {
  const strat = activeStrategy();
  const failures = [];
  const mcap = candidate.metrics.marketCapUsd;
  const totalFees = candidate.metrics.gmgnTotalFeesSol;
  const gradVolume = candidate.metrics.graduatedVolumeUsd;
  const maxHolder = candidate.holders.maxHolderPercent;
  const savedCount = candidate.savedWalletExposure.holderCount;
  const feeSol = candidate.feeClaim?.distributedSol;
  const holderCount = Number(candidate.metrics.holderCount || 0);
  const trendingVolume = Number(candidate.trending?.volume ?? 0);
  const trendingSwaps = Number(candidate.trending?.swaps ?? 0);
  const rugRatio = Number(candidate.trending?.rug_ratio ?? 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate ?? 0);
  const freshGrad = isFreshlyGraduated(candidate);

  // Fresh grad insufficient data check: v40 pre-filter relies on jupiterAsset.audit (botHolders%, top10, devMigrations).
  // When audit is null/empty, v40 pre-filter is bypassed and LLM makes blind decisions. Reject fresh grads with
  // no Jupiter data, zero liquidity/holders, or 0-second migration (impossible for organic activity).
  if (freshGrad) {
    const reasons = [];
    if (candidate.jupiterAsset === null || candidate.jupiterAsset === undefined) {
      reasons.push('no jupiterAsset');
    } else {
      const liquidityUsd = Number(candidate.jupiterAsset.liquidity ?? 0);
      const holderCount = Number(candidate.jupiterAsset.holderCount ?? 0);
      if (liquidityUsd === 0) reasons.push('liquidity=$0');
      if (holderCount === 0) reasons.push('holders=0');
    }
    if (Array.isArray(candidate.graduation?.patternFlags)
        && candidate.graduation.patternFlags.includes('fast_migration_0s')) {
      reasons.push('fast_migration_0s');
    }
    if (reasons.length > 0) {
      failures.push(`fresh grad insufficient data: ${reasons.join(', ')}`);
    }
  }

  // Fee claim check
  if (candidate.feeClaim) {
    const minFee = strat.min_fee_claim_sol ?? 0.5;
    if (minFee > 0 && feeSol < minFee) {
      failures.push(`fee claim: ${feeSol} SOL < min ${minFee} SOL`);
    }
  } else if (strat.require_fee_claim) {
    failures.push('fee claim: missing (required by strategy)');
  }

  // Market cap checks — skip min_mcap for freshly graduated (tokens just graduated, mcap is tiny)
  if (strat.min_mcap_usd > 0 && (!Number.isFinite(mcap) || mcap < strat.min_mcap_usd)) {
    if (!freshGrad) {
      failures.push(`market cap min: ${mcap} < ${strat.min_mcap_usd}`);
    }
  }
  if (strat.max_mcap_usd > 0 && Number.isFinite(mcap) && mcap > strat.max_mcap_usd) {
    failures.push(`market cap max: ${mcap} > ${strat.max_mcap_usd}`);
  }

  // GMGN fees — only enforce when GMGN data is available; Jupiter has no equivalent
  if (strat.min_gmgn_total_fee_sol > 0 && candidate.gmgn !== null && totalFees < strat.min_gmgn_total_fee_sol) {
    failures.push(`GMGN total fees: ${totalFees} < ${strat.min_gmgn_total_fee_sol}`);
  }

  // Graduated volume — only enforce when the token actually has graduated data
  if (strat.min_graduated_volume_usd > 0 && candidate.graduation && gradVolume < strat.min_graduated_volume_usd) {
    failures.push(`graduated volume: ${gradVolume} < ${strat.min_graduated_volume_usd}`);
  }

  // Holder count — skip for freshly graduated (brand new tokens have few holders)
  if (!freshGrad && strat.min_holders > 0 && holderCount < strat.min_holders) {
    failures.push(`holders: ${holderCount} < ${strat.min_holders}`);
  }

  // Top holder concentration
  if (strat.max_top20_holder_percent < 100 && Number.isFinite(maxHolder) && maxHolder > strat.max_top20_holder_percent) {
    failures.push(`max top holder: ${maxHolder}% > ${strat.max_top20_holder_percent}%`);
  }

  // === AUDIT MODE: All hard filters disabled for 3-day data collection (2026-07-05) ===

  // Pumpportal bot dominance check — DISABLED for audit
  // const botHolders = Number(candidate.jupiterAsset?.audit?.botHoldersCount ?? 0);
  // if (botHolders >= 50 && candidate.signals?.route === 'pumpportal_graduated') {
  //   failures.push(`pumpportal bot-dominated: ${botHolders} bots >= 50`);
  // }

  // Audit-based hard rejects — DISABLED for audit
  // const top10Pct = Number(candidate.jupiterAsset?.audit?.topHoldersPercentage ?? null);
  // const devMigrations = Number(candidate.jupiterAsset?.audit?.devMigrations ?? null);
  // if (Number.isFinite(top10Pct) && top10Pct >= 50) {
  //   failures.push(`top10 holders: ${top10Pct.toFixed(1)}% >= 50% (too concentrated)`);
  // }
  // const devMigThreshold = freshGrad ? 15 : 7;
  // if (Number.isFinite(devMigrations) && devMigrations >= devMigThreshold) {
  //   failures.push(`dev migrations: ${devMigrations} >= ${devMigThreshold} (serial rugger${freshGrad ? ', fresh grad' : ''})`);
  // }

  // === v40 per-route filters — DISABLED for audit ===
  // const signalRoute = candidate.signals?.route;
  // const top10 = Number(candidate.jupiterAsset?.audit?.topHoldersPercentage ?? null);
  // const devMig = Number(candidate.jupiterAsset?.audit?.devMigrations ?? null);
  // const botPct = Number(candidate.jupiterAsset?.audit?.botHoldersPercentage ?? null);

  // TIER 1A: Bot holders ≥25% = HARD REJECT — DISABLED for audit
  // if (Number.isFinite(botPct) && botPct >= 25) {
  //   failures.push(`bot holders death zone: ${botPct.toFixed(1)}% >= 25% (HARD REJECT, -11.77 SOL historical)`);
  // }
  
  // TIER 1B: Holder count deadzone — DISABLED for audit
  // if (holderCount >= 100 && holderCount <= 400) {
  //   candidate.riskFlags = candidate.riskFlags || [];
  //   candidate.riskFlags.push({
  //     type: 'holder_deadzone',
  //     severity: 2,
  //     reason: `holder count ${holderCount} in deadzone [100,400], historical 36% WR`,
  //   });
  // }
  
  // TIER 1C: Dev migrations ≥20 — DISABLED for audit
  // if (Number.isFinite(devMigrations) && devMigrations >= 20) {
  //   candidate.riskFlags = candidate.riskFlags || [];
  //   candidate.riskFlags.push({
  //     type: 'serial_rugger',
  //     severity: 1,
  //     reason: `dev migrations ${devMigrations} >= 20, historical 33% WR`,
  //   });
  // }

  // Per-route filters — DISABLED for audit
  // if (signalRoute === 'pumpportal_graduated') {
  //   if (Number.isFinite(top10) && top10 >= 15 && top10 < 25) {
  //     failures.push(`pumpportal top10 rug zone: ${top10.toFixed(1)}% in [15,25)`);
  //   }
  //   if (!freshGrad && Number.isFinite(devMig) && devMig > 10) {
  //     failures.push(`pumpportal dev_migrations: ${devMig} > 10 (serial rugger)`);
  //   }
  //   if (Number.isFinite(botPct) && botPct > 30) {
  //     failures.push(`pumpportal bot-dominated: ${botPct.toFixed(1)}% > 30%`);
  //   }
  // }

  // if (signalRoute === 'fee_trending') {
  //   if (!freshGrad && Number.isFinite(devMig) && devMig > 10) {
  //     failures.push(`fee_trending dev_migrations: ${devMig} > 10 (serial rugger)`);
  //   }
  //   if (Number.isFinite(botPct) && botPct > 30) {
  //     failures.push(`fee_trending bot-dominated: ${botPct.toFixed(1)}% > 30%`);
  //   }
  // }

  // if (signalRoute === 'trenches_completed') {
  //   if (Number.isFinite(top10) && top10 >= 25 && top10 < 35) {
  //     failures.push(`trenches top10 rug zone: ${top10.toFixed(1)}% in [25,35)`);
  //   }
  // }

  // Trenches route: mcap is already checked by strategy max_mcap_usd — no extra cap needed

  // Saved wallet holders
  if (strat.min_saved_wallet_holders > 0 && savedCount < strat.min_saved_wallet_holders) {
    failures.push(`saved wallet holders: ${savedCount} < ${strat.min_saved_wallet_holders}`);
  }

  // ATH distance (dip buy strategy) — skip for freshly graduated (chart data from Jupiter is meaningless at graduation)
  if (!freshGrad && strat.max_ath_distance_pct < 0) {
    const athDist = candidate.chart?.distanceFromAthPercent;
    if (athDist != null && athDist > strat.max_ath_distance_pct) {
      failures.push(`ATH distance: ${athDist.toFixed(0)}% > target ${strat.max_ath_distance_pct}%`);
    }
  }

  // Trending filters
  if (candidate.trending) {
    // BACKTEST 2026-07-07 (B-1): trending_min_volume_usd was INVERTED — it admitted the
    // worse half (trendingVol>=5000 -> -13.87 SOL vs <5000 -> -3.41 SOL). Higher trending
    // volume monotonically correlates with LOSS here. Disabled as a floor. Do NOT re-enable
    // as a minimum; if used at all it should be a CAP. See BACKTEST_EDGE_2026-07-07.md.
    // if (strat.trending_min_volume_usd > 0 && trendingVolume < strat.trending_min_volume_usd) {
    //   failures.push(`trending volume: ${trendingVolume} < ${strat.trending_min_volume_usd}`);
    // }
    if (strat.trending_min_swaps > 0 && trendingSwaps < strat.trending_min_swaps) {
      failures.push(`trending swaps: ${trendingSwaps} < ${strat.trending_min_swaps}`);
    }
    if (strat.trending_max_rug_ratio > 0 && Number.isFinite(rugRatio) && rugRatio > strat.trending_max_rug_ratio) {
      failures.push(`trending rug ratio: ${rugRatio} > ${strat.trending_max_rug_ratio}`);
    }
    if (strat.trending_max_bundler_rate > 0 && Number.isFinite(bundlerRate) && bundlerRate > strat.trending_max_bundler_rate) {
      failures.push(`trending bundler rate: ${bundlerRate} > ${strat.trending_max_bundler_rate}`);
    }
    if (candidate.trending.is_wash_trading === true || candidate.trending.is_wash_trading === 1) {
      failures.push('trending wash trading');
    }
  }

  // Token age check — reject tokens older than token_age_max_ms (default 12 hours)
  const tokenAgeMs = strat.token_age_max_ms ?? 43200000; // 12 hours default
  if (tokenAgeMs > 0) {
    const trenchesCreatedTs = candidate.trenchesEntry?.created_timestamp;
    const graduatedTs = candidate.graduation?.graduationDate || candidate.graduation?.seenAt;
    const tokenCreatedTs = trenchesCreatedTs || graduatedTs;
    if (tokenCreatedTs > 0) {
      const tokenAgeMsActual = now() - (tokenCreatedTs > 1e12 ? tokenCreatedTs : tokenCreatedTs * 1000);
      if (tokenAgeMsActual > tokenAgeMs) {
        const ageH = (tokenAgeMsActual / 3600000).toFixed(1);
        failures.push(`token age: ${ageH}h > max ${tokenAgeMs / 3600000}h`);
      }
    }
  }

  // Buy pressure check — need buy/sell ratio > 1.0 (skip for freshly graduated: no data)
  const buyVol = Number(candidate.gmgn?.buy_vol_24h || candidate.gmgn?.buy_volume || 0);
  const sellVol = Number(candidate.gmgn?.sell_vol_24h || candidate.gmgn?.sell_volume || 0);
  if (!freshGrad && buyVol > 0 && sellVol > 0 && (buyVol / sellVol) < 1.0) {
    failures.push(`buy pressure weak: buy/sell ratio ${(buyVol/sellVol).toFixed(2)} < 1.0`);
  }

  // Liquidity check — BACKTEST 2026-07-07: raised floor from $2K to $6K.
  // liq>=6000 across ALL routes = +5.36 SOL / 932 trades vs baseline +1.08 / 1150,
  // and it holds in both time-halves (H1 +6.11, H2 -0.75 vs base H2 -4.00). It is
  // monotonic (every neighboring threshold behaves the same) — a real signal, not a
  // lucky bucket. Fresh-grads are NOT exempted: their liq<6000 subset lost -2.43 SOL
  // (WR 31%), so exempting them cut total to +2.94. Read from candidate.metrics.liquidityUsd
  // (same field the backtest measured). See BACKTEST_EDGE_2026-07-07.md.
  const liquidity = Number(candidate.metrics?.liquidityUsd || candidate.gmgn?.pool?.liquidity || candidate.gmgn?.liquidity || 0);
  if (liquidity > 0 && liquidity < 6000) {
    failures.push(`DEX liquidity too low: $${liquidity.toFixed(0)} < $6000`);
  }

  // === FLOW FILTER (2026-07-17): momentum + net buying pressure ===
  // Backtest: 1,415 trades, 11 days. Filter: s1h_priceChange >= 0 & net_buyer_ratio_5m >= 0.2
  // Result: 945 trades (67% keep), 47.9% WR, +14.09 SOL (+3.45 delta), 100% daily consistency.
  // Uses Jupiter stats (not GMGN — better coverage). Applies to ALL routes including fresh grads.
  const s1hPriceChange = Number(candidate.jupiterAsset?.stats1h?.priceChange ?? null);
  const s5mNumNetBuyers = Number(candidate.jupiterAsset?.stats5m?.numNetBuyers ?? null);
  const s5mNumTraders = Number(candidate.jupiterAsset?.stats5m?.numTraders ?? null);

  // Only reject when Jupiter data is available (don't penalize missing data)
  if (Number.isFinite(s1hPriceChange) && s1hPriceChange < 0) {
    failures.push(`flow: 1h price change ${s1hPriceChange.toFixed(1)}% < 0% (dumping)`);
  }

  if (Number.isFinite(s5mNumNetBuyers) && Number.isFinite(s5mNumTraders) && s5mNumTraders > 0) {
    const netBuyerRatio = s5mNumNetBuyers / s5mNumTraders;
    if (netBuyerRatio < 0.2) {
      failures.push(`flow: net buyer ratio ${netBuyerRatio.toFixed(2)} < 0.2 (selling pressure)`);
    }
  }

  // === v45 Soft Scoring System ===
  // Score each candidate on a 0-100 scale. Route-aware weights.
  // Score >= soft_threshold: PASS to LLM. Below: REJECT (unless hard_floor_override).
  const softScore = computeSoftScore(candidate, strat, freshGrad);
  
  // Dynamic threshold: tighten when many positions open, loosen when idle
  const softThreshold = softScoreThreshold(strat);
  
  if (softScore < softThreshold) {
    failures.push(`soft score: ${softScore} < threshold ${softThreshold}`);
  }
  
  if (failures.length > 0) {
    console.log(`[candidate] filtered ${candidate.token.mint.slice(0, 8)}... ${failures.join('; ')} (soft=${softScore}/${softThreshold})`);
  }

  return { passed: failures.length === 0, failures, strategy: strat.id, softScore, softThreshold };
}

// ============================================================
// v45 Soft Scoring Engine
// ============================================================

function computeSoftScore(candidate, strat, isFreshGrad) {
  let score = 100;
  const route = candidate.signals?.route || '';
  
  const mcap = Number(candidate.metrics?.marketCapUsd || candidate.jupiterAsset?.marketCapUsd || 0);
  const liquidityUsd = Number(candidate.metrics?.liquidityUsd || candidate.jupiterAsset?.liquidityUsd || candidate.gmgn?.liquidity || 0);
  const holderCount = Number(candidate.metrics?.holderCount || candidate.jupiterAsset?.holderCount || candidate.gmgn?.holder_count || 0);
  const botHolders = Number(candidate.jupiterAsset?.audit?.botHoldersCount || 0);
  const botPct = candidate.jupiterAsset?.audit?.botHoldersPercentage;
  const top10Pct = candidate.jupiterAsset?.audit?.topHoldersPercentage;
  const devMigrations = candidate.jupiterAsset?.audit?.devMigrations;
  const athDistance = candidate.chart?.distanceFromAthPercent;
  const smartDegens = Number(candidate.trending?.smart_degen_count || 0);
  const organicScore = Number(candidate.trending?.organic_score || 0);
  const bundlerRate = Number(candidate.trending?.bundler_rate || 0);

  // --- NEGATIVE: Liquidity (all routes) ---
  if (liquidityUsd > 0) {
    if (liquidityUsd < 3000) { score -= 35; }
    else if (liquidityUsd < 5000) { score -= 25; }
    else if (liquidityUsd < 10000) { score -= 10; }
  }

  // --- NEGATIVE: Bot holders (route-specific weight) ---
  if (route === 'pumpportal_graduated') {
    if (botHolders >= 80) { score -= 40; }
    else if (botHolders >= 50) { score -= 30; }
    else if (botHolders >= 30) { score -= 15; }
  } else if (route === 'trenches_completed') {
    // Trenches: high bot = more tolerant (smart money + bots coexist)
    if (botHolders >= 100) { score -= 25; }
    else if (botHolders >= 50) { score -= 10; }
  } else if (route === 'fee_trending') {
    if (botHolders >= 100) { score -= 30; }
    else if (botHolders >= 50) { score -= 15; }
  }

  // --- NEGATIVE: Bot percentage (all routes) ---
  if (botPct != null && botPct > 0) {
    if (botPct > 50) { score -= 25; }
    else if (botPct > 30) { score -= 15; }
  }

  // --- NEGATIVE: Top10 concentration (route-specific zones) ---
  if (top10Pct != null && top10Pct > 0) {
    if (route === 'pumpportal_graduated') {
      if (top10Pct >= 15 && top10Pct < 25) { score -= 30; } // Rug zone
      else if (top10Pct >= 50) { score -= 20; }
    } else if (route === 'trenches_completed') {
      if (top10Pct >= 25 && top10Pct < 35) { score -= 20; } // Trenches rug zone
      else if (top10Pct >= 50) { score -= 15; }
    } else {
      if (top10Pct >= 50) { score -= 20; }
    }
  }

  // --- NEGATIVE: Dev migrations (non-fresh, all routes) ---
  if (!isFreshGrad && devMigrations != null) {
    if (devMigrations >= 15) { score -= 30; }
    else if (devMigrations >= 7) { score -= 20; }
    else if (devMigrations >= 3) { score -= 5; }
  }

  // --- NEGATIVE: Holder count (non-fresh, route-specific) ---
  if (!isFreshGrad && holderCount > 0) {
    if (route === 'pumpportal_graduated') {
      if (holderCount < 30) { score -= 20; }
      else if (holderCount < 50) { score -= 10; }
    } else if (route === 'trenches_completed') {
      if (holderCount < 30) { score -= 10; }
    }
  }

  // --- NEGATIVE: ATH distance (non-fresh) ---
  if (!isFreshGrad && athDistance != null) {
    if (athDistance > -20) { score -= 15; }
    else if (athDistance > -30) { score -= 10; }
  }

  // --- NEGATIVE: Mcap range (route-specific) ---
  if (route === 'trenches_completed') {
    if (mcap > 0 && mcap < 25000) { score -= 15; }
  } else if (route === 'fee_trending') {
    if (mcap > 0 && mcap < 40000) { score -= 15; }
  }

  // --- NEGATIVE: Bundler rate ---
  if (bundlerRate != null) {
    if (bundlerRate > 0.5) { score -= 20; }
    else if (bundlerRate > 0.3) { score -= 10; }
  }

  // --- POSITIVE: Smart money ---
  if (smartDegens >= 10) { score += 25; }
  else if (smartDegens >= 5) { score += 15; }
  else if (smartDegens >= 2) { score += 5; }

  // --- POSITIVE: Organic score ---
  if (organicScore >= 70) { score += 20; }
  else if (organicScore >= 50) { score += 10; }
  else if (organicScore >= 30) { score += 5; }

  // --- POSITIVE: Clean bundler ---
  if (bundlerRate != null && bundlerRate < 0.1) { score += 15; }
  else if (bundlerRate != null && bundlerRate < 0.3) { score += 5; }

  // --- POSITIVE: Fresh grad momentum ---
  if (isFreshGrad && route === 'pumpportal_graduated') {
    score += 10;
  }

  return Math.max(0, Math.min(150, score));
}

function softScoreThreshold(strat) {
  // Dynamic threshold based on current load
  const baseThreshold = 30; // Default threshold (loosen from 50 — too aggressive)
  
  // Tighten when many positions open
  const openCount = globalOpenPositionCount();
  const maxOpen = strat.max_open_positions || 3;
  
  if (openCount >= maxOpen - 1) return baseThreshold + 10; // Tighten: 60
  if (openCount === 0) return baseThreshold - 10; // Loosen: 40
  return baseThreshold; // Normal: 50
}

function globalOpenPositionCount() {
  // BACKTEST 2026-07-07 (B-4): the old body did require('./positions.js') inside a
  // try/catch. In this ESM project require is undefined AND the path was wrong
  // (positions.js lives in ../db/), so it ALWAYS threw and returned 0 — pinning the
  // soft-score threshold at the loosest branch (20) forever. Now uses a static ESM
  // import so the dynamic tighten-when-full logic actually works.
  try {
    return openPositionCount();
  } catch {
    return 0;
  }
}
export async function buildCandidate({ mint, fee = null, signature = null, graduatedCoin = null, trendingToken = null, trenchesEntry = null, pregradToken = null, route }) {
  const strat = activeStrategy();
  const isFreshlyGraduated = route === 'pumpportal_graduated';

  let gmgn, jupiterAsset, holders, chart, savedWalletExposure, twitterNarrative;

  if (isFreshlyGraduated) {
    console.log(`[candidate] fast path for freshly graduated ${mint.slice(0, 8)}...`);
    const [jupAsset, jupHolders] = await Promise.all([
      fetchJupiterAsset(mint, { ttlMs: JUPITER_ASSET_FRESH_TTL_MS }),
      fetchJupiterHolders(mint),
    ]);
    jupiterAsset = jupAsset;
    holders = jupHolders;
    gmgn = null;
    chart = null;
    twitterNarrative = null;
    savedWalletExposure = await fetchSavedWalletExposure(mint, holders);
  } else {
    // Stage 1: parallel — gmgn, asset, holders, chart (4 calls)
    [gmgn, jupiterAsset, holders, chart] = await Promise.all([
      fetchGmgnTokenInfo(mint),
      fetchJupiterAsset(mint),
      fetchJupiterHolders(mint),
      fetchJupiterChartContext(mint),
    ]);
    // Stage 2: depends on stage 1 — wallet exposure (needs holders) + twitter (needs asset/gmgn)
    [savedWalletExposure, twitterNarrative] = await Promise.all([
      fetchSavedWalletExposure(mint, holders),
      fetchTwitterNarrative(graduatedCoin || jupiterAsset, gmgn),
    ]);
  }
  const priceUsd = firstPositiveNumber(tokenPriceFromGmgn(gmgn), jupiterAsset?.usdPrice, trendingToken?.price, trenchesEntry?.price);
  const marketCapUsd = firstPositiveNumber(
    marketCapFromGmgn(gmgn),
    jupiterAsset?.mcap,
    jupiterAsset?.fdv,
    trendingToken?.market_cap,
    graduatedCoin?.marketCap,
    graduatedCoin?.usd_market_cap,
    trenchesEntry?.market_cap,
    trenchesEntry?.marketCap,
    trenchesEntry?.fdv,
  );
  const signalRoute = route || [
    fee ? 'fee' : null,
    graduatedCoin ? 'graduated' : null,
    pregradToken ? 'pregrad' : null,
    trendingToken ? 'trending' : null,
    trenchesEntry ? 'trenches' : null,
  ].filter(Boolean).join('_');

  const candidate = {
    token: {
      mint,
      name: gmgn?.name || jupiterAsset?.name || trendingToken?.name || graduatedCoin?.name || '',
      symbol: gmgn?.symbol || jupiterAsset?.symbol || trendingToken?.symbol || graduatedCoin?.ticker || '',
      gmgnUrl: gmgn?.link?.gmgn || gmgnLink(mint),
      twitter: graduatedCoin?.twitter || jupiterAsset?.twitter || gmgn?.link?.twitter_username || trendingToken?.twitter || '',
      website: graduatedCoin?.website || jupiterAsset?.website || gmgn?.link?.website || '',
      telegram: graduatedCoin?.telegram || gmgn?.link?.telegram || '',
    },
    metrics: {
      priceUsd,
      marketCapUsd,
      liquidityUsd: Number(gmgn?.liquidity ?? jupiterAsset?.liquidity ?? trendingToken?.liquidity ?? trenchesEntry?.liquidity ?? 0),
      holderCount: Number(gmgn?.holder_count ?? jupiterAsset?.holderCount ?? trendingToken?.holder_count ?? graduatedCoin?.numHolders ?? trenchesEntry?.holder_count ?? trenchesEntry?.holderCount ?? 0),
      gmgnTotalFeesSol: Number(gmgn?.total_fee ?? jupiterAsset?.fees ?? 0),
      gmgnTradeFeesSol: Number(gmgn?.trade_fee ?? 0),
      graduatedVolumeUsd: Number(graduatedCoin?.volume ?? 0),
      graduatedMarketCapUsd: Number(graduatedCoin?.marketCap ?? 0),
      trendingVolumeUsd: Number(trendingToken?.volume ?? trenchesEntry?.volume ?? 0),
      trendingSwaps: Number(trendingToken?.swaps ?? trenchesEntry?.swaps ?? 0),
      trendingHotLevel: Number(trendingToken?.hot_level ?? trenchesEntry?.hot_level ?? 0),
      trendingSmartDegenCount: Number(trendingToken?.smart_degen_count ?? trenchesEntry?.smart_degen_count ?? 0),
      pregradRssrSol: Number(pregradToken?.real_sol_reserves_sol ?? 0),
      pregradRssrPctToGrad: Number(pregradToken?.rssr_pct_to_grad ?? 0),
      pregradReplyCount: Number(pregradToken?.reply_count ?? 0),
    },
    signals: {
      route: signalRoute,
      label: signalLabel({
        hasFeeClaim: Boolean(fee),
        hasGraduated: Boolean(graduatedCoin),
        hasTrending: Boolean(trendingToken || trenchesEntry),
      }),
      hasFeeClaim: Boolean(fee),
      hasGraduated: Boolean(graduatedCoin),
      hasTrending: Boolean(trendingToken || trenchesEntry),
      triggerSignature: signature,
      strategy: strat.id,
    },
    graduation: graduatedCoin,
    trending: trendingToken,
    trenchesEntry,
    feeClaim: fee ? buildFeeSnapshot(fee, signature) : null,
    gmgn,
    jupiterAsset,
    holders,
    chart,
    savedWalletExposure,
    twitterNarrative,
    createdAtMs: now(),
  };
  candidate.filters = filterCandidate(candidate);
  return candidate;
}
