import { db } from './connection.js';
import { now, json } from '../utils.js';
import { numSetting, boolSetting, setting, activeStrategy, slippageAdjustedMcap } from './settings.js';

export function openPositions() {
  return db.prepare('SELECT * FROM dry_run_positions WHERE status = ? ORDER BY opened_at_ms DESC').all('open');
}

export function openPositionCount() {
  return db.prepare('SELECT COUNT(*) AS count FROM dry_run_positions WHERE status = ?').get('open').count;
}

export function hasClosedPosition(mint) {
  const row = db.prepare(`
    SELECT 1 FROM dry_run_positions WHERE mint = ? AND status = 'closed' LIMIT 1
  `).get(mint);
  return !!row;
}

export function canOpenMorePositions() {
  const strat = activeStrategy();
  const max = strat.max_open_positions ?? numSetting('max_open_positions', 3);
  if (max <= 0) return true;
  return openPositionCount() < max;
}

// Read-only pre-swap guard: run BEFORE spending SOL so a dedup hit or position-cap
// breach never leaves orphaned tokens in the wallet. Mirrors createLivePosition's
// in-transaction dedup (which stays as the backstop). Returns {allowed, reason}.
export function checkEntryGuards(mint) {
  if (!canOpenMorePositions()) {
    const max = activeStrategy().max_open_positions ?? numSetting('max_open_positions', 3);
    return { allowed: false, reason: `max_open_positions (${openPositionCount()}/${max})` };
  }
  const existing = db.prepare(`SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1`).get(mint);
  if (existing) return { allowed: false, reason: 'open position exists', blockedById: existing.id };
  const recentClosed = db.prepare(`SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > ? LIMIT 1`).get(mint, now() - 86400000);
  if (recentClosed) return { allowed: false, reason: 'closed <24h', blockedById: recentClosed.id };
  const pastWin = db.prepare(`SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND pnl_percent > 0 LIMIT 1`).get(mint);
  if (pastWin) return { allowed: false, reason: 'past win exists', blockedById: pastWin.id };
  return { allowed: true };
}

export function tradingMode() {
  const mode = setting('trading_mode', 'dry_run');
  return ['dry_run', 'confirm', 'live'].includes(mode) ? mode : 'dry_run';
}

export function allPositions(limit = 10) {
  return db.prepare('SELECT * FROM dry_run_positions ORDER BY id DESC LIMIT ?').all(limit);
}

export function createDryRunPosition(candidateId, candidate, decision, reason = 'llm_buy') {
  const strat = activeStrategy();
  let sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  
  // OPTION C HYBRID: Risk-based position sizing
  // Calculate total risk severity from candidate.riskFlags
  const riskFlags = candidate.riskFlags || [];
  const totalRiskSeverity = riskFlags.reduce((sum, flag) => sum + (flag.severity || 0), 0);
  
  if (totalRiskSeverity >= 2) {
    // High risk (severity ≥2) → cut size to 50%
    const originalSize = sizeSol;
    sizeSol *= 0.5;
    console.log(`[position] risk-adjusted size: ${originalSize} → ${sizeSol} SOL (total risk severity: ${totalRiskSeverity}, flags: ${riskFlags.map(f => f.type).join(', ')})`);
  }
  
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  let entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  entryMcap = slippageAdjustedMcap(entryMcap, 'entry');
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false };

    // Dedup: block re-entry if this token has been closed within 24 hours
    const recentClosed = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > ? LIMIT 1
    `).get(candidate.token.mint, now() - 86400000);
    if (recentClosed) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — closed <24h ago`);
      return { id: recentClosed.id, isNew: false };
    }

    // Block re-entry if this mint had a winning trade in the last WIN_BLOCK_DAYS days (avoid round-trip losses)
    const WIN_BLOCK_DAYS = 7;
    const pastWin = db.prepare(`
      SELECT id, pnl_sol, closed_at_ms FROM dry_run_positions
      WHERE mint = ? AND status = 'closed' AND pnl_percent > 0
        AND closed_at_ms > ?
      ORDER BY closed_at_ms DESC LIMIT 1
    `).get(candidate.token.mint, now() - WIN_BLOCK_DAYS * 86400000);
    if (pastWin) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — past WIN exists`);
      return { id: pastWin.id, isNew: false, blockedBy: 'past_win', pastWinPnlSol: pastWin.pnl_sol, pastWinClosedAtMs: pastWin.closed_at_ms };
    }

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      strat.id,
      json({ candidate, decision, reason, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { id: positionId, isNew: true };
  })();
}

export function createLivePosition(candidateId, candidate, decision, swap, reason = 'live_buy') {
  const strat = activeStrategy();
  const sizeSol = strat.position_size_sol ?? numSetting('dry_run_buy_sol', 0.1);
  const entryPrice = Number(candidate.metrics.priceUsd || 0) || null;
  const entryMcap = Number(candidate.metrics.marketCapUsd || candidate.metrics.graduatedMarketCapUsd || 0) || null;
  const tp = Number(decision.suggested_tp_percent || strat.tp_percent || numSetting('default_tp_percent', 50));
  const sl = Number(decision.suggested_sl_percent || strat.sl_percent || numSetting('default_sl_percent', -25));
  const trailingEnabled = (strat.trailing_enabled ?? boolSetting('default_trailing_enabled', true)) ? 1 : 0;
  const trailingPercent = strat.trailing_percent ?? numSetting('default_trailing_percent', 20);

  return db.transaction(() => {
    const existing = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'open' LIMIT 1
    `).get(candidate.token.mint);
    if (existing) return { id: existing.id, isNew: false };

    // Dedup: block re-entry if this token has been closed within 24 hours
    const recentClosed = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND closed_at_ms > ? LIMIT 1
    `).get(candidate.token.mint, now() - 86400000);
    if (recentClosed) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — closed <24h ago (live)`);
      return { id: recentClosed.id, isNew: false };
    }

    // Block re-entry if this mint ever had a winning trade (avoid round-trip losses)
    const pastWin = db.prepare(`
      SELECT id FROM dry_run_positions WHERE mint = ? AND status = 'closed' AND pnl_percent > 0 LIMIT 1
    `).get(candidate.token.mint);
    if (pastWin) {
      console.log(`[positions] blocked re-entry ${candidate.token.symbol} (${candidate.token.mint.slice(0, 8)}) — past WIN exists (live)`);
      return { id: pastWin.id, isNew: false };
    }

    const result = db.prepare(`
      INSERT INTO dry_run_positions (
        candidate_id, mint, symbol, status, opened_at_ms, size_sol, entry_price, entry_mcap,
        token_amount_est, high_water_price, high_water_mcap, tp_percent, sl_percent,
        trailing_enabled, trailing_percent, trailing_armed, llm_decision_id,
        execution_mode, entry_signature, token_amount_raw, strategy_id, snapshot_json
      ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'live', ?, ?, ?, ?)
    `).run(
      candidateId,
      candidate.token.mint,
      candidate.token.symbol,
      now(),
      sizeSol,
      entryPrice,
      entryMcap,
      null,
      entryPrice,
      entryMcap,
      tp,
      sl,
      trailingEnabled,
      trailingPercent,
      decision.id || null,
      swap.signature,
      swap.outputAmount || null,
      strat.id,
      json({ candidate, decision, reason, swap, strategy: strat.id }),
    );
    const positionId = Number(result.lastInsertRowid);
    db.prepare(`
      INSERT INTO dry_run_trades (position_id, mint, side, at_ms, price, mcap, size_sol, token_amount_est, reason, payload_json)
      VALUES (?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?)
    `).run(positionId, candidate.token.mint, now(), entryPrice, entryMcap, sizeSol, null, reason, json({ candidateId, decision, swap }));
    db.prepare(`
      INSERT INTO tp_sl_rules (position_id, tp_percent, sl_percent, trailing_enabled, trailing_percent, updated_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(positionId, tp, sl, trailingEnabled, trailingPercent, now());
    return { id: positionId, isNew: true };
  })();
}
