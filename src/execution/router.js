import { now, json } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { WSOL_MINT, LIVE_MIN_SOL_RESERVE_LAMPORTS, ENTRY_FRESHNESS_GATE_PCT, ENTRY_FRESHNESS_GATE_SHADOW } from '../config.js';
import { escapeHtml, fmtSol } from '../format.js';
import { executeJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance, closeEmptyTokenAccounts } from '../liveExecutor.js';
import { activeStrategy } from '../db/settings.js';
import { createLivePosition, canOpenMorePositions, openPositionCount } from '../db/positions.js';
import { intentById } from '../db/intents.js';
import { logDecisionEvent } from '../db/decisions.js';
import { refreshCandidateForExecution } from './positions.js';
import { bot } from '../telegram/bot.js';
import { candidateSummary } from '../telegram/format.js';
import { sendPositionOpen, sendTelegram } from '../telegram/send.js';
import { updateCandidateStatus } from '../db/candidates.js';
import { createTradeIntent } from '../db/intents.js';

const ENTRY_MAX_ATTEMPTS = 3;

// Freshness gate: bandingkan harga sinyal (candidate.metrics.priceUsd) dengan harga fill dari
// quote Jupiter (order.inUsdValue / (order.outAmount / 10^decimals)). Kalau drift > ENTRY_FRESHNESS_GATE_PCT%
// BUY dibatalkan SEBELUM sign/broadcast (return early, alasan 'stale_signal'), route TIDAK di-disable.
// Return null kalau gate nonaktif atau data tidak cukup (fail-open: jangan blokir trade tanpa data).
function entryFreshnessGuard(candidate) {
  const threshold = Number(ENTRY_FRESHNESS_GATE_PCT);
  if (!Number.isFinite(threshold) || threshold <= 0) return null; // gate nonaktif
  const signalPrice = Number(candidate?.metrics?.priceUsd);
  if (!Number.isFinite(signalPrice) || signalPrice <= 0) return null; // tak ada harga sinyal
  const decimals = Number(candidate?.jupiterAsset?.decimals ?? 9);
  return (order) => {
    const inUsd = Number(order?.inUsdValue);
    const outRaw = Number(order?.outAmount);
    if (!Number.isFinite(inUsd) || inUsd <= 0 || !Number.isFinite(outRaw) || outRaw <= 0) return null;
    const tokensOut = outRaw / (10 ** decimals);
    if (!(tokensOut > 0)) return null;
    const fillPrice = inUsd / tokensOut;
    const driftPct = (fillPrice / signalPrice - 1) * 100;
    if (driftPct > threshold) {
      const reason = `stale_signal: drift ${driftPct.toFixed(2)}% > gate ${threshold}% (signal $${signalPrice} -> fill $${fillPrice})`;
      if (ENTRY_FRESHNESS_GATE_SHADOW) {
        console.log(`[freshness-gate][shadow] ${candidate?.token?.mint?.slice(0, 8)}... ${reason}`);
        return null; // shadow: catat saja, jangan blokir
      }
      return reason;
    }
    return null;
  };
}

export async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const strat = activeStrategy();
  const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
  const balance = await liveWalletBalanceLamports();
  if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
    throw new Error(`Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
  }
  const candidate = selectedRow.candidate;

  // C2 FIX: Dedup BEFORE swap — prevent double-spend if same mint already has open position
  const existingOpen = db.prepare(
    'SELECT id FROM dry_run_positions WHERE mint = ? AND status = ? LIMIT 1'
  ).get(candidate.token.mint, 'open');
  if (existingOpen) {
    const err = new Error(`Duplicate entry blocked: ${candidate.token.symbol || candidate.token.mint.slice(0, 8)} already has open position #${existingOpen.id}`);
    console.log(`[executeLiveBuy] ${err.message}`);
    logDecisionEvent({
      batchId, triggerCandidateId, selectedRow, rows, decision,
      mode: 'live', action: 'live_entry_blocked_duplicate',
      guardrails: { existingPositionId: existingOpen.id },
      execution: { error: err.message },
    });
    throw err;
  }

  let swap = null;
  let lastError = null;
  let staleSignal = null;
  for (let attempt = 1; attempt <= ENTRY_MAX_ATTEMPTS; attempt++) {
    try {
      swap = await executeJupiterSwap({
        inputMint: WSOL_MINT,
        outputMint: candidate.token.mint,
        amount: amountLamports,
        guard: entryFreshnessGuard(candidate),
      });
      if (!swap.outputAmount) {
        swap.outputAmount = await fetchLiveTokenBalance(candidate.token.mint) || swap.outputAmount;
      }
      lastError = null;
      break;
    } catch (err) {
      if (err.code === 'STALE_SIGNAL_GUARD') {
        staleSignal = err; // harga sinyal basi — jangan retry, harga akan makin jauh
        break;
      }
      lastError = err;
      console.log(`[executeLiveBuy] attempt ${attempt}/${ENTRY_MAX_ATTEMPTS} failed for ${candidate.token.mint.slice(0, 8)}... ${err.message}`);
      if (attempt < ENTRY_MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
  }
  if (!swap && staleSignal) {
    // Freshness gate: skip trade. Tidak ada posisi dibuat, tidak ada dana terpakai,
    // route tetap aktif untuk token berikutnya.
    const msg = staleSignal.message;
    console.log(`[executeLiveBuy] SKIP ${candidate.token.mint.slice(0, 8)}... ${msg}`);
    updateCandidateStatus(selectedRow.id, 'stale_signal');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow,
      rows,
      decision,
      mode: 'live',
      action: 'live_entry_skipped_stale_signal',
      guardrails: { freshnessGatePct: ENTRY_FRESHNESS_GATE_PCT, signalPriceUsd: Number(candidate?.metrics?.priceUsd) },
      execution: { reason: 'stale_signal', detail: msg },
    });
    await sendTelegram([
      '⏭️ <b>Live entry skipped (stale signal)</b>',
      '',
      candidateSummary(candidate, decision),
      '',
      escapeHtml(msg),
    ].join('\n'));
    return;
  }
  if (!swap) {
    // Record the failed attempt as a closed position so the failure is auditable.
    const failedSwap = { signature: null, outputAmount: null, error: lastError?.message || 'unknown' };
    const { id: positionId } = createLivePosition(selectedRow.id, candidate, decision, failedSwap, 'FAILED_ENTRY');
    db.prepare(`
      UPDATE dry_run_positions
      SET status = 'closed', closed_at_ms = ?, exit_reason = 'FAILED_ENTRY', pnl_percent = 0, pnl_sol = 0
      WHERE id = ?
    `).run(now(), positionId);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, 'FAILED_ENTRY', ?)
    `).run(positionId, candidate.token.mint, now(), null, null, numSetting('dry_run_buy_sol', 0.1), null,
      json({ attempts: ENTRY_MAX_ATTEMPTS, error: lastError?.message || 'unknown' }));
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow,
      rows,
      decision,
      mode: 'live',
      action: 'live_entry_failed',
      guardrails: { balanceLamports: balance, amountLamports, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS, attempts: ENTRY_MAX_ATTEMPTS },
      execution: { positionId, error: lastError?.message || 'unknown' },
    });
    await sendTelegram([
      '🛑 <b>Live entry failed after retries</b>',
      '',
      candidateSummary(candidate, decision),
      '',
      `Attempts: ${ENTRY_MAX_ATTEMPTS}`,
      `Error: ${escapeHtml(lastError?.message || 'unknown')}`,
      `Position #${positionId} recorded as FAILED_ENTRY.`,
    ].join('\n'));
    throw lastError || new Error('Live buy failed without exception');
  }
  const { id: positionId, isNew } = createLivePosition(selectedRow.id, candidate, decision, swap, `live_batch_${batchId}`);
  logDecisionEvent({
    batchId,
    triggerCandidateId,
    selectedRow,
    rows,
    decision,
    mode: 'live',
    action: 'live_entry_executed',
    guardrails: { balanceLamports: balance, amountLamports, minReserveLamports: LIVE_MIN_SOL_RESERVE_LAMPORTS },
    execution: { positionId, isNew, swap },
  });
  if (isNew) await sendPositionOpen(positionId);
}

export async function executeLiveSell(position, reason) {
  const amount = position.token_amount_raw || position.token_amount_est;
  if (!amount || Number(amount) <= 0) throw new Error('Live position has no token amount to sell.');
  const sell = await executeJupiterSwap({
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amount,
  });
  try {
    sell.closeAccountSignature = await closeEmptyTokenAccounts(position.mint);
  } catch (err) {
    // Rent cleanup must never turn a successful sell into a failed position close.
    console.log(`[live] close empty token account ${position.mint.slice(0, 8)}... ${err.message}`);
  }
  return sell;
}

export async function executeConfirmedIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent || intent.status !== 'pending_confirmation') return bot.sendMessage(chatId, 'Pending intent not found.');
  if (!canOpenMorePositions()) {
    return bot.sendMessage(chatId, `Max open positions reached (${openPositionCount()}/${numSetting('max_open_positions', 3)}).`);
  }
  const { decision } = intent.payload;
  try {
    const freshRow = await refreshCandidateForExecution({
      id: intent.candidate_id,
      candidate: intent.payload.candidate,
    });
    if (!freshRow.candidate.filters?.passed) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_stale', now(), intentId);
      return bot.sendMessage(chatId, [
        '🛑 <b>Trade intent rejected on fresh check</b>',
        '',
        candidateSummary(freshRow.candidate, decision),
        '',
        `Failures: ${escapeHtml((freshRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
      ].join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    }
    const strat = activeStrategy();
    const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
    const balance = await liveWalletBalanceLamports();
    if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
      db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected_insufficient_balance', now(), intentId);
      return bot.sendMessage(chatId, `Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL.`, { parse_mode: 'HTML' });
    }
    const swap = await executeJupiterSwap({
      inputMint: WSOL_MINT,
      outputMint: freshRow.candidate.token.mint,
      amount: amountLamports,
    });
    if (!swap.outputAmount) {
      swap.outputAmount = await fetchLiveTokenBalance(freshRow.candidate.token.mint) || swap.outputAmount;
    }
    const { id: positionId, isNew } = createLivePosition(intent.candidate_id, freshRow.candidate, decision, swap, `confirmed_intent_${intentId}`);
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('executed_live', now(), intentId);
    logDecisionEvent({
      batchId: null,
      triggerCandidateId: intent.candidate_id,
      selectedRow: freshRow,
      rows: [],
      decision,
      mode: 'live',
      action: 'confirmed_intent_executed',
      guardrails: { balanceLamports: balance, amountLamports, intentId },
      execution: { positionId, isNew, swap },
    });
    if (isNew) return sendPositionOpen(positionId);
  } catch (err) {
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('execution_failed', now(), intentId);
    return bot.sendMessage(chatId, `Live execution failed: ${escapeHtml(err.message)}`, { parse_mode: 'HTML' });
  }
}

export async function rejectIntent(chatId, intentId) {
  const intent = intentById(intentId);
  if (!intent) return bot.sendMessage(chatId, 'Intent not found.');
  db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('rejected', now(), intentId);
  return bot.sendMessage(chatId, `Rejected trade intent #${intentId}.`);
}
