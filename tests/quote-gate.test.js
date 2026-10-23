import test from 'node:test';
import assert from 'node:assert/strict';
import { delayedQuote, validQuote } from '../src/execution/paperSafety.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const MINT = 'Dym3iZMU4qBJB332Z7piYZ6EghVd1Go92wDUWdQypump';
const request = { inputMint: WSOL, outputMint: MINT, amount: 100_000_000 };
const noWait = async () => {};

function quote(outAmount, observedAtMs = Date.now()) {
  return {
    inputMint: WSOL,
    outputMint: MINT,
    inAmount: '100000000',
    outAmount: String(outAmount),
    swapMode: 'ExactIn',
    routePlan: [{ swapInfo: {} }],
    contextSlot: 123456,
    observedAtMs,
  };
}

test('delayedQuote accepts a pair inside the 3% band', async () => {
  const quotes = [quote(1000), quote(975)];
  const result = await delayedQuote(request, async () => quotes.shift(), { wait: noWait });
  assert.equal(result.reference.outAmount, '1000');
  assert.equal(result.fill.outAmount, '975');
});

test('delayedQuote reports the measured drift on a gate rejection', async () => {
  const quotes = [quote(1000), quote(900)];
  await assert.rejects(
    () => delayedQuote(request, async () => quotes.shift(), { wait: noWait }),
    (err) => {
      assert.equal(err.message, 'slippage_exceeds_3_percent');
      assert.equal(err.detail.driftPct, -10);
      assert.equal(err.detail.referenceOut, '1000');
      assert.equal(err.detail.fillOut, '900');
      return true;
    },
  );
});

test('delayedQuote retries the reference quote before dropping a fresh mint', async () => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    if (calls === 1) return null;                       // not routable yet
    if (calls === 2) return { ...quote(1000), swapMode: 'ExactOut' }; // invalid quote
    return quote(calls === 3 ? 1000 : 990);
  };
  const result = await delayedQuote(request, fetcher, { wait: noWait, attempts: 3 });
  assert.equal(calls, 4);
  assert.equal(result.reference.outAmount, '1000');
  assert.equal(result.fill.outAmount, '990');
});

test('validQuote rejects stale observations', () => {
  assert.equal(validQuote(quote(1000, Date.now() - 60_000), request), false);
  assert.equal(validQuote(quote(1000), request), true);
});
