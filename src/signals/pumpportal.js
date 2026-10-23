import { officeBroker, startOfficeBroker } from './officeBroker.js';
import { publishOfficeDiscovery } from './officeFeed.js';
import WebSocket from 'ws';
import { PUMPPORTAL_API_KEY, PUMPPORTAL_ENABLED } from '../config.js';
import { now, sleep } from '../utils.js';
import { singleFlight } from '../utils/singleFlight.js';
import { fetchGmgnTokenInfo } from '../enrichment/gmgn.js';
import { storeSignalEvent } from './trending.js';
import { sendTelegram } from '../telegram/send.js';

const WS_URL = `wss://pumpportal.fun/api/data?api-key=${PUMPPORTAL_API_KEY}`;
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_MS = 60_000;

const MONITOR_INTERVAL_MS = 30_000;
const MIN_CHECK_GAP_MS = 25_000;
const GRADUATION_MCAP_USD = 25_000;
const TRACK_TIMEOUT_MS = 7_200_000; // 2 hours
const MAX_TRACKED_TOKENS = 50;
const POLL_DELAY_MS = 100;
const MAX_CONSECUTIVE_ERRORS = 3;
const HEALTH_CHECK_INTERVAL_MS = 30_000;
const DISCONNECT_ALERT_THRESHOLD_MS = 5 * 60 * 1000;
const EVENT_SILENCE_LOG_THRESHOLD_MS = 5 * 60 * 1000;

let candidateHandler = null;
let ws = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_DELAY_MS;
let monitorTimer = null;
let healthTimer = null;
let stopped = false;
let lastConnectedAt = null;
let lastEventAt = null;
let lastDisconnectAt = null;
let lastDisconnectCode = null;
let disconnectAlertSent = false;
let seenTokens = new Map(); // mint → timestamp (dedup within 1 hour)
const trackedTokens = new Map(); // mint → { mint, symbol, createdAt, lastCheckedAt, gmgnInfo, originalData, consecutiveErrors }

// Pattern detection: track creation events for timing analysis
const tokenCreatedAt = new Map(); // mint → timestamp of 'create' event

export function setCandidateHandler(fn) {
  candidateHandler = fn;
}

function scheduleReconnect() {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 1.5, MAX_RECONNECT_MS);
    startPumpportal();
  }, reconnectDelay);
}

const bondingCurveCycle = singleFlight(checkBondingCurve);

function startMonitor() {
  if (monitorTimer) return;
  monitorTimer = setInterval(() => {
    bondingCurveCycle().catch(err => console.log(`[pumpportal] monitor error: ${err.message}`));
  }, MONITOR_INTERVAL_MS);
}

function stopMonitor() {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
}

function fmtHuman(ts) {
  return ts ? new Date(ts).toISOString() : 'never';
}

export function getPumpportalHealth() {
  const t = now();
  return {
    connected: ws !== null && ws.readyState === 1,
    lastConnectedAt,
    lastEventAt,
    lastDisconnectAt,
    uptimeMs: lastConnectedAt ? t - lastConnectedAt : null,
    eventGapMs: lastEventAt ? t - lastEventAt : null,
  };
}

function checkHealth() {
  const t = now();
  const connected = ws !== null && ws.readyState === 1;

  // a) Disconnect >5min → telegram alert (once per outage)
  if (lastDisconnectAt !== null && !connected) {
    const downMs = t - lastDisconnectAt;
    if (downMs > DISCONNECT_ALERT_THRESHOLD_MS && !disconnectAlertSent) {
      const code = lastDisconnectCode ?? '?';
      sendTelegram(
        `🚨 [pumpportal] DOWN >5min — disconnected at ${fmtHuman(lastDisconnectAt)}, code=${code}. Reconnects failing. Bot blind to new tokens.`
      ).catch(err => console.log(`[pumpportal] alert telegram failed: ${err.message}`));
      disconnectAlertSent = true;
    }
  }

  // b) Connected but silent >5min → console warn only
  if (connected && lastEventAt !== null) {
    const gap = t - lastEventAt;
    if (gap > EVENT_SILENCE_LOG_THRESHOLD_MS) {
      console.log(`[pumpportal] silent >5min — WS connected but no events (last: ${fmtHuman(lastEventAt)})`);
    }
  }
}

function startHealthMonitor() {
  if (healthTimer) return;
  healthTimer = setInterval(() => {
    try {
      checkHealth();
    } catch (err) {
      console.log(`[pumpportal] health check error: ${err.message}`);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthMonitor() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

async function handleNewToken(data) {
  const mint = data?.mint;
  if (!mint) return;

  // Dedup: skip if seen within 1 hour
  if (seenTokens.has(mint)) return;
  seenTokens.set(mint, now());
  const cutoff = now() - 3600000;
  for (const [k, v] of seenTokens) {
    if (v < cutoff) seenTokens.delete(k);
  }

  // Pattern detection: track creation time
  tokenCreatedAt.set(mint, now());
  // Cleanup old entries (keep max 1000)
  if (tokenCreatedAt.size > 1000) {
    const cutoff = now() - 3600000;
    for (const [k, v] of tokenCreatedAt) {
      if (v < cutoff) tokenCreatedAt.delete(k);
    }
  }

  console.log(`[pumpportal] new token: ${data.symbol || data.name || mint.slice(0, 8)} (${mint.slice(0, 8)}...)`);

  // Limit tracked tokens to 50 max — drop oldest if needed
  if (trackedTokens.size >= MAX_TRACKED_TOKENS) {
    let oldestMint = null;
    let oldestCreatedAt = Infinity;
    for (const [k, v] of trackedTokens) {
      if (v.createdAt < oldestCreatedAt) {
        oldestCreatedAt = v.createdAt;
        oldestMint = k;
      }
    }
    if (oldestMint) {
      const dropped = trackedTokens.get(oldestMint);
      trackedTokens.delete(oldestMint);
      console.log(`[pumpportal] dropping oldest tracked token ${dropped.symbol || oldestMint.slice(0, 8)} (capacity reached)`);
    }
  }

  // Add to tracking map — do NOT trigger candidate yet (mcap too low for bonding-curve tokens)
  trackedTokens.set(mint, {
    mint,
    symbol: data.symbol || data.name || mint.slice(0, 8),
    createdAt: now(),
    lastCheckedAt: 0,
    gmgnInfo: null,
    originalData: data,
    consecutiveErrors: 0,
  });
}

function buildGraduatedCoin(mint, symbol, gmgnInfo, originalData, patternFlags = []) {
  const marketCap = Number(gmgnInfo?.market_cap ?? gmgnInfo?.mcap ?? 0) || null;
  const holderCount = Number(gmgnInfo?.holder_count ?? 0) || null;
  const liquidity = Number(gmgnInfo?.liquidity ?? 0) || null;
  return {
    coinMint: mint,
    name: originalData?.name || gmgnInfo?.name || '',
    ticker: symbol || gmgnInfo?.symbol || '',
    marketCap: null,
    usd_market_cap: marketCap,
    numHolders: holderCount,
    liquidity: liquidity,
    graduationDate: now(),
    seenAt: now(),
    detectedAt: now(),
    uri: originalData?.uri || null,
    source: 'pumpportal',
    gmgnInfo,
    patternFlags,
  };
}

async function graduateToken(mint, entry) {
  const graduatedCoin = buildGraduatedCoin(mint, entry.symbol, entry.gmgnInfo, entry.originalData, entry.patternFlags || []);

  // Register in graduated map so other modules can reference it
  try {
    const { graduated } = await import('./graduated.js');
    graduated.set(mint, graduatedCoin);
  } catch (err) {
    console.log(`[pumpportal] failed to register in graduated map: ${err.message}`);
  }

  // Store signal event for PNL tracking
  storeSignalEvent(mint, 'pumpportal', 'pumpportal_graduated', { mint, symbol: entry.symbol });

  trackedTokens.delete(mint);

  const mcap = graduatedCoin.usd_market_cap;
  console.log(`[pumpportal] graduated! ${entry.symbol} mcap $${mcap} → triggering candidate`);

  if (candidateHandler) {
    candidateHandler({ mint, graduatedCoin, route: 'pumpportal_graduated' })
      .catch(err => console.log(`[pumpportal] candidate trigger failed for ${mint.slice(0, 8)}: ${err.message}`));
  }
}

async function checkBondingCurve() {
  if (trackedTokens.size === 0) return;

  const cutoff = now() - TRACK_TIMEOUT_MS;
  // Time out old tokens first
  for (const [mint, entry] of trackedTokens) {
    if (entry.createdAt < cutoff) {
      trackedTokens.delete(mint);
      console.log(`[pumpportal] expired: ${entry.symbol} (2h timeout)`);
    }
  }

  let closestMcap = 0;
  let closestSymbol = null;

  for (const [mint, entry] of trackedTokens) {
    const gap = now() - entry.lastCheckedAt;
    if (entry.lastCheckedAt && gap < MIN_CHECK_GAP_MS) continue;

    try {
      const info = await fetchGmgnTokenInfo(mint, false);
      entry.lastCheckedAt = now();
      entry.gmgnInfo = info;
      entry.consecutiveErrors = 0;

      const mcap = Number(info?.market_cap ?? info?.mcap ?? 0) || 0;
      if (mcap > closestMcap) {
        closestMcap = mcap;
        closestSymbol = entry.symbol;
      }

      if (mcap >= GRADUATION_MCAP_USD) {
        await graduateToken(mint, entry);
      } else {
        console.log(`[pumpportal] tracking: ${entry.symbol} (${mint.slice(0, 8)}...) mcap $${mcap}`);
      }
    } catch (err) {
      entry.consecutiveErrors = (entry.consecutiveErrors || 0) + 1;
      entry.lastCheckedAt = now();
      console.log(`[pumpportal] gmgn check failed for ${entry.symbol} (${mint.slice(0, 8)}...): ${err.message} (errors=${entry.consecutiveErrors})`);
      if (entry.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        trackedTokens.delete(mint);
        console.log(`[pumpportal] dropping ${entry.symbol} after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
        continue;
      }
    }

    // Small delay between calls to avoid hammering GMGN
    if (trackedTokens.size > 1) await sleep(POLL_DELAY_MS);
  }

  if (trackedTokens.size > 0) {
    console.log(`[pumpportal] tracking ${trackedTokens.size} tokens, closest: ${closestSymbol || 'n/a'} at $${closestMcap}`);
  }
}

function onMessage(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
    publishOfficeDiscovery(payload);
    officeBroker.publish(payload);
  } catch {
    return;
  }

  // Health tracking: count create/migrate events as "activity"
  if (payload?.txType === 'create' || payload?.txType === 'migrate') {
    lastEventAt = now();
  }

  // DEBUG: log all non-create messages to diagnose migration delivery
  if (payload?.txType && !['create','buy','sell'].includes(payload.txType)) {
    console.log(`[pumpportal] DEBUG txType=${payload.txType} mint=${payload.mint || '?'} keys=${Object.keys(payload).join(',')}`);
  }

  // New token creation (replaces migration — Pump.fun now uses PumpSwap directly)
  if (payload?.txType === 'create') {
    handleNewToken(payload).catch(err => console.log(`[pumpportal] handle error: ${err.message}`));
    return;
  }

  // Migration = token graduated from bonding curve. Trigger immediately.
  if (payload?.txType === 'migrate') {
    const mint = payload.mint;
    if (!mint) return;

    // Always trigger graduation for migration events, even if token was seen as create.
    // Orchestrator has its own 10-min candidate dedup to prevent duplicate processing.
    seenTokens.set(mint, now());

    // Pattern detection: analyze create→migrate timing
    const createdAt = tokenCreatedAt.get(mint);
    const elapsedMs = createdAt ? now() - createdAt : null;
    tokenCreatedAt.delete(mint); // cleanup

    // Flag suspicious patterns
    const patterns = [];
    if (elapsedMs !== null && elapsedMs < 30_000) {
      patterns.push(`fast_migration_${Math.round(elapsedMs / 1000)}s`);
    }

    // Use existing tracked entry if available, otherwise create minimal entry
    const existing = trackedTokens.get(mint);
    const entry = existing || {
      mint,
      symbol: payload.symbol || mint.slice(0, 8),
      createdAt: now(),
      lastCheckedAt: 0,
      gmgnInfo: null,
      originalData: payload,
      consecutiveErrors: 0,
    };

    // Attach pattern flags to entry
    entry.patternFlags = patterns;

    const patternStr = patterns.length > 0 ? ` ⚠️ patterns: ${patterns.join(', ')}` : '';
    console.log(`[pumpportal] 🚀 MIGRATION EVENT — ${entry.symbol} (${mint.slice(0, 8)}...) → triggering graduation${patternStr}`);

    graduateToken(mint, entry).catch(err =>
      console.log(`[pumpportal] graduation failed for ${mint.slice(0, 8)}: ${err.message}`)
    );
  }
}

function onOpen() {
  console.log('[pumpportal] connected');
  reconnectDelay = RECONNECT_DELAY_MS; // reset backoff on successful connect
  const ts = now();
  const wasDisconnected = lastDisconnectAt !== null;
  const outageMs = wasDisconnected ? ts - lastDisconnectAt : null;
  lastConnectedAt = ts;
  lastDisconnectAt = null;
  lastDisconnectCode = null;

  // Recovery alert if we previously sent a disconnect alert
  if (disconnectAlertSent && outageMs !== null) {
    const mins = Math.round(outageMs / 60_000);
    sendTelegram(`✅ [pumpportal] RECOVERED — back online after ${mins}min outage`)
      .catch(err => console.log(`[pumpportal] recovery telegram failed: ${err.message}`));
  }
  disconnectAlertSent = false;

  // Subscribe to new token creation (free tier)
  ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
  // Also subscribe to migration in case PumpPortal re-enables it
  ws.send(JSON.stringify({ method: 'subscribeMigration' }));
  officeBroker.attach(ws);
}

function connect() {
  if (stopped) return;
  ws = new WebSocket(WS_URL);

  ws.on('open', onOpen);
  ws.on('message', onMessage);

  ws.on('error', (err) => {
    console.log(`[pumpportal] error: ${err.message}`);
  });

  ws.on('close', (code, reason) => {
    officeBroker.disconnect();
    console.log(`[pumpportal] disconnected (code=${code})`);
    if (lastDisconnectAt === null) {
      lastDisconnectAt = now();
      lastDisconnectCode = code;
    }
    ws = null;
    // Clear monitor timer so startPumpportal() won't bail out on reconnect
    stopMonitor();
    if (!stopped) scheduleReconnect();
  });
}

export function startPumpportal() {
  if ((ws || monitorTimer) || stopped) return;
  if (!PUMPPORTAL_ENABLED) {
    console.log('[pumpportal] disabled (PUMPPORTAL_ENABLED=false)');
    return;
  }
  if (!PUMPPORTAL_API_KEY) {
    console.log('[pumpportal] no API key — skipping');
    return;
  }
  stopped = false;
  startOfficeBroker();
  startMonitor();
  startHealthMonitor();
  connect();
}

export function stopPumpportal() {
  officeBroker.disconnect();
  stopped = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  stopMonitor();
  stopHealthMonitor();
  if (ws) {
    ws.removeAllListeners();
    ws.close();
    ws = null;
  }
}
