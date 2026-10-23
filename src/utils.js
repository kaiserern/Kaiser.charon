export function now() {
  return Date.now();
}

export function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function json(value) {
  return JSON.stringify(value ?? null);
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim();
}

export function pruneSeen(map, ttlMs) {
  const at = now();
  for (const [key, ts] of map) {
    if (at - ts > ttlMs) map.delete(key);
  }
}

export function firstPositiveNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function gmgnPriceValue(info) {
  // GMGN returns `price` as an object keyed by window ({"price": "0.0093", "buys_1m": ...}),
  // so Number(info.price) is NaN for every live token. Unwrap the nested value.
  const raw = info?.price;
  const candidate = raw && typeof raw === 'object' ? raw.price ?? raw.price_usd : raw;
  const value = Number(candidate);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function marketCapFromGmgn(info) {
  const direct = Number(info?.market_cap ?? info?.mcap);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const price = gmgnPriceValue(info);
  const supply = Number(info?.circulating_supply ?? info?.total_supply);
  if (price && Number.isFinite(supply) && supply > 0) return price * supply;
  const migrated = Number(info?.migration_market_cap);
  return Number.isFinite(migrated) && migrated > 0 ? migrated : null;
}

export function tokenPriceFromGmgn(info) {
  return gmgnPriceValue(info);
}

export function base58Encode(bytes) {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = [0];
  for (const b of bytes) {
    let carry = b;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  for (const b of bytes) {
    if (b !== 0) break;
    digits.push(0);
  }
  return digits.reverse().map(x => alphabet[x]).join('');
}

export function readPubkey(buf, offset) {
  return base58Encode(buf.subarray(offset, offset + 32));
}

export function readU64(buf, offset) {
  return buf.readBigUInt64LE(offset);
}

export function readI64(buf, offset) {
  return buf.readBigInt64LE(offset);
}

export function lamToSol(lamports) {
  return Number(lamports) / 1_000_000_000;
}

export function discMatch(buf, disc) {
  return disc.every((b, i) => buf[i] === b);
}

export function parseDistFees(data) {
  let offset = 8;
  const timestamp = readI64(data, offset); offset += 8;
  const mint = readPubkey(data, offset); offset += 32;
  const bondingCurve = readPubkey(data, offset); offset += 32;
  const sharingConfig = readPubkey(data, offset); offset += 32;
  const admin = readPubkey(data, offset); offset += 32;
  const count = data.readUInt32LE(offset); offset += 4;
  const shareholders = [];
  for (let i = 0; i < count && offset + 34 <= data.length; i++) {
    const pubkey = readPubkey(data, offset); offset += 32;
    const bps = data.readUInt16LE(offset); offset += 2;
    shareholders.push({ pubkey, bps });
  }
  const distributed = data.length >= offset + 8 ? readU64(data, offset) : 0n;
  return { timestamp, mint, bondingCurve, sharingConfig, admin, shareholders, distributed };
}

export function strictJsonFromText(text) {
  const clean = stripThinking(text);
  const fenced = clean.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = fenced || clean.match(/\{[\s\S]*\}/)?.[0] || clean;
  return JSON.parse(raw);
}

export function parseNumericInput(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[$,%\s,_]/g, '');
  if (raw === 'off' || raw === 'none' || raw === 'disable') return 0;
  const match = raw.match(/^(-?\d+(?:\.\d+)?)([kmb])?$/);
  if (!match) return null;
  const multipliers = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };
  const parsed = Number(match[1]) * (multipliers[match[2]] || 1);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseWindowMs(value = '12h') {
  const raw = String(value || '12h').trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(m|h|d)?$/);
  if (!match) return 12 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2] || 'h';
  const multipliers = { m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 };
  return Math.max(5 * 60_000, Math.min(30 * 24 * 60 * 60_000, amount * multipliers[unit]));
}

export function formatWindow(ms) {
  if (ms % (24 * 60 * 60_000) === 0) return `${ms / (24 * 60 * 60_000)}d`;
  if (ms % (60 * 60_000) === 0) return `${ms / (60 * 60_000)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

export function makeFailureTracker(name, alertFn, threshold = 3) {
  let count = 0;
  return async (fn) => {
    try {
      await fn();
      count = 0;
    } catch (err) {
      count++;
      console.log(`[${name}] ${err.message}`);
      if (count >= threshold) {
        alertFn(`⚠️ <b>${name}</b> failed ${count}x in a row: ${err.message}`).catch(() => {});
        count = 0;
      }
    }
  };
}

function trueRange(candle) {
  const high = Number(candle?.high);
  const low = Number(candle?.low);
  const prevClose = Number(candle?.prevClose ?? candle?.close);
  if (!Number.isFinite(high) || !Number.isFinite(low)) return null;
  if (Number.isFinite(prevClose)) {
    return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
  }
  return high - low;
}

export function computeAtrPercent(chartWindows = [], period = 14) {
  const windows = Array.isArray(chartWindows) ? chartWindows : [];
  for (const window of windows) {
    const candles = Array.isArray(window?.candles) ? window.candles : null;
    if (!candles || candles.length < 3) continue;
    const rawCandles = candles.map(c => ({
      high: Number(c?.h ?? c?.high),
      low: Number(c?.l ?? c?.low),
      close: Number(c?.c ?? c?.close),
    }));
    for (let i = 0; i < rawCandles.length; i++) {
      rawCandles[i].prevClose = i === 0 ? null : rawCandles[i - 1].close;
      const tr = trueRange(rawCandles[i]);
      rawCandles[i].tr = tr != null ? tr : 0;
    }
    const lastN = rawCandles.slice(-period);
    const atr = lastN.reduce((sum, candle) => sum + Number(candle.tr || 0), 0) / lastN.length;
    const lastClose = rawCandles[rawCandles.length - 1]?.close;
    if (atr > 0 && Number.isFinite(lastClose) && lastClose > 0) {
      return (atr / lastClose) * 100;
    }
  }
  return null;
}

export function dynamicStopLossPercent({ baseSlPercent, atrPercent, multiplier = 1.5, floorPercent = -50, ceilingPercent = -8, minAtrPercent = 4, maxAtrPercent = 30 }) {
  const base = Number(baseSlPercent);
  if (!Number.isFinite(base)) return -25;
  if (!Number.isFinite(Number(atrPercent)) || Number(atrPercent) <= 0) {
    return Math.max(floorPercent, Math.min(ceilingPercent, base));
  }
  const boundedAtr = Math.max(minAtrPercent, Math.min(maxAtrPercent, Number(atrPercent)));
  const dynamic = -boundedAtr * multiplier;
  return Math.max(floorPercent, Math.min(ceilingPercent, dynamic));
}
