import axios from 'axios';
import { WSOL_MINT, JSON_HEADERS, JUPITER_API_KEY, JUPITER_SWAP_BASE_URL } from '../config.js';
import { now, sleep } from '../utils.js';

const jupiterAssetCache = new Map();
let jupiterAssetBackoffUntil = 0;

function jupiterAssetBackoffActive() {
  return now() < jupiterAssetBackoffUntil;
}

function setJupiterAssetBackoff(err) {
  if (err.response?.status !== 429) return;
  const resetHeader = Number(err.response?.headers?.['x-ratelimit-reset'] || 0);
  const resetMs = resetHeader > 1_000_000_000_000 ? resetHeader : resetHeader * 1000;
  jupiterAssetBackoffUntil = resetMs > now() ? resetMs : now() + 30_000;
  console.log(`[asset] backing off until ${new Date(jupiterAssetBackoffUntil).toISOString()} (429)`);
}

let quoteBackoffUntil = 0;
const quoteSnapshotCache = new Map();
const QUOTE_SNAPSHOT_MS = 10_000;
// The keyed quote plan is small (x-ratelimit-current: 10). Bursts — 2 quotes per
// position tick plus 3 retries per entry — hit 429 instantly, so requests are paced
// instead of fired in parallel.
const QUOTE_MIN_GAP_MS = 130;
let quoteNextSlot = 0;

async function quoteSlot() {
  const at = Date.now();
  const slot = Math.max(at, quoteNextSlot);
  quoteNextSlot = slot + QUOTE_MIN_GAP_MS;
  if (slot > at) await sleep(slot - at);
}

function quoteBackoffActive() {
  return now() < quoteBackoffUntil;
}

function setQuoteBackoff(err) {
  if (err.response?.status !== 429) return;
  const resetHeader = Number(err.response?.headers?.['x-ratelimit-reset'] || 0);
  const resetMs = resetHeader > 1_000_000_000_000 ? resetHeader : resetHeader * 1000;
  // 30s used to black out EVERY quote (measured 28.6% of the day dead) which froze
  // position monitoring; cap the wait so a single 429 costs one tick, not 10.
  quoteBackoffUntil = now() + Math.min(Math.max(resetMs - now(), 1_000), 10_000);
  console.log(`[quote] backing off until ${new Date(quoteBackoffUntil).toISOString()} (429)`);
}

let solUsdCache = { price: null, at: 0 };

function jupiterStatsForInterval(row, interval) {
  const key = `stats${interval}`;
  return row?.[key] || row?.stats5m || row?.stats1h || row?.stats24h || {};
}

function normalizeJupiterTrendingRow(row, interval, rank) {
  const stats = jupiterStatsForInterval(row, interval);
  const buyVolume = Number(stats.buyVolume ?? 0);
  const sellVolume = Number(stats.sellVolume ?? 0);
  const numBuys = Number(stats.numBuys ?? 0);
  const numSells = Number(stats.numSells ?? 0);
  const topHolders = Number(row?.audit?.topHoldersPercentage);
  const botHolders = Number(row?.audit?.botHoldersPercentage);
  return {
    ...row,
    address: row?.id,
    price: Number(row?.usdPrice ?? 0),
    volume: buyVolume + sellVolume,
    liquidity: Number(row?.liquidity ?? 0),
    market_cap: Number(row?.mcap ?? row?.fdv ?? 0),
    swaps: numBuys + numSells,
    buys: numBuys,
    sells: numSells,
    holder_count: Number(row?.holderCount ?? 0),
    top_10_holder_rate: Number.isFinite(topHolders) ? topHolders / 100 : null,
    launchpad_platform: row?.launchpad || null,
    launchpad_status: row?.graduatedAt ? '2' : null,
    smart_degen_count: Number(stats.numOrganicBuyers ?? 0),
    hot_level: Number(row?.organicScore ?? 0),
    rug_ratio: null,
    bundler_rate: Number.isFinite(botHolders) ? botHolders / 100 : null,
    source: 'jupiter_toptrending',
    interval,
    rank,
    stats,
  };
}

async function fetchJupiterAsset(mint, { useCache = true, ttlMs = 20_000 } = {}) {
  const cached = jupiterAssetCache.get(mint);
  if (useCache && cached && now() - cached.at < ttlMs) return cached.data;
  if (jupiterAssetBackoffActive()) return useCache ? cached?.data || null : null;
  try {
    const url = new URL('https://datapi.jup.ag/v1/assets/search');
    url.searchParams.set('query', mint);
    const res = await axios.get(url.toString(), {
      timeout: 10_000,
      headers: JSON_HEADERS,
    });
    const rows = Array.isArray(res.data) ? res.data : [];
    const data = rows.find(row => row?.id === mint) || null;
    jupiterAssetCache.set(mint, { at: now(), data });
    return data;
  } catch (err) {
    setJupiterAssetBackoff(err);
    if (err.response?.status !== 429) console.log(`[asset] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return useCache ? cached?.data || null : null;
  }
}

async function fetchSolUsdPrice() {
  const keyed = JUPITER_API_KEY
    ? { ...JSON_HEADERS, 'x-api-key': JUPITER_API_KEY }
    : JSON_HEADERS;
  const hosts = JUPITER_API_KEY
    ? ['https://api.jup.ag', 'https://lite-api.jup.ag']
    : ['https://lite-api.jup.ag'];
  for (const host of hosts) {
    try {
      await quoteSlot();
      const res = await axios.get(`${host}/price/v3?ids=${WSOL_MINT}`, { timeout: 5000, headers: keyed });
      const price = Number(res.data?.[WSOL_MINT]?.usdPrice);
      if (Number.isFinite(price) && price > 0) return price;
    } catch (err) {
      console.log(`[sol-price] ${host} ${err.response?.status || ''} ${err.message}`);
    }
  }
  return null;
}

async function estimateTokenAmountFromSol(sizeSol, entryPrice) {
  if (!Number.isFinite(Number(entryPrice)) || Number(entryPrice) <= 0) return null;
  const solUsd = await fetchSolUsdPrice();
  if (!Number.isFinite(Number(solUsd)) || Number(solUsd) <= 0) return null;
  return Number(sizeSol) * solUsd / Number(entryPrice);
}

async function fetchJupiterHolders(mint) {
  try {
    const res = await axios.get(`https://datapi.jup.ag/v1/holders/${mint}`, {
      timeout: 10_000,
      headers: JSON_HEADERS,
    });
    const holders = Array.isArray(res.data?.holders) ? res.data.holders : [];
    const total = holders.reduce((sum, holder) => sum + Number(holder.amount || 0), 0);
    const mapped = holders.map((holder, index) => {
      const pct = total > 0 ? Number(holder.amount || 0) / total * 100 : null;
      return {
        address: holder.address,
        rank: index + 1,
        amount: Number(holder.amount || 0),
        percent: pct,
        tags: (holder.tags || []).map(tag => tag.name || tag.id).filter(Boolean),
      };
    });
    const top20 = mapped.slice(0, 20);
    return {
      count: holders.length,
      holders: mapped,
      top20,
      top20Percent: top20.reduce((sum, holder) => sum + Number(holder.percent || 0), 0),
      maxHolderPercent: Math.max(0, ...top20.map(holder => Number(holder.percent || 0))),
    };
  } catch (err) {
    console.log(`[holders] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return { count: 0, holders: [], top20: [], top20Percent: null, maxHolderPercent: null };
  }
}

function summarizeCandles(label, candles) {
  if (!candles.length) return { label, available: false };
  const first = candles[0];
  const last = candles[candles.length - 1];
  const high = Math.max(...candles.map(candle => Number(candle.high || 0)));
  const low = Math.min(...candles.map(candle => Number(candle.low || Infinity)));
  const volumeNative = candles.reduce((sum, candle) => sum + Number(candle.volume || 0), 0);
  const current = Number(last.close);
  const start = Number(first.open);
  return {
    label,
    available: true,
    purpose: label === 'ath_context_24h_5m' ? 'ath_context' : 'range_context',
    candles: candles.length,
    fromTime: first.time,
    toTime: last.time,
    current,
    high,
    low,
    volumeNative,
    changePercent: start > 0 ? (current / start - 1) * 100 : null,
    belowHighPercent: high > 0 ? (current / high - 1) * 100 : null,
    aboveLowPercent: low > 0 && Number.isFinite(low) ? (current / low - 1) * 100 : null,
  };
}

async function fetchJupiterChartWindow(mint, interval, candles, label) {
  const url = new URL(`https://datapi.jup.ag/v2/charts/${mint}`);
  url.searchParams.set('interval', interval);
  url.searchParams.set('to', String(now()));
  url.searchParams.set('candles', String(candles));
  url.searchParams.set('type', 'price');
  url.searchParams.set('quote', 'native');
  const res = await axios.get(url.toString(), {
    timeout: 10_000,
    headers: JSON_HEADERS,
  });
  return summarizeCandles(label, Array.isArray(res.data?.candles) ? res.data.candles : []);
}

async function fetchJupiterChartContext(mint) {
  const windows = [
    ['5_MINUTE', 288, 'ath_context_24h_5m'],
    ['1_HOUR', 168, 'swing_7d_1h'],
    ['4_HOUR', 180, 'long_30d_4h'],
  ];
  const results = await Promise.all(windows.map(([interval, candles, label]) => (
    fetchJupiterChartWindow(mint, interval, candles, label).catch((err) => {
      console.log(`[chart] ${mint.slice(0, 8)}... ${interval} ${err.message}`);
      return { label, available: false, error: err.message };
    })
  )));
  const available = results.filter(row => row.available);
  const currentNative = available[0]?.current ?? null;
  const rangeHigh = available.length ? Math.max(...available.map(row => Number(row.high || 0))) : null;
  const topBlastRisk = Number.isFinite(Number(currentNative)) && Number.isFinite(Number(rangeHigh)) && rangeHigh > 0
    ? currentNative / rangeHigh >= 0.85
    : null;
  return {
    quote: 'native',
    purpose: 'ATH/range context, not momentum scoring',
    currentNative,
    rangeHighNative: rangeHigh,
    belowRangeHighPercent: currentNative && rangeHigh ? (currentNative / rangeHigh - 1) * 100 : null,
    distanceFromAthPercent: currentNative && rangeHigh ? (currentNative / rangeHigh - 1) * 100 : null,
    topBlastRisk,
    windows: results,
  };
}

const IGNORED_PNL_MINTS = new Set([
  'So11111111111111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
]);

async function fetchSolUsdPriceCached() {
  if (solUsdCache.price != null && now() - solUsdCache.at < 60_000) return solUsdCache.price;
  const price = await fetchSolUsdPrice();
  solUsdCache = { price, at: now() };
  return price;
}

async function jupiterQuoteOnce(params, label) {
  if (quoteBackoffActive()) return null;
  try {
    await quoteSlot();
    const url = new URL(`${JUPITER_SWAP_BASE_URL}/quote`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    // The keyed endpoint has a higher tier; the old hardcoded lite-api host was
    // unauthenticated and sat at ~1 req/s, so monitoring was permanently 429'd.
    const headers = JUPITER_API_KEY ? { ...JSON_HEADERS, 'x-api-key': JUPITER_API_KEY } : JSON_HEADERS;
    const res = await axios.get(url.toString(), { timeout: 10_000, headers });
    return res.data?.outAmount ? { ...res.data, observedAtMs: now() } : null;
  } catch (err) {
    setQuoteBackoff(err);
    if (err.response?.status !== 429) console.log(`[quote] ${label} ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

// A freshly migrated mint often has no route for a few hundred ms — retry instead of
// dropping the entry (retries skip 429s, which are handled by the backoff).
async function jupiterQuote(params, label, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    const quote = await jupiterQuoteOnce(params, label);
    if (quote) return quote;
    if (quoteBackoffActive()) return null;
    await sleep(350);
  }
  return null;
}

// Fixed 1000-token reference amount ignores price impact for large sizes —
// upgrade to position-sized quotes when size_sol > 1.
export async function fetchJupiterExecutionQuote({ inputMint, outputMint, amount }) {
  return jupiterQuote({ inputMint, outputMint, amount, slippageBps: 100 }, 'execution');
}

async function fetchTokenSpotViaQuote(mint, decimals = 9) {
  const normalizedDecimals = Number.isFinite(Number(decimals)) ? Math.max(0, Math.min(18, Number(decimals))) : 9;
  const cacheKey = `${mint}:${normalizedDecimals}`;
  const cached = quoteSnapshotCache.get(cacheKey);
  if (cached && now() - cached.at < QUOTE_SNAPSHOT_MS) return cached.priceUsd;
  if (quoteBackoffActive()) return null;
  try {
    const tokenUnits = 1000 * (10 ** normalizedDecimals);
    const [solUsd, quoteRes] = await Promise.all([
      fetchSolUsdPriceCached(),
      jupiterQuote({ inputMint: mint, outputMint: WSOL_MINT, amount: Math.round(tokenUnits), slippageBps: 100 }, mint.slice(0, 8), 2),
    ]);
    const outAmount = quoteRes?.outAmount;
    if (!outAmount) return null;
    const outSol = Number(outAmount) / 1e9;
    if (!Number.isFinite(solUsd) || solUsd <= 0) return null;
    const priceUsd = (outSol / 1000) * solUsd;
    quoteSnapshotCache.set(cacheKey, { at: now(), priceUsd });
    return priceUsd;
  } catch (err) {
    setQuoteBackoff(err);
    if (err.response?.status !== 429) console.log(`[quote] ${mint.slice(0, 8)}... ${err.response?.status || ''} ${err.message}`);
    return null;
  }
}

async function fetchJupiterWalletPnl(walletAddress) {
  try {
    const url = new URL('https://datapi.jup.ag/v1/pnl');
    url.searchParams.set('addresses', walletAddress);
    url.searchParams.set('includeClosed', 'false');
    const res = await axios.get(url.toString(), { timeout: 10_000, headers: JSON_HEADERS });
    const data = res.data?.[walletAddress] || {};
    for (const mint of IGNORED_PNL_MINTS) delete data[mint];
    return data;
  } catch (err) {
    console.log(`[pnl] ${err.response?.status || ''} ${err.message}`);
    return {};
  }
}

export {
  jupiterStatsForInterval,
  normalizeJupiterTrendingRow,
  fetchJupiterAsset,
  fetchSolUsdPrice,
  estimateTokenAmountFromSol,
  fetchJupiterHolders,
  summarizeCandles,
  fetchJupiterChartWindow,
  fetchJupiterChartContext,
  fetchJupiterWalletPnl,
  fetchTokenSpotViaQuote,
  jupiterAssetBackoffActive,
  setJupiterAssetBackoff,
};
