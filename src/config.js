import dotenv from 'dotenv';

dotenv.config();

export const APP_NAME = 'Charon';
export const DB_PATH = process.env.DB_PATH || './charon.sqlite';
export const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
export const DISC_DIST_FEES = Buffer.from('a537817004b3ca28', 'hex');
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const SOL_MINT = 'So11111111111111111111111111111111111111111';

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
export const TELEGRAM_TOPIC_ID = process.env.TELEGRAM_TOPIC_ID;
export const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
export const GMGN_API_KEY = process.env.GMGN_API_KEY;
export const GMGN_ENABLED = process.env.GMGN_ENABLED !== 'false';
export const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
export const SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY || process.env.PRIVATE_KEY || '';
export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const SOLANA_WS_URL = process.env.SOLANA_WS_URL || `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
export const JUPITER_SWAP_BASE_URL = process.env.JUPITER_SWAP_BASE_URL || 'https://api.jup.ag/swap/v2';
export const JUPITER_SLIPPAGE_BPS = Number(process.env.JUPITER_SLIPPAGE_BPS || 300);
export const LIVE_MIN_SOL_RESERVE_LAMPORTS = Math.floor(Number(process.env.LIVE_MIN_SOL_RESERVE || 0.02) * 1_000_000_000);

// Freshness gate live entry: batalkan BUY kalau harga fill (dari quote Jupiter) menyimpang
// lebih dari N% di atas harga sinyal. 0 / negatif = gate nonaktif. Default 3%.
export const ENTRY_FRESHNESS_GATE_PCT = Number(process.env.ENTRY_FRESHNESS_GATE_PCT ?? 3);
// TTL cache fetchJupiterAsset untuk fast-path freshly graduated (pumpportal_graduated).
// Dulu 20s -> harga sinyal basi sampai 20s. Default 2s.
export const JUPITER_ASSET_FRESH_TTL_MS = Number(process.env.JUPITER_ASSET_FRESH_TTL_MS ?? 2000);
// Shadow mode: kalau true, freshness gate hanya mencatat (console log) tanpa memblokir BUY.
// Dipakai untuk validasi drift di live sebelum enforce. Default false.
export const ENTRY_FRESHNESS_GATE_SHADOW = process.env.ENTRY_FRESHNESS_GATE_SHADOW === 'true';
export const LLM_BASE_URL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1';
export const LLM_API_KEY = process.env.LLM_API_KEY || '';
export const LLM_MODEL = process.env.LLM_MODEL || 'MiniMax-M2.7';
export const LLM_MODEL_CHEAP = process.env.LLM_MODEL_CHEAP || '';
export const LLM_BASE_URL_CHEAP = process.env.LLM_BASE_URL_CHEAP || '';
export const LLM_API_KEY_CHEAP = process.env.LLM_API_KEY_CHEAP || '';
export const LLM_OPENROUTER_MODEL = process.env.LLM_OPENROUTER_MODEL || '';
export const LLM_OPENROUTER_API_KEY = process.env.LLM_OPENROUTER_API_KEY || '';
// Tertiary fallback: Zyloo (OpenAI-compatible gateway, catches any retryable error not just 402/401)
// Docs: https://zyloo.io/docs — base URL https://zyloo.io/v1
export const LLM_FALLBACK_BASE_URL = process.env.LLM_FALLBACK_BASE_URL || '';
export const LLM_FALLBACK_API_KEY = process.env.LLM_FALLBACK_API_KEY || '';
export const LLM_FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL || '';

export const GRADUATED_POLL_MS = Number(process.env.GRADUATED_POLL_MS || 30_000);
export const GRADUATED_LOOKBACK_MS = Number(process.env.GRADUATED_LOOKBACK_MS || 2 * 60 * 60 * 1000);
export const TRENDING_POLL_MS = Number(process.env.TRENDING_POLL_MS || 60_000);
export const TRENDING_LOOKBACK_MS = Number(process.env.TRENDING_LOOKBACK_MS || 10 * 60 * 1000);
export const GMGN_CACHE_TTL_MS = Number(process.env.GMGN_CACHE_TTL_MS || 5 * 60 * 1000);
export const POSITION_CHECK_MS = Number(process.env.POSITION_CHECK_MS || 10_000);
// Reduced from 60s — tokenrouter MiniMax-M3 normal response is 1-8s; 25s cap = hard upper bound on slow model hangs. LLM call was the biggest single delay in buy pipeline.
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 25_000);
export const ENABLE_LLM = process.env.ENABLE_LLM !== 'false';
export const SIGNAL_SERVER_URL = process.env.SIGNAL_SERVER_URL || '';
export const SIGNAL_SERVER_KEY = process.env.SIGNAL_SERVER_KEY || '';
export const SIGNAL_POLL_MS = Number(process.env.SIGNAL_POLL_MS || 30_000);
export const PUMPPORTAL_API_KEY = process.env.PUMPPORTAL_API_KEY || '';
export const PUMPPORTAL_ENABLED = process.env.PUMPPORTAL_ENABLED !== 'false';
export const PREGRAD_POLL_MS = Number(process.env.PREGRAD_POLL_MS || 12_000);
export const PREGRAD_LOOKBACK_MS = Number(process.env.PREGRAD_LOOKBACK_MS || 30 * 60 * 1000);
export const PREGRAD_ENABLED = process.env.PREGRAD_ENABLED !== 'false';
export const PREGRAD_MIN_RSSR_SOL = Number(process.env.PREGRAD_MIN_RSSR_SOL || 76.5);
export const PREGRAD_MAX_RSSR_SOL = Number(process.env.PREGRAD_MAX_RSSR_SOL || 85);
export const PREGRAD_MAX_AGE_MS = Number(process.env.PREGRAD_MAX_AGE_MS || 12 * 60 * 60 * 1000);
export const PREGRAD_MAX_ATH_MULTIPLE = Number(process.env.PREGRAD_MAX_ATH_MULTIPLE || 1.2);

export const JSON_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

export function validateConfig() {
  if (!TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required.');
  if (!TELEGRAM_CHAT_ID) throw new Error('TELEGRAM_CHAT_ID is required.');
  if (!HELIUS_API_KEY && (!process.env.SOLANA_RPC_URL || !process.env.SOLANA_WS_URL)) {
    throw new Error('HELIUS_API_KEY is required unless SOLANA_RPC_URL and SOLANA_WS_URL are set.');
  }
  if (GMGN_ENABLED && !GMGN_API_KEY) throw new Error('GMGN_API_KEY is required unless GMGN_ENABLED=false.');
}
