// Charon paper execution v2. Quotes already include pool/route fees.
export const PAPER_VERSION = 'quote-paper-2.0';
export const WSOL = 'So11111111111111111111111111111111111111112';
export function integer(value) {
  const s = String(value ?? '');
  if (!/^[0-9]+$/.test(s) || s.length > 40) throw new Error('invalid_integer_amount');
  return BigInt(s);
}
export function validQuote(q, request, at = Date.now()) {
  try {
    return !!q && q.inputMint === request.inputMint && q.outputMint === request.outputMint &&
      integer(q.inAmount) === integer(request.amount) && integer(q.inAmount) > 0n && integer(q.outAmount) > 0n &&
      q.swapMode === 'ExactIn' && Array.isArray(q.routePlan) && q.routePlan.length > 0 &&
      Number.isSafeInteger(q.contextSlot) && q.contextSlot > 0 &&
      Number.isFinite(q.observedAtMs) && at >= q.observedAtMs && at - q.observedAtMs <= 12000;
  } catch { return false; }
}
export async function delayedQuote(request, fetchQuote, { reference, wait = ms => new Promise(r => setTimeout(r, ms)), clock = Date.now, attempts = 1 } = {}) {
  let first = reference || null;
  if (!first) {
    // A mint that just migrated is often not routable yet; retrying the reference
    // beats dropping the entry (pumpportal conversion was 1.5% for this reason).
    for (let i = 0; i < Math.max(1, attempts); i++) {
      first = await fetchQuote(request);
      if (validQuote(first, request, clock())) break;
      first = null;
      if (i < attempts - 1) await wait(700);
    }
  }
  if (!validQuote(first, request, clock())) throw new Error('reference_quote_missing_or_stale');
  await wait(2000);
  const fill = await fetchQuote(request);
  if (!validQuote(fill, request, clock())) throw new Error('fill_quote_missing_or_stale');
  if (integer(fill.outAmount) * 10000n < integer(first.outAmount) * 9700n) {
    // Keep the measured drift on the error: "slippage_exceeds_3_percent" alone reads
    // like a plumbing failure in alerts, while it is the gate working (rejected mints
    // ran to a median -19% within 5 minutes; see charon-improvement-project).
    const driftPct = (Number(integer(fill.outAmount) * 10000n / integer(first.outAmount)) - 10000) / 100;
    const error = new Error('slippage_exceeds_3_percent');
    error.detail = { driftPct: Number(driftPct.toFixed(2)), referenceOut: String(first.outAmount), fillOut: String(fill.outAmount) };
    throw error;
  }
  return { reference: first, fill };
}
export function paperPnl(entryLamports, proceedsLamports, entryFee = '15000', exitFee = '15000') {
  const entry = integer(entryLamports), proceeds = integer(proceedsLamports);
  if (entry <= 0n) throw new Error('invalid_entry');
  const net = proceeds - entry - integer(entryFee) - integer(exitFee);
  return { netLamports: net.toString(), pnlSol: Number(net) / 1e9, pnlPercent: Number(net * 1000000n / entry) / 10000 };
}
export function momentumResult(value, threshold = .5) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) return { passed: false, score: -1, reason: 'invalid_threshold' };
  const score = value?.momentum_score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return { passed: false, score: -1, reason: 'invalid_model_score' };
  return { passed: score >= threshold, score, reason: score >= threshold ? 'model_pass' : 'model_reject' };
}
