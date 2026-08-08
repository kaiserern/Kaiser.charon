import { now, json } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { WSOL_MINT, LIVE_MIN_SOL_RESERVE_LAMPORTS } from '../config.js';
import { escapeHtml, fmtSol } from '../format.js';
import { executeJupiterSwap, liveWalletBalanceLamports, fetchLiveTokenBalance } from '../liveExecutor.js';
import { activeStrategy } from '../db/settings.js';
import { createLivePosition, canOpenMorePositions, openPositionCount, checkEntryGuards } from '../db/positions.js';
import { intentById } from '../db/intents.js';
import { logDecisionEvent } from '../db/decisions.js';
import { refreshCandidateForExecution } from './positions.js';
import { bot } from '../telegram/bot.js';
import { candidateSummary } from '../telegram/format.js';
import { sendPositionOpen, sendTelegram } from '../telegram/send.js';
import { updateCandidateStatus } from '../db/candidates.js';
import { createTradeIntent } from '../db/intents.js';

const ENTRY_MAX_ATTEMPTS = 3;

// Single-writer entry lock: serializes check->swap->insert for ALL live entries so two
// concurrent signal sources cannot both pass max-positions / dedup and both swap.
// ponytail: in-process mutex; charon is a single Node process. Cross-process durability
// (entry_pending DB row + deterministic on-chain sig confirm) is the Phase 2 hardening.
let entryChain = Promise.resolve();
function withEntryLock(fn) {
  const run = entryChain.then(fn, fn);
  entryChain = run.catch(() => {});
  return run;
}

export async function executeLiveBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  return withEntryLock(async () => {
    // Pre-swap guard: never spend SOL if dedup or max-positions would reject the entry.
    const guard = checkEntryGuards(selectedRow.candidate.token.mint);
    if (!guard.allowed) {
      const msg = `Entry blocked pre-swap: ${guard.reason}${guard.blockedById ? ` (#${guard.blockedById})` : ''}`;
      console.log(`[executeLiveBuy] ${msg}`);
      throw new Error(msg);
    }
    const strat = activeStrategy();
    const amountLamports = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
    const balance = await liveWalletBalanceLamports();
    if (balance < amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
      throw new Error(`Insufficient SOL balance. Need ${fmtSol((amountLamports + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL including reserve.`);
    }
    const candidate = selectedRow.candidate;
    let swap = null;
    let lastError = null;
    for (let attempt = 1; attempt <= ENTRY_MAX_ATTEMPTS; attempt++) {
      // O2 reconcile: before each retry, check if a prior attempt actually landed on-chain.
      // If tokens are in the wallet, treat it as success instead of firing another buy order.
      if (attempt > 1) {
        const alreadyBought = await fetchLiveTokenBalance(candidate.token.mint);
        if (Number(alreadyBought) > 0) {
          swap = { order: null, executed: null, signature: null, inputAmount: String(amountLamports), outputAmount: String(alreadyBought), reconciled: true };
          console.log(`[executeLiveBuy] attempt ${attempt} skipped — prior tx landed, ${alreadyBought} tokens reconciled`);
          lastError = null;
          break;
        }
      }
      try {
        swap = await executeJupiterSwap({
          inputMint: WSOL_MINT,
          outputMint: candidate.token.mint,
          amount: amountLamports,
        });
        if (!swap.outputAmount) {
          swap.outputAmount = await fetchLiveTokenBalance(candidate.token.mint) || swap.outputAmount;
        }
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        console.log(`[executeLiveBuy] attempt ${attempt}/${ENTRY_MAX_ATTEMPTS} failed for ${candidate.token.mint.slice(0, 8)}... ${err.message}`);
        if (attempt < ENTRY_MAX_ATTEMPTS) {
          await new Promise(r => setTimeout(r, 1500 * attempt));
        }
      }
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
      `).run(positionId, candidate.token.mint, now(), null, null, numSetting('dry_run_buy_sol', 0.1), null, 'FAILED_ENTRY',
        json({ attempts: ENTRY_MAX_ATTEMPTS, error: lastError?.message || 'unknown', reconciledBalance: await fetchLiveTokenBalance(candidate.token.mint) }));
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
  });
}

export async function executeLiveSell(position, reason) {
  const amount = position.token_amount_raw || position.token_amount_est;
  if (!amount || Number(amount) <= 0) throw new Error('Live position has no token amount to sell.');
  return executeJupiterSwap({
    inputMint: position.mint,
    outputMint: WSOL_MINT,
    amount,
  });
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
    // O1: swap+insert under the entry lock with an authoritative pre-swap guard, so the
    // confirm path can't bypass max-positions / dedup the way it did when it swapped first.
    // createLivePosition MUST stay inside the lock: releasing after swap-but-before insert
    // would let a concurrent entry pass checkEntryGuards and duplicate-swap.
    const result = await withEntryLock(async () => {
      const guard = checkEntryGuards(freshRow.candidate.token.mint);
      if (!guard.allowed) {
        throw new Error(`Entry blocked pre-swap: ${guard.reason}${guard.blockedById ? ` (#${guard.blockedById})` : ''}`);
      }
      const strat = activeStrategy();
      const amt = Math.floor((strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1)) * 1_000_000_000);
      const bal = await liveWalletBalanceLamports();
      if (bal < amt + LIVE_MIN_SOL_RESERVE_LAMPORTS) {
        throw new Error(`Insufficient SOL balance. Need ${fmtSol((amt + LIVE_MIN_SOL_RESERVE_LAMPORTS) / 1_000_000_000)} SOL.`);
      }
      const s = await executeJupiterSwap({
        inputMint: WSOL_MINT,
        outputMint: freshRow.candidate.token.mint,
        amount: amt,
      });
      if (!s.outputAmount) {
        s.outputAmount = await fetchLiveTokenBalance(freshRow.candidate.token.mint) || s.outputAmount;
      }
      const { id: positionId, isNew } = createLivePosition(intent.candidate_id, freshRow.candidate, decision, s, `confirmed_intent_${intentId}`);
      return { positionId, isNew, swap: s, balance: bal, amountLamports: amt };
    });
    db.prepare('UPDATE trade_intents SET status = ?, updated_at_ms = ? WHERE id = ?').run('executed_live', now(), intentId);
    logDecisionEvent({
      batchId: null,
      triggerCandidateId: intent.candidate_id,
      selectedRow: freshRow,
      rows: [],
      decision,
      mode: 'live',
      action: 'confirmed_intent_executed',
      guardrails: { balanceLamports: result.balance, amountLamports: result.amountLamports, intentId },
      execution: { positionId: result.positionId, isNew: result.isNew, swap: result.swap },
    });
    if (result.isNew) return sendPositionOpen(result.positionId);
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
