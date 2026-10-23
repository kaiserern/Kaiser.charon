import { escapeHtml, fmtPct, fmtSol, fmtUsd, short, gmgnLink, txLink, accountLink } from '../format.js';

export function formatRecipients(shareholders) {
  if (!shareholders?.length) return '';
  return shareholders.slice(0, 5).map((holder, index) => {
    const pct = holder.bps != null ? ` (${fmtPct(holder.bps / 100)})` : '';
    const label = shareholders.length > 1 ? `Recipient ${index + 1}` : 'Recipient';
    return `${label}: <a href="${accountLink(holder.pubkey)}">${short(holder.pubkey)}</a>${pct}`;
  }).join('\n') + '\n';
}

export function signalLabel(signals = {}) {
  return [
    signals.hasFeeClaim ? 'fees' : null,
    signals.hasGraduated ? 'graduated' : null,
    signals.hasTrending ? 'trending' : null,
  ].filter(Boolean).join(' + ') || signals.route || 'unknown';
}

export function candidateSummary(candidate, decision = null) {
  const chartWindow = candidate.chart?.windows?.find(row => row.label === 'ath_context_24h_5m' && row.available)
    || candidate.chart?.windows?.find(row => row.label === 'recent_24h_5m' && row.available);
  const route = candidate.signals?.label || signalLabel(candidate.signals);
  const lines = [
    `🛶 <b>Charon Candidate</b>`,
    '',
    `Signal: <b>${escapeHtml(route)}</b>`,
    candidate.token.name || candidate.token.symbol ? `Name: <b>${escapeHtml(candidate.token.name || candidate.token.symbol)}${candidate.token.symbol && candidate.token.name ? ` (${escapeHtml(candidate.token.symbol)})` : ''}</b>` : null,
    `Token: <a href="${gmgnLink(candidate.token.mint)}">${short(candidate.token.mint)}</a>`,
    `<code>${escapeHtml(candidate.token.mint)}</code>`,
    [
      `Mcap: ${fmtUsd(candidate.metrics.marketCapUsd)}`,
      `Liq: ${fmtUsd(candidate.metrics.liquidityUsd)}`,
      `Fees: ${fmtSol(candidate.metrics.gmgnTotalFeesSol)} SOL`,
      `Grad vol: ${fmtUsd(candidate.metrics.graduatedVolumeUsd)}`,
    ].join(' · '),
    [
      `Holders: ${candidate.metrics.holderCount || '?'}`,
      `Top20: ${fmtPct(candidate.holders.top20Percent)}`,
      `Max holder: ${fmtPct(candidate.holders.maxHolderPercent)}`,
      `Saved wallets: ${candidate.savedWalletExposure.holderCount}/${candidate.savedWalletExposure.checked}`,
    ].join(' · '),
    candidate.trending ? [
      `Trending: #${candidate.trending.rank || '?'}/${escapeHtml(candidate.trending.interval || '')}`,
      `Vol: ${fmtUsd(candidate.metrics.trendingVolumeUsd)}`,
      `Swaps: ${candidate.metrics.trendingSwaps || 0}`,
      `Hot: ${candidate.metrics.trendingHotLevel || 0}`,
      `Smart: ${candidate.metrics.trendingSmartDegenCount || 0}`,
    ].join(' · ') : null,
    chartWindow ? [
      `ATH ctx: ${fmtPct(chartWindow.belowHighPercent)} from 24h high`,
      `Range low: ${fmtPct(chartWindow.aboveLowPercent)}`,
      `Top risk: ${candidate.chart.topBlastRisk ? 'yes' : 'no'}`,
    ].join(' · ') : null,
    candidate.twitterNarrative?.metrics ? [
      `Tweet: ${candidate.twitterNarrative.metrics.likes} likes`,
      `${candidate.twitterNarrative.metrics.retweets} RT`,
      `${candidate.twitterNarrative.metrics.replies} replies`,
      `${candidate.twitterNarrative.metrics.quotes} quotes`,
    ].join(' · ') : null,
    candidate.feeClaim ? `Fee claim: <b>${fmtSol(candidate.feeClaim.distributedSol)} SOL</b>` : null,
    candidate.twitterNarrative?.text ? `Narrative: ${escapeHtml(candidate.twitterNarrative.text.slice(0, 220))}` : null,
    decision ? `LLM: <b>${escapeHtml(decision.verdict)}</b> ${fmtPct(decision.confidence)} — ${escapeHtml(decision.reason || '')}` : null,
    candidate.filters.passed ? null : `Filtered: ${escapeHtml(candidate.filters.failures.join('; '))}`,
  ];
  return lines.filter(Boolean).join('\n');
}

export function compactCandidateLine(row, index = null) {
  const candidate = row.candidate;
  const prefix = index == null ? '' : `${index}. `;
  const name = candidate.token?.symbol || candidate.token?.name || short(candidate.token?.mint || '');
  const signal = candidate.signals?.label || signalLabel(candidate.signals);
  return [
    `${prefix}<b>${escapeHtml(name)}</b>`,
    `<a href="${gmgnLink(candidate.token.mint)}">${short(candidate.token.mint)}</a>`,
    escapeHtml(signal),
    `mcap ${fmtUsd(candidate.metrics?.marketCapUsd)}`,
    `liq ${fmtUsd(candidate.metrics?.liquidityUsd)}`,
    candidate.feeClaim ? `fee ${fmtSol(candidate.feeClaim.distributedSol)} SOL` : null,
  ].filter(Boolean).join(' · ');
}

export function batchRevealSummary(batchId, rows, decision, triggerCandidateId = null) {
  const selected = rows.find(row => row.id === Number(decision.selected_candidate_id));
  const trigger = rows.find(row => row.id === Number(triggerCandidateId));
  const lines = [
    '🧭 <b>Charon Screening</b>',
    '',
    `Batch: <b>#${batchId}</b> · Screened: <b>${rows.length}</b>`,
    trigger ? `Trigger: ${compactCandidateLine(trigger)}` : null,
    selected ? `Pick: ${compactCandidateLine(selected)}` : 'Pick: <b>none</b>',
    `Decision: <b>${escapeHtml(decision.verdict || 'WATCH')}</b> ${fmtPct(decision.confidence || 0)}`,
    decision.reason ? `Reason: ${escapeHtml(String(decision.reason).slice(0, 420))}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

export function formatPosition(position) {
  // For open: current PnL estimate. For closed: actual pnl_percent.
  let pnl;
  if (position.pnl_percent != null) {
    pnl = Number(position.pnl_percent);
  } else if (position.entry_mcap && position.current_mcap != null) {
    pnl = (Number(position.current_mcap) / Number(position.entry_mcap) - 1) * 100;
  } else if (position.entry_price && position.current_price != null) {
    pnl = (Number(position.current_price) / Number(position.entry_price) - 1) * 100;
  } else {
    pnl = 0;
  }
  const highLabel = position.status === 'closed' && position.exit_mcap != null
    ? `Exit: ${fmtUsd(position.exit_mcap)} (from high ${fmtUsd(position.high_water_mcap)}, ${fmtPct(position.high_water_mcap / position.entry_mcap * 100 - 100)})`
    : `High: ${fmtUsd(position.high_water_mcap)}`;
  return [
    `📍 <b>${escapeHtml(position.symbol || short(position.mint))}</b> #${position.id}`,
    `Token: <a href="${gmgnLink(position.mint)}">${short(position.mint)}</a>`,
    `Status: <b>${escapeHtml(position.status)}</b> · Mode: <b>${escapeHtml(position.execution_mode || 'dry_run')}</b> · Strategy: <b>${escapeHtml(position.strategy_id || 'sniper')}</b>`,
    position.entry_signature ? `Entry TX: <a href="${txLink(position.entry_signature)}">${short(position.entry_signature)}</a>` : null,
    `Entry mcap: ${fmtUsd(position.entry_mcap)} · ${highLabel}`,
    `Size: ${fmtSol(position.size_sol)} SOL · PnL: ${fmtPct(pnl)}`,
    `TP: ${fmtPct(position.tp_percent)} · SL: ${fmtPct(position.sl_percent)} · Trail: ${position.trailing_enabled ? `${fmtPct(position.trailing_percent)}` : 'off'}`,
    position.exit_reason ? `Exit: ${escapeHtml(position.exit_reason)} at ${fmtUsd(position.exit_mcap)} (${fmtPct(position.pnl_percent)})` : null,
    position.exit_signature ? `Exit TX: <a href="${txLink(position.exit_signature)}">${short(position.exit_signature)}</a>` : null,
  ].filter(Boolean).join('\n');
}

export function compactDecisionCandidate(row) {
  if (!row) return null;
  const c = row.candidate;
  return {
    candidateId: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    jupiterAsset: c.jupiterAsset ? {
      liquidity: c.jupiterAsset.liquidity,
      mcap: c.jupiterAsset.mcap,
      fdv: c.jupiterAsset.fdv,
      usdPrice: c.jupiterAsset.usdPrice,
      fees: c.jupiterAsset.fees,
      holderCount: c.jupiterAsset.holderCount,
      audit: c.jupiterAsset.audit,
      stats1h: c.jupiterAsset.stats1h,
      stats24h: c.jupiterAsset.stats24h,
    } : null,
    holders: {
      count: c.holders?.count,
      top20Percent: c.holders?.top20Percent,
      maxHolderPercent: c.holders?.maxHolderPercent,
      top20: c.holders?.top20,
    },
    chart: c.chart,
    savedWalletExposure: c.savedWalletExposure,
    twitterNarrative: c.twitterNarrative,
    filters: c.filters,
    createdAtMs: c.createdAtMs,
  };
}
