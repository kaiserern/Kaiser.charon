// Verifikasi plumbing quote pasca-patch: governor header-aware + entry waitOutBackoff.
import 'dotenv/config';
import { delayedQuote } from '../src/execution/paperSafety.js';
import { fetchJupiterExecutionQuote } from '../src/enrichment/jupiter.js';

const WSOL = 'So11111111111111111111111111111111111111112';
// Mint yang terakhir ditolak `reference_quote_missing_or_stale` — justru ini yang
// harus lolos sekarang karena terbukti masih quotable.
const mint = process.argv[2];
const request = { inputMint: WSOL, outputMint: mint, amount: 100_000_000 };
const fetcher = (req) => fetchJupiterExecutionQuote(req, { waitOutBackoff: true });

let t0 = Date.now();
const result = await delayedQuote(request, fetcher, { attempts: 3 });
const drift = (Number(result.fill.outAmount) / Number(result.reference.outAmount) - 1) * 100;
console.log(JSON.stringify({
  entryQuote: 'ok',
  ms: Date.now() - t0,
  driftPct: Number(drift.toFixed(2)),
  referenceOut: result.reference.outAmount,
  fillOut: result.fill.outAmount,
}));

// Burst test: 12 quote berurutan. Governor harus menahan laju ke batas bucket
// (10/detik) alih-alih menabraknya dan memicu backoff.
let ok = 0, null429 = 0;
const started = Date.now();
for (let i = 0; i < 12; i++) {
  const q = await fetchJupiterExecutionQuote(request);
  if (q) ok++; else null429++;
}
console.log(JSON.stringify({ burst: 12, ok, failed: null429, ms: Date.now() - started }));
