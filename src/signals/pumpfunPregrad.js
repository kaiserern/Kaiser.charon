import axios from 'axios';
import {
  JSON_HEADERS,
  PREGRAD_POLL_MS,
  PREGRAD_LOOKBACK_MS,
  PREGRAD_MIN_RSSR_SOL,
  PREGRAD_MAX_RSSR_SOL,
  PREGRAD_MAX_AGE_MS,
  PREGRAD_MAX_ATH_MULTIPLE,
} from '../config.js';
import { now } from '../utils.js';
import { singleFlight } from '../utils/singleFlight.js';
import { cfFetchJson } from '../enrichment/cfFetch.js';
import { boolSetting, numSetting } from '../db/settings.js';
import { sendTelegram } from '../telegram/send.js';

const PREGRAD_LAMPORTS = 1_000_000_000;
const MAX_CONSECUTIVE_ERRORS = 3;

const PUMPFUN_HEADERS = {
  ...JSON_HEADERS,
  Origin: 'https://pump.fun',
  Referer: 'https://pump.fun/',
};

export const pregradTokens = new Map();
let candidateHandler = null;
let pollTimer = null;
let stopped = false;
let consecutiveErrors = 0;

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

export function getTrackedPregradTokens() {
  return {
    size: pregradTokens.size,
    mints: [...pregradTokens.keys()],
  };
}

function buildPregradPayload(coin) {
  const realSolReserves = Number(coin.real_sol_reserves) / PREGRAD_LAMPORTS;
  const virtualSolReserves = Number(coin.virtual_sol_reserves) / PREGRAD_LAMPORTS;
  const rssrPctToGrad = (realSolReserves / numSetting('pregrad_max_rssr_sol', PREGRAD_MAX_RSSR_SOL) * 100).toFixed(1);
  return {
    mint: coin.mint,
    route: 'pumpfun_pregrad',
    pregradToken: {
      name: coin.name,
      symbol: coin.symbol,
      creator: coin.creator,
      usd_market_cap: coin.usd_market_cap,
      real_sol_reserves_sol: realSolReserves,
      vsr_sol: virtualSolReserves,
      rssr_pct_to_grad: rssrPctToGrad,
      twitter: coin.twitter || null,
      website: coin.website || null,
      telegram: coin.telegram || null,
      nsfw: coin.nsfw,
      is_banned: coin.is_banned,
      reply_count: coin.reply_count,
      last_trade_ago_sec: Math.round((Date.now() - coin.last_trade_timestamp) / 1000),
      age_min: Math.round((Date.now() - coin.created_timestamp) / 60000),
    },
    signature: null,
  };
}

function detectGraduations(currentCoins) {
  const previous = new Map();
  for (const [mint, entry] of pregradTokens) {
    if (entry.complete) {
      previous.set(mint, { complete: true, real_sol_reserves: entry.real_sol_reserves });
    } else if (entry.real_sol_reserves_sol >= numSetting('pregrad_max_rssr_sol', PREGRAD_MAX_RSSR_SOL) - 1) {
      previous.set(mint, { complete: false, real_sol_reserves: entry.real_sol_reserves_sol });
    }
  }

  for (const coin of currentCoins) {
    if (!coin.complete) continue;
    const prior = previous.get(coin.mint);
    if (!prior) continue;
    if (prior.complete) continue;
    const rssrNow = Number(coin.real_sol_reserves) / PREGRAD_LAMPORTS;
    if (rssrNow >= numSetting('pregrad_max_rssr_sol', PREGRAD_MAX_RSSR_SOL)) {
      sendTelegram(
        `🎓 [pregrad] GRADUATED — ${coin.symbol || coin.name || coin.mint.slice(0, 8)} (${coin.mint.slice(0, 8)}...) ` +
        `rssr=${rssrNow.toFixed(2)} SOL mcap=$${coin.usd_market_cap ?? '?'}`
      ).catch(err => console.log(`[pregrad] graduation telegram failed: ${err.message}`));
      console.log(`[pregrad] 🎓 GRADUATED ${coin.symbol || coin.mint.slice(0, 8)} rssr=${rssrNow.toFixed(2)} SOL`);
    }
  }
}

// pump.fun frontend sits behind Cloudflare and answers 403 to this host, which kept
// the pregrad route permanently in backoff. Fall back to the browser sidecar.
async function fetchPregradCoins() {
  try {
    const res = await axios.get('https://frontend-api-v3.pump.fun/coins', {
      params: { sort: 'last_trade_timestamp', order: 'DESC', limit: 200 },
      timeout: 10_000,
      headers: PUMPFUN_HEADERS,
    });
    const direct = Array.isArray(res.data) ? res.data : (Array.isArray(res.data?.coins) ? res.data.coins : []);
    if (direct.length) return direct;
  } catch (err) {
    console.log(`[pregrad] direct fetch ${err.response?.status || err.message}; trying sidecar`);
  }
  const viaBrowser = await cfFetchJson('https://frontend-api-v3.pump.fun/coins?sort=last_trade_timestamp&order=DESC&limit=200');
  const coins = Array.isArray(viaBrowser) ? viaBrowser : (Array.isArray(viaBrowser?.coins) ? viaBrowser.coins : []);
  if (!coins.length) throw new Error('pregrad coins unavailable (direct 403 + sidecar empty)');
  return coins;
}

export async function fetchPregradTokens() {
  try {
    const coins = await fetchPregradCoins();
    const minLamports = numSetting('pregrad_min_rssr_sol', PREGRAD_MIN_RSSR_SOL) * PREGRAD_LAMPORTS;
    const maxLamports = numSetting('pregrad_max_rssr_sol', PREGRAD_MAX_RSSR_SOL) * PREGRAD_LAMPORTS;
    const maxAgeMs = numSetting('pregrad_max_age_ms', PREGRAD_MAX_AGE_MS);
    const maxAthMultiple = numSetting('pregrad_max_ath_multiple', PREGRAD_MAX_ATH_MULTIPLE);
    const inWindow = [];
    for (const coin of coins) {
      if (!coin || coin.complete) continue;
      const rssr = Number(coin.real_sol_reserves);
      if (!Number.isFinite(rssr) || rssr < minLamports || rssr >= maxLamports) continue;

      const createdTs = Number(coin.created_timestamp);
      if (Number.isFinite(createdTs) && createdTs > 0) {
        const ageMs = Date.now() - createdTs;
        if (ageMs > maxAgeMs) {
          console.log(`[pregrad] skipped ${coin.symbol || '?'} (${coin.mint.slice(0,8)}): age ${(ageMs / 3_600_000).toFixed(1)}h > ${(maxAgeMs / 3_600_000).toFixed(1)}h limit`);
          continue;
        }
      } else {
        console.log(`[pregrad] warn: missing created_timestamp for ${coin.mint.slice(0,8)} — treating as fresh`);
      }

      const athMcap = Number(coin.ath_market_cap);
      const curMcap = Number(coin.usd_market_cap);
      if (Number.isFinite(athMcap) && athMcap > 0 && Number.isFinite(curMcap) && curMcap > 0) {
        const athMultiple = athMcap / curMcap;
        if (athMultiple > maxAthMultiple) {
          console.log(`[pregrad] skipped ${coin.symbol || '?'} (${coin.mint.slice(0,8)}): ATH ${athMultiple.toFixed(2)}x current > ${maxAthMultiple}x limit`);
          continue;
        }
      } else {
        console.log(`[pregrad] warn: missing ath_market_cap/usd_market_cap for ${coin.mint.slice(0,8)} — treating as unpumped`);
      }

      inWindow.push(coin);
    }

    detectGraduations(coins);

    let newCandidates = 0;
    for (const coin of inWindow) {
      if (pregradTokens.has(coin.mint)) continue;
      pregradTokens.set(coin.mint, {
        ...coin,
        seenAt: now(),
        real_sol_reserves_sol: Number(coin.real_sol_reserves) / PREGRAD_LAMPORTS,
      });
      newCandidates++;
      if (candidateHandler) {
        const payload = buildPregradPayload(coin);
        candidateHandler(payload).catch(err =>
          console.log(`[pregrad] candidate trigger failed for ${coin.mint.slice(0, 8)}: ${err.message}`),
        );
      }
    }

    const cutoff = now() - PREGRAD_LOOKBACK_MS;
    for (const [mint, entry] of pregradTokens) {
      if (Number(entry.seenAt || 0) < cutoff) pregradTokens.delete(mint);
    }

    consecutiveErrors = 0;
    console.log(`[pregrad] detected ${inWindow.length} tokens in window, ${newCandidates} new candidates, tracking ${pregradTokens.size}`);
  } catch (err) {
    consecutiveErrors++;
    console.log(`[pregrad] fetch failed (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${err.message}`);
    throw err;
  }
}

export function startPumpfunPregrad(trackFailure) {
  if (pollTimer) return;
  if (stopped) return;
  if (!boolSetting('pregrad_enabled', true)) {
    console.log('[pregrad] polling disabled by setting');
    return;
  }
  stopPumpfunPregrad();
  stopped = false;
  consecutiveErrors = 0;

  const scan = singleFlight(fetchPregradTokens);
  const cycle = () => {
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.log(`[pregrad] backing off — ${consecutiveErrors} consecutive errors, skipping cycle`);
      return;
    }
    const wrapped = trackFailure || ((fn) => fn().catch(err => console.log(`[pregrad] ${err.message}`)));
    wrapped(scan);
  };

  scan().catch(err => console.log(`[pregrad] initial fetch failed: ${err.message}`));
  pollTimer = setInterval(cycle, PREGRAD_POLL_MS);
  console.log(`[pregrad] polling started (interval ${PREGRAD_POLL_MS}ms)`);
}

export function stopPumpfunPregrad() {
  stopped = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
