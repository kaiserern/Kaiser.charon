# Kaiser.Charon

A working fork of [Charon](https://github.com/yunus-0x/charon) by [@yunus-0x](https://github.com/yunus-0x). All credit for the original idea and codebase goes to him — I just kept changing things while running it, and at some point the diff got big enough that it needed its own home.

Charon is a Telegram bot that screens Solana pump.fun tokens, runs them through strategy filters, optionally asks an LLM to pick entries, and trades via Jupiter. Three modes: `dry_run` (paper trading into SQLite), `confirm` (Telegram approve/reject buttons), and `live` (real swaps, real money, real regret potential).

> **Read the [Notes](#notes) section before trusting any PnL number this thing prints.** Dry-run PnL is only as honest as the quotes feeding it, and for a while mine weren't.

## What changed in this fork

- **FLOW filter** — candidates need `s1h_priceChange >= 0` and `net_buyer_ratio_5m >= 0.2` before they enter the pipeline. Cut a lot of dying-chart entries.
- **PumpPortal WebSocket source** — real-time graduated-token stream instead of polling. Also feeds the pre-graduation scanner.
- **Pre-grad scanner** — optional module that watches tokens before they hit the bonding curve cap.
- **GMGN signed auth** — enrichment calls use Ed25519-signed requests against GMGN's API for holder counts, fees, and socials.
- **Trailing TP guard** — trailing take-profit no longer triggers on underwater positions. It used to "lock in profits" at a loss. Fixed.
- **Tightened exit logic** — trailing stop narrows once a position clears a peak threshold, with a profit floor after arming. Reduces giving back runners.
- **Fill-to-fill dry run pricing (`quote-paper-2.0`)** — paper entries use an executable Jupiter buy quote and exits use executable Jupiter sell quotes, instead of synthetic mark prices. Recorded PnL includes the simulated entry/exit fill difference and execution fees, so dry-run results track live execution more closely.
- **Telegram reports + visual cards** — daily PnL reports and rendered entry/exit cards.
- **Backtest tooling** — scripts that run filter candidates against local trade history so changes get measured before they get deployed.
- **Live execution hardening** — realized PnL tracking, sell guards, Jupiter Ultra routing.

## Fix log — 2026-10-23

A sustained bleed (17 red days, win rate down to ~36%) traced back to plumbing, not to the strategy being "unlucky". Everything below is deployed and verified on the running instance.

**Jupiter quotes**

- Execution and spot quotes moved off the unauthenticated `lite-api.jup.ag` endpoint onto `api.jup.ag` with `x-api-key` from the environment. The old endpoint was answering HTTP 429 roughly 2,130 times a day.
- The 429 handler used to trip a **global 30-second backoff** on every rate-limit hit, so one busy token froze quoting for the whole bot. Replaced with per-request pacing and a 10s cap.
- Measured after the switch: **0 × 429**, down from ~28% of the day with quoting disabled.

**Position monitoring**

- `refreshPosition()` used to `return` early when a sell quote was unavailable, leaving `pnl_percent` NULL — which meant **stop loss, trailing TP and max-hold never evaluated**. Positions just sat there until the market decided the outcome.
- Stale-quote exits now fall back to a mark valuation (`valuationStatus='mark_fallback'`) and still evaluate every exit rule. Exits that cannot be quoted are closed and labelled, not silently abandoned.
- Effect: stop-loss realisation moved from an average **−27.2%** (config said −20%) to **−20.3 / −20.6%** on live trades after the fix.

**Entry gate**

- `delayedQuote()` demanded two fresh executable quotes 2s apart, which is a fine idea — except freshly graduated `*pump` mints often aren't indexed by Jupiter yet. That killed **714 entry attempts per day** with `reference_quote_missing_or_stale` and left the `pumpportal_graduated` route converting only ~1.5% of candidates (15 positions out of 974 in a week).
- The gate now retries fresh graduates (3 attempts, 700ms apart) before rejecting.

**Signal ingress**

- `trending_enabled=false` only disabled the internal GMGN poller. Candidates for `single_source` / `graduated_trending` still arrived through the signal server and were traded anyway.
- The flag is now enforced at the `serverClient` ingress, so blocked routes cannot slip in sideways.

**pump.fun behind Cloudflare**

- Both `frontend-api-v3.pump.fun` REST routes (pre-graduation scan and graduation detection) started answering `403 Just a moment` — permanent, not rate limiting. That silently disabled two signal sources.
- They now fall back to a local headless-Chromium sidecar (`src/enrichment/cfFetch.js` → `http://127.0.0.1:8799/fetch`). The daemon is a separate systemd unit on loopback only, with a host allowlist.

**GMGN market cap**

- GMGN returns `price` as an **object** (`{ price: "0.0093", price_1m, buys_1m, volume_24h }`). `Number(info.price)` was therefore NaN for every live mint, so market cap resolved to `0` and the pumpportal graduation check (`mcap >= threshold`) could never fire.
- Both `marketCapFromGmgn` and `tokenPriceFromGmgn` now unwrap the nested object, fall back to `migration_market_cap`, and are covered by regression tests.

**Config drift**

- `max_open_positions` disagreed across `.env`, the active strategy, and the `settings` table (3 / 5 / 15). The bot used 15, which multiplied Jupiter polling and fed the 429 problem. Now 5 everywhere.
- `TRENDING_ENABLED` in `.env` disagreed with `trending_enabled` in `settings`. Aligned.

**Infrastructure**

- `dry_run_trades(position_id)` had no index. The Degen Office bridge query took >60s, hit the systemd `TimeoutStartSec=15`, and the unit failed on every run. Added the index (query now ~0.5s) and raised the timeout to 120s.
- `charon.log` had no rotation (351 MB and climbing on a 92%-full disk). Added `/etc/logrotate.d/charon` (daily, 7 rotations, 200 MB cap, `copytruncate`).

## Architecture

```
SIGNAL SOURCES
├── Signal Server (api.thecharon.xyz)  HTTP polling
├── PumpPortal WebSocket              real-time create/migrate events
├── GMGN Trending / Trenches          trending + bonding curve
├── pump.fun pregrad                  scanner before graduation (Cloudflare sidecar)
└── Fee claims / smart money

PIPELINE
  signal → buildCandidate() → enrichment (GMGN, Jupiter, Twitter)
  → filterCandidate() → preScore() → momentumFilter()
  → LLM batch decision (WATCH / PASS / BUY)
  → dry-run position | Telegram confirm | live swap

EXECUTION LOOP
  monitorPositions() → Jupiter sell quote (fill-to-fill)
  → SL / TP / trailing / max-hold → close → SQLite → Telegram card
```

## Requirements

- **Node.js 20+** (tested on 22)
- Native build tools: `build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`
- A **Telegram bot token** and your chat ID.
- A **signal server key** — see the [original repo](https://github.com/yunus-0x/charon) for access.
- A **Helius RPC endpoint** (free tier is fine for `dry_run`).
- For `live` mode only: a **Solana wallet private key** and a **Jupiter API key**.

## Setup

```bash
git clone https://github.com/kaiserern/Kaiser.charon.git
cd Kaiser.charon
npm install
cp .env.example .env
# fill in .env — at minimum: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
# SIGNAL_SERVER_KEY, HELIUS_API_KEY / SOLANA_RPC_URL
npm run check   # syntax check before first boot
npm test        # offline test suite, no network or keys required
npm start
```

The SQLite database is created automatically at `DB_PATH` on first run. Nothing else to provision.

If `npm install` fails on `better-sqlite3` or `canvas`, it's the native build — install the build tools listed above and retry.

### Optional: pump.fun Cloudflare sidecar

If your host gets `403` from `frontend-api-v3.pump.fun`, the pregrad scanner and graduation detection cannot reach the REST API directly. They fall back to a tiny local HTTP daemon that fetches through a headless Chromium instance.

```bash
python3 -m venv /opt/charon-cf/venv
/opt/charon-cf/venv/bin/pip install playwright==1.63.0
/opt/charon-cf/venv/bin/playwright install chromium
# then run /opt/charon-cf/fetchd.py under systemd (loopback only)
```

The daemon binds `127.0.0.1:8799`, serves `GET /fetch?url=<target>` with a host allowlist, and holds no credentials or wallet keys. Override the address with `CHARON_CF_FETCH_URL` if you run it elsewhere. Without the sidecar the bot still runs — those two routes just stay dark.

## Configuration

`.env.example` documents every environment variable the bot reads. The ones without a default are the ones you actually have to fill in; the rest have sane values already.

Optional subsystems are off by default and stay off until you set their flag:

- `GMGN_ENABLED=true` — enrichment via GMGN (on by default; set `false` to fall back to Jupiter data)
- `PUMPPORTAL_ENABLED=true` — real-time WebSocket signals, needs `PUMPPORTAL_API_KEY`
- `PREGRAD_ENABLED=true` — pre-graduation scanner
- `ENABLE_LLM=true` — LLM entry selection (on by default; needs `LLM_API_KEY`)
- `TRENDING_ENABLED=false` — disables GMGN trending **and** trending candidates arriving from the signal server

Strategy parameters live in SQLite, not `.env`, and are hot-read — most tuning happens from the Telegram chat without restarts. API keys and RPC URLs are env values, so those need a restart.

## Usage

Run it, open Telegram, `/menu`.

Start with `TRADING_MODE=dry_run`. Watch it for a week. Dry-run now uses executable Jupiter quotes for both entry and exit, but it is still an estimate: RPC/API failures can trigger fallbacks and live swaps add wallet state, confirmation, and timing risk. Only then decide if live is worth it.

Useful checks while it runs:

```bash
systemctl status charon
tail -f charon.log | grep -E "429|quote|exit|\[candidate\]"
sqlite3 charon.sqlite "SELECT exit_reason, COUNT(*), ROUND(AVG(pnl_percent),2) FROM dry_run_positions GROUP BY 1;"
```

## Notes

Operational notes I wish someone had written down for me. Read them before drawing conclusions from the numbers.

- **The old +40 SOL "profit" was an artifact.** Before `quote-paper-2.0` (2026-10-06), dry-run PnL was calculated from indexer **mark** prices, not from prices you could actually fill at. It looked great and meant nothing. Anything recorded before that date is not comparable to anything after it — the pricing model changed, not just the market.
- **Fill-to-fill PnL is the only number worth arguing about.** Entry uses an executable buy quote, exit uses an executable sell quote, and fees are simulated. Even this is optimistic against live: real swaps add priority fees, wallet state, confirmation latency, and worse slippage than the quote you saw.
- **Stop loss is a target, not a guarantee.** The bot exits *at* the quote it receives. On thin books the realised number can be a couple of points worse than `sl_percent`. If you see −27% on a −20% stop, that's a plumbing problem (no quote at evaluation time), not a rounding error — that's exactly what was fixed on 2026-10-23.
- **A strategy can be profitable and still be a loser.** Win rate × average win has to beat (1 − win rate) × average loss. At −20% stops and +25% targets you need roughly >45% win rate just to break even. Check the exit-reason breakdown, not just the total.
- **Signal sources are not free.** Each route has its own fee, liquidity and latency profile. A route that worked for months can decay — `pumpportal_graduated` went from thousands of positions to a trickle once Jupiter's indexing lag started rejecting fresh mints at the entry gate.
- **Disk grows faster than you think.** The SQLite database reaches multiple GB within weeks and the WAL plus log follow it. Keep an eye on `df -h` before running maintenance like `VACUUM` — it needs free space roughly equal to the database size.
- **GMGN rate limits are aggressive.** Don't lower `GMGN_REQUEST_DELAY_MS` below 2500 unless you enjoy banned API keys.
- **pump.fun REST sits behind Cloudflare.** `403 Just a moment` is not rate limiting and retrying harder makes it worse. Use the sidecar.
- **This is a personal setup, not a product.** No support, no roadmap, no guarantee it still works tomorrow. It is published because reading someone else's plumbing is the fastest way to fix your own.

## Security — credentials never go in this repo

- **No API keys, no bot tokens, no RPC keys, no wallet private keys, no seed phrases are committed here.** Everything sensitive is read from `.env`, which is `.gitignore`d.
- `.env.example` contains **placeholders only** (`your_helius_key`, `123456:ABC-DEF...`). If you ever see a value in this repo that looks real, treat it as a leaked key: rotate it, don't reuse it.
- Wallet keys are only needed for `live` mode. Use a dedicated wallet funded with money you can afford to lose completely — never your main wallet.
- The bundled scripts under `scripts/` and the Cloudflare sidecar do not hold credentials; they inherit nothing from `.env` and bind to loopback.
- Database files (`*.sqlite`), logs (`*.log`), and render artifacts are gitignored — they contain trade history and, potentially, chat identifiers.
- Before pushing to your own fork, run a sanity grep: `git grep -nE "sk-[A-Za-z0-9]{20,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|PRIVATE_KEY *= *\["`.

## Credit

Original project: [yunus-0x/charon](https://github.com/yunus-0x/charon). If you're looking for the upstream version, that's the one. This fork is my personal trading setup, shared as-is.
