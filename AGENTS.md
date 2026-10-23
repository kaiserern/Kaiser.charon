# Charon — Solana Pump.fun Trading Bot

> Fork by [Kai](https://github.com/kaiserern) dari [yunus-0x/charon](https://github.com/yunus-0x/charon). Bot Telegram buat screening & trading token pump.fun via Jupiter. Support dry run (paper), confirm (approve button), dan live execution.

## Arsitektur
```
SIGNAL SOURCES (pilih salah satu/semua):
├── Signal Server (api.thecharon.xyz) — HTTP polling, token fresh
├── PumpPortal WebSocket — real-time graduated + pre-grad token
├── GMGN Trending — trending 5m/1h/6h/24h
├── GMGN Trenches — bonding curve tokens
├── Pump.fun Pregrad — scanner pre-graduation
├── Fee Claims — token yg barusan claim fee
└── GMGN Signals + Smart Money

PIPELINE (setiap token):
  Signal → buildCandidate() → enrichment (GMGN/Jupiter/Twitter)
  → filterCandidate() → preScoreCandidate() → momentumFilter()
  → LLM batch decision → WATCH/PASS/BUY
  → createDryRunPosition() / createLivePosition()

EXECUTION (looping):
  monitorPositions() → quote exit / mark exit / TP / SL / trailing
  → close position → log ke DB → send exit card Telegram
```

## Prasyarat
- **Node.js 20+** (gw pake 22)
- **Native build tools**: `build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`
- **Systemd** (buat production supervisor) atau pm2

## Quick Start (5 menit)

```bash
# 1. Clone
git clone https://github.com/kaiserern/Kaiser.charon.git
cd Kaiser.charon

# 2. Install
npm install
# Kalo gagal di better-sqlite3/canvas → install build tools dulu (lihat Prasyarat)

# 3. Setup env
cp .env.example .env
nano .env

# 4. Check syntax
npm run check

# 5. Run
npm start
```

## .env Minimal untuk Dry Run
```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF1234gh
TELEGRAM_CHAT_ID=<your_chat_id>

SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=your_signal_key_here

HELIUS_API_KEY=your_helius_key
# atau:
# SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=KEY
# SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=KEY

# Dry run default — ga butuh wallet
TRADING_MODE=dry_run
MAX_OPEN_POSITIONS=3

# LLM — endpoint OpenAI-compatible
ENABLE_LLM=true
LLM_BASE_URL=https://api.minimax.io/v1
LLM_API_KEY=your_llm_key
LLM_MODEL=MiniMax-M2.7
```

## Konfigurasi
**Dua tempat setting:**
1. **`.env`** — API keys, RPC URLs, mode. Restart bot kalo ganti.
2. **SQLite (`charon.sqlite`)** — semua parameter strategi. **Hot-reload**, ganti via Telegram `/menu` tanpa restart.

Strategy parameters yang sering di-tune:
- `position_size_sol` — size per entry
- `tp_percent` / `sl_percent` — take profit / stop loss
- `trailing_enabled` / `trailing_percent` — trailing stop
- `max_open_positions` — max concurrent positions
- `llm_min_confidence` — threshold confidence LLM untuk BUY
- `momentum_threshold` — threshold ML momentum filter (0.0-1.0)
- `min_mcap_usd` / `max_mcap_usd` — market cap bounds

## 4 Strategi Bawaan
| Strategi | Mode Entry | LLM | Kapan dipake |
|---|---|---|---|
| **Sniper** (default) | immediate | ✅ | Token fresh graduate, fast entry |
| **Dip Buy** | wait_for_dip | ✅ | Token trending turun, beli pas koreksi |
| **Smart Money** | immediate | ✅ | Multi-source confirmation, higher confidence |
| **Degen** | immediate | ❌ | Low cap, high volume, full auto |

Aktifkan strategi via SQLite: `UPDATE strategies SET enabled = 1 WHERE id = 'sniper'`

## Pipeline Detail

### 1. Signal Sources
Semua sumber sinyal dikonversi ke objek `signals` seragam:
```js
{ mint, route, hasFeeClaim, hasGraduated, hasTrending, ... }
```
Satu token bisa masuk dari multiple source → dedup via `seenSignalCandidates` + DB check.

### 2. buildCandidate()
Enrichment paralel: GMGN (holder count, total fees, dev info) + Jupiter (price, mcap, holders, chart) + Twitter narrative + saved wallets.

### 3. filterCandidate()
Gate wajib sebelum LLM. Cek: mcap, holders, fee claim, max holder %, ATH distance, rug ratio, bundler rate. Parameter diatur per-strategi. Candidate yg gagal → status `filtered` + alasan.

### 4. preScoreCandidate() + momentumFilter()
Pre-scoring 0-100 (mcap growth, volume, holder growth, age). ML momentum model `predict_momentum.py` — opsional, skip kalo model ga ada.

### 5. LLM Batch Decision
Ngumpulin candidate sampe `llm_candidate_pick_count` atau `llm_candidate_max_age_ms` → batch call LLM. Return: BUY/WATCH/PASS + confidence + reason + suggested TP/SL.

Cache: BUY decisions gak diproses ulang dalam 10 menit, WATCH/PASS dalam 60 menit. Invalidasi kalo mcap berubah >20% atau holders >30%.

Blocked routes: `dual_source`, `fee_graduated_trending`, `graduated_trending` (Lesson #3 — consistently unprofitable).

### 6. Position Creation
- **Dry run**: `dry_run_positions` table, simulate buy + track HWM
- **Confirm**: Kirim approve/reject button ke Telegram
- **Live**: Execute swap via Jupiter `/swap/v2/order`, broadcast tx

### 7. Position Monitoring
Loop `POSITION_CHECK_MS` (default 10s):
- Track HWM (high water mark)
- Trailing stop: arm pas > trailing_percent profit, narrow pas > peak threshold
- Quote-first exit (dry run): harga dari Jupiter quote, bukan mark
- Stop loss, take profit, max hold time
- Exit → close position → send exit card Telegram

## Live Execution
Kalo mau live, tambahin di `.env`:
```bash
TRADING_MODE=live
SOLANA_PRIVATE_KEY=[1,2,3,...]  # atau base58 string
JUPITER_API_KEY=your_jupiter_key
```

Gunakan wallet terpisah yg isinya cuma modal trading. Jangan nyampur sama main wallet.

## Systemd Service
```ini
# /etc/systemd/system/charon.service
[Unit]
Description=Charon Trading Bot
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/projects/charon
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=10
StandardOutput=append:/home/ubuntu/projects/charon/charon.log
StandardError=append:/home/ubuntu/projects/charon/charon.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable charon --now
sudo journalctl -u charon -f
```

## Commands Telegram
- `/menu` — main menu (strategi, setting, positions, backtest)
- `/positions` — list all open positions
- `/daily` — daily PnL report
- `/settings` — view/edit semua parameter strategi
- `/status` — bot stats (uptime, candidates, LLM usage)
- `/pause` / `/resume` — pause/resume trading

## Directories
```
charon/
├── src/
│   ├── app.js           # Main orchestration
│   ├── config.js         # Env + constants
│   ├── pipeline/         # Enrich → filter → LLM → position
│   ├── execution/        # Position monitor + Jupiter router
│   ├── signals/          # Semua signal sources
│   ├── enrichment/       # GMGN, Jupiter, Twitter, wallets
│   ├── db/               # SQLite connection, queries
│   ├── telegram/         # Bot commands, send, format, cards
│   ├── visuals/          # Canvas card rendering
│   ├── learning/         # Auto-learning + lesson system
│   └── liveExecutor.js   # Wallet + RPC connection
├── migrations/           # SQL migrations
├── scripts/              # Backtest + analysis scripts
├── backtest/             # Backtest results + reports
├── models/               # ML models (momentum_model.pkl)
└── logs/                 # Logs
```

## Troubleshooting
| Masalah | Cek |
|---|---|
| `better-sqlite3` / `canvas` gagal build | Install native deps (lihat Prasyarat) |
| `TELEGRAM_BOT_TOKEN is required` | `.env` ada? `TELEGRAM_BOT_TOKEN` terisi? |
| Bot start tapi ga ada sinyal | `SIGNAL_SERVER_KEY` valid? Cek log `[bot]` |
| LLM ga manggil | `ENABLE_LLM=true`? `LLM_API_KEY` ada? |
| GMGN error | Rate limit — jangan turunin `GMGN_REQUEST_DELAY_MS` di bawah 2500 |
| Dry run jalan tapi PnL jelek | It works as designed — paper fills ga kena slippage. Live bakal 20-50% worse |
| `quote-first` exit error 429 | Jupiter rate limit — fallback ke mark price |
| DB locked / slow | WAL mode udah on? `journal_mode = WAL` |

## Honest notes
- Trading memecoin = high risk. Most go to zero. Edge bot ini: 1-2 good runners nutupin 7-8 small losses.
- `dry_run` PnL looks better than reality — paper execution ga kena slippage atau sandwich.
- Jangan commit `.env`. Udah di-gitignore.
- Fork ini di-maintain pribadi, bukan produk. Kerja → untung; ga kerja → ya udah.
- Ini bukan sinyal grup, bukan financial advice.
