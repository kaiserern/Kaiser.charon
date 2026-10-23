import { updateCandidateSnapshot } from '../db/candidates.js';
import { paperAudit } from '../db/paperAudit.js';
import { now, pruneSeen } from '../utils.js';
import { numSetting, boolSetting } from '../db/settings.js';
import { db } from '../db/connection.js';
import { upsertCandidate, updateCandidateStatus, recentEligibleCandidates, candidateById } from '../db/candidates.js';
import { storeDecision, storeBatchDecision, logDecisionEvent, checkDecisionCache } from '../db/decisions.js';
import { buildCandidate, filterCandidate, signalLabel } from './candidateBuilder.js';
import { preScoreCandidate } from './preScorer.js';
import { momentumFilter } from './momentumFilter.js';
import { decideCandidateBatch } from './llm.js';
import { activeStrategy } from '../db/settings.js';
import { createDryRunPosition, createLivePosition, canOpenMorePositions, openPositionCount, tradingMode } from '../db/positions.js';
import { sendBatchReveal, sendTelegram, sendPositionOpen, sendTradeIntent } from '../telegram/send.js';
import { candidateSummary } from '../telegram/format.js';
import { createTradeIntent } from '../db/intents.js';
import { refreshCandidateForExecution } from '../execution/positions.js';
import { executeLiveBuy } from '../execution/router.js';
import { graduated } from '../signals/graduated.js';
import { setDegenHandler } from '../signals/trending.js';
import { setCandidateHandler } from '../signals/feeClaim.js';
import { short } from '../format.js';
import { escapeHtml } from '../format.js';

export const seenSignalCandidates = new Map();

// Expected, self-healing entry rejections raised by the paper/logic gates. These are
// logged and reported quietly; anything else is a genuine fault and keeps the alarm.
const EXPECTED_ENTRY_REJECTIONS = new Set([
  'reference_quote_missing_or_stale',
  'fill_quote_missing_or_stale',
  'slippage_exceeds_3_percent',
  'missing_token_decimals',
  'missing_sol_usd_price',
  'paper_mode_or_position_limit_changed',
]);

setDegenHandler(maybeProcessDegenCandidate);
setCandidateHandler(processCandidateFromSignals);

export async function processCandidateFromSignals(signals) {
  // Skip if max positions reached — don't waste enrichment/LLM calls
  if (!canOpenMorePositions()) {
    const max = numSetting('max_open_positions', 3);
    console.log(`[agent] max positions reached (${openPositionCount()}/${max}), skipping ${signals.mint.slice(0, 8)}...`);
    return;
  }

  // Load strategy early — needed for duplicate checks below
  const strat = activeStrategy();

  // DUPLICATE CHECKS — all run BEFORE enrichment to save API calls
  try {
    const recentMs = Date.now() - 86400000; // 24 hours

    // 1. Open position exists
    const openPos = db.prepare(
      'SELECT id FROM dry_run_positions WHERE mint = ? AND status = ? LIMIT 1'
    ).get(signals.mint, 'open');
    if (openPos) {
      console.log(`[agent] skipping ${signals.mint.slice(0, 8)}... — already has open position`);
      return;
    }

    // 2. Recently closed position (<24h) — BUG #3 FIX: extend to 72h to prevent re-buy after SL
    const closedPos = db.prepare(
      'SELECT id, exit_reason, closed_at_ms FROM dry_run_positions WHERE mint = ? AND status = ? AND closed_at_ms > ? ORDER BY closed_at_ms DESC LIMIT 1'
    ).get(signals.mint, 'closed', Date.now() - 72 * 60 * 60 * 1000);
    if (closedPos) {
      const hoursAgo = ((Date.now() - closedPos.closed_at_ms) / 3600000).toFixed(1);
      console.log(`[agent] skipping ${signals.mint.slice(0, 8)}... — recently closed (${hoursAgo}h ago, exit: ${closedPos.exit_reason})`);
      return;
    }

    // 3. LLM decision cache — only relevant when strategy uses LLM
    if (strat.use_llm) {
      const recentDecision = db.prepare(`
        SELECT id FROM llm_decisions
        WHERE mint = ? AND created_at_ms > ?
        LIMIT 1
      `).get(signals.mint, recentMs);
      if (recentDecision) {
        console.log(`[agent] skipping ${signals.mint.slice(0, 8)}... — LLM decision exists (<24h)`);
        return;
      }
    }
  } catch (err) {
    // DB check failed — proceed anyway
  }

  // Bidirectional dedup — skip ANY route if this mint already has a recent candidate entry within 10 minutes
  // (prevents same token processed via pumpportal_graduated, pumpfun_pregrad, fee_trending, dual_source, etc. simultaneously)
  try {
    const recentCandidate = db.prepare(`
      SELECT id FROM candidates
      WHERE mint = ? AND created_at_ms > ?
      LIMIT 1
    `).get(signals.mint, Date.now() - 600000); // 10 minutes
    if (recentCandidate) {
      console.log(`[agent] skipping ${signals.mint.slice(0, 8)}... — recent candidate (<10min) for any route`);
      return;
    }
  } catch (err) {
    // DB check failed — proceed anyway
  }

  // FIX #1: Check decision cache BEFORE expensive buildCandidate() API calls
  // Lightweight check with just mint — full enrichment happens only if cache miss
  const cachedDecision = checkDecisionCache(signals.mint);
  if (cachedDecision) {
    const ageMin = ((now() - cachedDecision.cachedAt) / 60000).toFixed(1);
    console.log(`[cache-hit] ${signals.mint.slice(0, 8)}... — verdict ${cachedDecision.verdict} (cached ${ageMin}m ago, reason: ${cachedDecision.reason?.slice(0, 60) || 'n/a'})`);
    return;
  }

  const candidate = await buildCandidate(signals);
  const signature = signals.signature || null;
  const candidateId = upsertCandidate(candidate, signature);

  // Symbol-based dedup — skip copycat tokens with same symbol traded in last 24h
  try {
    const symbol = candidate.token?.symbol;
    if (symbol) {
      const symbolPos = db.prepare(
        'SELECT id FROM dry_run_positions WHERE symbol = ? AND closed_at_ms > ? LIMIT 1'
      ).get(symbol, Date.now() - 86400000);
      if (symbolPos) {
        console.log(`[agent] skipping ${symbol} (${candidate.token.mint.slice(0, 8)}) — same symbol traded <24h ago`);
        return;
      }
    }
  } catch (err) {
    // DB check failed — proceed anyway
  }

  if (!candidate.filters.passed) {
    console.log(`[candidate] filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }

  // Pre-score: rule-based check before LLM (saves LLM credits)
  const preScore = preScoreCandidate(candidate);
  if (!preScore.passed) {
    console.log(`[prescore] filtered ${candidate.token.mint.slice(0, 8)}... score ${preScore.score}/${preScore.threshold} (${preScore.reasons.slice(0, 2).join('; ')})`);
    return;
  }
  console.log(`[prescore] passed ${candidate.token.mint.slice(0, 8)}... score ${preScore.score}/${preScore.threshold}`);
  
  // FIX #2: Re-check filters BEFORE LLM call (prevent wasted LLM calls on stale data)
  // This catches cases where market conditions changed between initial filter and LLM batch eval
  filterCandidate(candidate);
  if (!candidate.filters.passed) {
    console.log(`[pre-llm-guard] filtered ${candidate.token.mint.slice(0, 8)}... ${candidate.filters.failures.join('; ')}`);
    return;
  }

  // Momentum filter — ML-based prediction of runner vs sideways
  const momentumThreshold = strat.momentum_threshold ?? 0.5;
  const momentumResult = await momentumFilter(candidate, momentumThreshold);
  if (!momentumResult.passed) {
    candidate.filters.passed = false;
    candidate.filters.failures.push(`momentum: ${momentumResult.reason || 'score_below_threshold'} (${momentumResult.score})`);
    paperAudit(candidate.token.mint, 'momentum_rejected', { candidateId, reason: momentumResult.reason || 'score_below_threshold', score: momentumResult.score, threshold: momentumThreshold });
    updateCandidateSnapshot(candidateId, candidate, 'filtered');
    candidate.filters.momentumScore = momentumResult.score;
    console.log(`[momentum] filtered ${candidate.token.mint.slice(0, 8)}... score ${momentumResult.score} < ${momentumThreshold}`);
    return;
  }
  candidate.filters.momentumScore = momentumResult.score;

  let rows, batchDecision, batchId;

  if (!strat.use_llm) {
    const selfRow = candidateById(candidateId);
    rows = selfRow ? [selfRow] : [];
    batchId = null;
    batchDecision = {
      verdict: 'BUY',
      confidence: 100,
      selected_candidate_id: candidateId,
      selected_mint: candidate.token.mint,
      selected_row: selfRow,
      reason: `Strategy '${strat.id}' is rule-based (use_llm: false); filters passed.`,
      risks: [],
      suggested_tp_percent: strat.tp_percent ?? numSetting('default_tp_percent', 50),
      suggested_sl_percent: strat.sl_percent ?? numSetting('default_sl_percent', -25),
      raw: null,
    };
  } else {
    rows = recentEligibleCandidates(numSetting('llm_candidate_pick_count', 10));
    batchDecision = await decideCandidateBatch(rows, candidateId);
    batchId = storeBatchDecision(candidateId, rows, batchDecision);
  }
  const selectedRow = batchDecision.selected_row;
  const selectedThisCandidate = selectedRow?.id === candidateId;
  const currentDecision = selectedThisCandidate
    ? batchDecision
    : {
        ...batchDecision,
        verdict: 'WATCH',
        reason: selectedRow
          ? `Batch #${batchId} screened ${rows.length}; selected ${short(selectedRow.candidate.token.mint)} instead. ${batchDecision.reason || ''}`.trim()
          : `Batch #${batchId} screened ${rows.length}; no buy selected. ${batchDecision.reason || ''}`.trim(),
      };
  const currentDecisionId = storeDecision(candidateId, candidate, currentDecision);
  currentDecision.id = currentDecisionId;
  updateCandidateStatus(candidateId, currentDecision.verdict.toLowerCase());

  if (selectedRow && !selectedThisCandidate) {
    const selectedDecisionId = storeDecision(selectedRow.id, selectedRow.candidate, batchDecision);
    batchDecision.id = selectedDecisionId;
    updateCandidateStatus(selectedRow.id, batchDecision.verdict.toLowerCase());
  } else if (selectedThisCandidate) {
    batchDecision.id = currentDecisionId;
  }

  if (batchId) await sendBatchReveal(batchId, rows, batchDecision, candidateId);

  // #6: Buy the LLM's selected candidate regardless of which candidate triggered the batch
  if (selectedRow && boolSetting('agent_enabled', true) && batchDecision.verdict === 'BUY' && batchDecision.confidence >= numSetting('llm_min_confidence')) {
    if (!canOpenMorePositions()) {
      const max = numSetting('max_open_positions', 3);
      console.log(`[agent] max open positions reached (${openPositionCount()}/${max}), skipping buy ${selectedRow.candidate.token.mint}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'entry_skipped_max_positions',
        guardrails: { maxOpenPositions: max, openPositions: openPositionCount() },
      });
      return;
    }
    try {
      await handleApprovedBuy(selectedRow, batchDecision, batchId, rows, candidateId);
    } catch (err) {
      console.error(`[orchestrator] handleApprovedBuy failed for ${selectedRow.candidate.token.mint}: ${err.message}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId: candidateId,
        selectedRow,
        rows,
        decision: batchDecision,
        action: 'handle_buy_error',
        guardrails: { error: err.message, stack: err.stack?.slice(0, 500) },
      });
      await sendTelegram([
        '🛑 <b>Buy execution failed</b>',
        '',
        candidateSummary(selectedRow.candidate, batchDecision),
        '',
        `Error: ${escapeHtml(err.message)}`,
      ].join('\n'));
    }
  } else {
    logDecisionEvent({
      batchId,
      triggerCandidateId: candidateId,
      selectedRow,
      rows,
      decision: batchDecision,
      action: selectedRow ? 'entry_not_approved' : 'no_candidate_selected',
      guardrails: {
        agentEnabled: boolSetting('agent_enabled', true),
        confidenceThreshold: numSetting('llm_min_confidence'),
        openPositions: openPositionCount(),
        maxOpenPositions: numSetting('max_open_positions', 3),
      },
    });
  }
}

export async function handleApprovedBuy(selectedRow, decision, batchId, rows = [], triggerCandidateId = null) {
  const mode = tradingMode();
  const refreshStartedAt = now();
  let freshSelectedRow;
  try {
    freshSelectedRow = await refreshCandidateForExecution(selectedRow);
  } catch (err) {
    console.error(`[execution-refresh] rejected ${selectedRow.mint || selectedRow.candidate?.token?.mint || 'unknown'}: ${err.message}`);
    updateCandidateStatus(selectedRow.id, 'stale_rejected');
    logDecisionEvent({ batchId, triggerCandidateId, selectedRow, rows, decision, mode,
      action: 'entry_rejected_refresh', guardrails: { error: err.message, refreshLatencyMs: now() - refreshStartedAt } });
    return;
  }
  console.log(`[execution-refresh] ${freshSelectedRow.candidate.token.mint.slice(0, 8)} ${now() - refreshStartedAt}ms passed=${Boolean(freshSelectedRow.candidate.filters?.passed)}`);
  const executionRows = rows.map(row => row.id === freshSelectedRow.id ? freshSelectedRow : row);
  if (!freshSelectedRow.candidate.filters?.passed) {
    updateCandidateStatus(freshSelectedRow.id, 'stale_rejected');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'entry_rejected_fresh_filters',
      guardrails: {
        failures: freshSelectedRow.candidate.filters?.failures || [],
        refreshedAtMs: freshSelectedRow.candidate.executionRefresh?.refreshedAtMs,
      },
    });
    await sendTelegram([
      '🛑 <b>Execution rejected on fresh check</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Failures: ${escapeHtml((freshSelectedRow.candidate.filters?.failures || []).join('; ') || 'fresh execution guard failed')}`,
    ].join('\n'));
    return;
  }

  if (mode === 'dry_run') {
    // FIX #3: Wrap position creation in try-catch to capture execution failures
    let positionId, isNew, pastWinPnlSol, pastWinClosedAtMs;
    try {
      const result = await createDryRunPosition(freshSelectedRow.id, freshSelectedRow.candidate, decision, `llm_batch_${batchId}`);
      positionId = result.id;
      isNew = result.isNew;
      pastWinPnlSol = result.pastWinPnlSol;
      pastWinClosedAtMs = result.pastWinClosedAtMs;
    } catch (err) {
      const detail = err.detail || {};
      const gateRejection = EXPECTED_ENTRY_REJECTIONS.has(err.message);
      if (gateRejection) console.log(`[orchestrator] entry skipped for ${freshSelectedRow.candidate.token.mint}: ${err.message}${detail.driftPct != null ? ` (drift ${detail.driftPct}%)` : ''}`);
      else console.error(`[orchestrator] createDryRunPosition failed for ${freshSelectedRow.candidate.token.mint}: ${err.message}`);
      logDecisionEvent({
        batchId,
        triggerCandidateId,
        selectedRow: freshSelectedRow,
        rows: executionRows,
        decision,
        mode,
        action: 'dry_run_position_create_failed',
        guardrails: {
          maxOpenPositions: numSetting('max_open_positions', 3),
          openPositions: openPositionCount(),
        },
        execution: { 
          error: err.message,
          ...detail,
          stack: gateRejection ? undefined : err.stack?.slice(0, 500),
        },
      });
      // A safety gate doing its job is not an incident: paging with a red siren for
      // every quote-gated entry buried the real failures (that alert class fired
      // 185x/day). Gates get one quiet line, real faults keep the alarm.
      await sendTelegram([
        gateRejection ? '⊘ <b>Entry skipped</b> — safety gate' : '🛑 <b>Position creation failed</b>',
        '',
        candidateSummary(freshSelectedRow.candidate, decision),
        '',
        `${gateRejection ? 'Gate' : 'Error'}: ${escapeHtml(err.message)}${detail.driftPct != null ? ` (ref→fill ${detail.driftPct}%)` : ''}`,
      ].join('\n'));
      return;
    }
    
    // FIX #4: Enhanced past-win guard logging with context
    const guardrails = {
      maxOpenPositions: numSetting('max_open_positions', 3),
      openPositions: openPositionCount(),
      pastWinPnlSol: pastWinPnlSol ?? null,
      pastWinClosedAtMs: pastWinClosedAtMs ?? null,
    };
    
    if (!isNew && pastWinClosedAtMs) {
      // Fetch past position details for audit
      try {
        const pastPos = db.prepare(`
          SELECT exit_reason, opened_at_ms, closed_at_ms, entry_mcap, pnl_percent 
          FROM dry_run_positions 
          WHERE mint = ? AND closed_at_ms = ?
          LIMIT 1
        `).get(freshSelectedRow.candidate.token.mint, pastWinClosedAtMs);
        
        if (pastPos) {
          const holdDurationMin = ((pastPos.closed_at_ms - pastPos.opened_at_ms) / 60000).toFixed(1);
          const currentMcap = freshSelectedRow.candidate.metrics?.marketCapUsd || 0;
          guardrails.pastWinExitReason = pastPos.exit_reason;
          guardrails.pastWinHoldDurationMin = Number(holdDurationMin);
          guardrails.pastWinPnlPercent = pastPos.pnl_percent;
          guardrails.wouldHaveBeenProfit = currentMcap > (pastPos.entry_mcap || 0);
        }
      } catch (err) {
        // Past position lookup failed — proceed with basic guardrails
      }
    }
    
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: isNew ? 'dry_run_entry' : 'dry_run_blocked_past_win',
      guardrails,
      execution: { positionId, isNew },
    });
    if (isNew) {
      await sendPositionOpen(positionId);
    } else {
      const daysAgo = Math.max(0, Math.floor((now() - (pastWinClosedAtMs || now())) / 86400000));
      await sendTelegram(`⏸️ Re-entry blocked: ${escapeHtml(freshSelectedRow.candidate.token.symbol)} won +${pastWinPnlSol ?? '?'} SOL ${daysAgo}d ago — guard prevented new position`);
    }
    return;
  }

  if (mode === 'confirm') {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'pending_confirmation');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'confirm_intent_created',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId },
    });
    await sendTradeIntent(intentId, freshSelectedRow.candidate, decision);
    return;
  }

  try {
    await executeLiveBuy(freshSelectedRow, decision, batchId, executionRows, triggerCandidateId);
  } catch (err) {
    const intentId = createTradeIntent(freshSelectedRow.id, freshSelectedRow.candidate, decision, mode, 'execution_failed');
    logDecisionEvent({
      batchId,
      triggerCandidateId,
      selectedRow: freshSelectedRow,
      rows: executionRows,
      decision,
      mode,
      action: 'live_entry_failed',
      guardrails: { maxOpenPositions: numSetting('max_open_positions', 3), openPositions: openPositionCount() },
      execution: { intentId, error: err.message },
    });
    await sendTelegram([
      '🛑 <b>Live trade failed</b>',
      '',
      candidateSummary(freshSelectedRow.candidate, decision),
      '',
      `Intent #${intentId} stored.`,
      `Error: ${escapeHtml(err.message)}`,
    ].join('\n'));
  }
}

export async function maybeProcessDegenCandidate(mint, trendingToken) {
  if (!boolSetting('trending_allow_degen', false)) return;
  const graduatedCoin = graduated.get(mint);
  if (!graduatedCoin) return;
  pruneSeen(seenSignalCandidates, 10 * 60 * 1000);
  const bucket = Math.floor(now() / (5 * 60 * 1000));
  const key = `graduated_trending:${mint}:${bucket}`;
  if (seenSignalCandidates.has(key)) return;
  seenSignalCandidates.set(key, now());
  await processCandidateFromSignals({
    mint,
    graduatedCoin,
    trendingToken,
    route: 'graduated_trending',
  });
}
