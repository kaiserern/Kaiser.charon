# Kaiser.Charon

![node](https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white)
![chain](https://img.shields.io/badge/network-solana-9945ff?style=flat-square)
![mode](https://img.shields.io/badge/execution-dry__run-c9a227?style=flat-square)
![license](https://img.shields.io/badge/license-none%20%C2%B7%20personal%20project-555?style=flat-square)

A Telegram bot that screens Solana pump.fun tokens, filters them through a strategy, optionally asks an LLM to pick entries, and executes through Jupiter. Three modes: `dry_run` (paper fills into SQLite), `confirm` (Telegram approve/reject), and `live` (real swaps).

A working fork of [yunus-0x/charon](https://github.com/yunus-0x/charon). All credit for the original idea and codebase goes to him — I kept changing things while running it, and at some point the diff got big enough that it needed its own home.

> **Read [Notes](#notes) before trusting any PnL number this thing prints.** Dry-run PnL is only as honest as the quotes feeding it, and for a while mine weren't.

`Quick start` · `Configuration` · `How it runs` · `Fix log` · `Notes` · `Security`

## At a glance

| Topic | Current state |
|---|---|
| **Pipeline** | signal → enrich → filter → score → decision → position |
| **Active route** | `pumpfun_pregrad` only (allowlist, gated before enrichment) |
| **Exit rules** | SL −20% · arm trailing at +10% · trail 8% · TP +50% · max hold 30m |
| **Sizing** | 0.1 SOL/trade · 5 concurrent positions · liquidity floor $15k |
| **LLM** | off (`use_llm=false`) — decisions are rule-based |
| **Storage** | SQLite in WAL mode; hot-read strategy params, env only on restart |
| **Tests** | 29 offline tests (`npm test`), no network or keys needed |

## What this fork changes

- **Fill-to-fill dry run (`quote-paper-2.0`)** — paper entries use an executable Jupiter buy quote and exits an executable sell quote, instead of synthetic mark prices. Recorded PnL includes the simulated fill difference and fees, so it tracks live execution.
- **Route allowlist** — `allowed_routes` gates every signal source at the pipeline entrance, before any enrichment call. Routes that are not listed cost nothing and never reach a filter.
- **FLOW filter** — candidates need `s1h_priceChange >= 0` and `net_buyer_ratio_5m >= 0.2`.
- **PumpPortal WebSocket + pre-grad scanner** — real-time create/migrate events and bonding-curve tokens before graduation, instead of polling alone.
- **GMGN signed auth** — Ed25519-signed requests for holder counts, fees and socials.
- **Trailing TP guard** — trailing no longer fires on underwater positions. It used to "lock in profit" at a loss.
- **Telegram reports + rendered cards**, plus **backtest tooling** so filter changes get measured against local trade history before deployment.
- **Live execution hardening** — realized PnL tracking, sell guards, Jupiter Ultra routing.

## Quick start

```bash
git clone https://github.com/kaiserern/Kaiser.charon.git
cd Kaiser.charon
npm install                 # native build — see Requirements
cp .env.example .env        # fill in tokens + RPC below
npm run check               # syntax check before first boot
npm test                    # 29 offline tests
npm start
```

Minimum `.env` for dry run:

```bash
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...   # @BotFather
TELEGRAM_CHAT_ID=your_chat_id
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=your_signal_key
HELIUS_API_KEY=your_helius_key
TRADING_MODE=dry_run
```

The SQLite database is created at `DB_PATH` on first run. Nothing else to provision.

## Configuration

Two places, deliberately:

1. **`.env`** — API keys, RPC URLs, feature flags, mode. Restart to apply.
2. **SQLite `settings` / `strategies`** — every strategy parameter. **Hot-read**, tuned live from `/menu` in Telegram without a restart.

Live values on the running instance:

| Setting | Value | Why |
|---|---|---|
| `allowed_routes` | `pumpfun_pregrad` | only route with measured positive expectancy (see Notes) |
| `min_liquidity_usd` | `15000` | below this the sell quote is the market |
| `max_open_positions` | `5` | each position costs ~2 quote calls/tick |
| `trailing_arm_percent` | `10` | arm later, give runners room |
| `trailing_floor_percent` | `8` | floor after arming |
| `tp_percent` / `sl_percent` | `50` / `-20` | wider target, tighter stop |
| `max_hold_ms` | `1800000` | 30 min — pregrad runners die fast |
| `use_llm` | `false` | rule-based path for the single route |

Optional subsystems are off until their flag is set: `GMGN_ENABLED`, `PUMPPORTAL_ENABLED` (needs `PUMPPORTAL_API_KEY`), `PREGRAD_ENABLED`, `ENABLE_LLM` (needs `LLM_API_KEY`), `TRENDING_ENABLED=false` (disables GMGN trending **and** trending candidates arriving from the signal server).

## How it runs

```
SIGNAL SOURCES                              INGRESS GATE
├── Signal Server (api.thecharon.xyz)  ─┐
├── PumpPortal WebSocket              ─┤
├── GMGN Trending / Trenches          ─┼──→ routeAllowed()
├── pump.fun pregrad (CF sidecar)     ─┤    before enrichment,
└── Fee claims / smart money          ─┘    costs zero API calls

PIPELINE
  signal → buildCandidate() → enrichment (GMGN, Jupiter, Twitter)
  → filterCandidate() → preScore() → momentumFilter()
  → decision (LLM batch, or rule-based when use_llm=false)
  → dry-run position | Telegram confirm | live swap

EXECUTION LOOP (10s)
  monitorPositions() → Jupiter sell quote (fill-to-fill)
  → SL / TP / trailing / max-hold
  → close → SQLite → Telegram card
```

Position monitoring is quote-first: exits price on an executable sell quote. If quoting fails, the position is valued at a labelled mark fallback rather than skipped — every exit rule still evaluates. See the fix log for why that distinction matters.

## Fix log

### 2026-10-23 — the bleed was plumbing

17 red days, win rate down to ~36%. The strategy was not unlucky; the execution path was lying to it.

| Area | Symptom | Fix |
|---|---|---|
| Jupiter quotes | unauthenticated `lite-api.jup.ag`, ~2,130 HTTP 429/day, quoting dark ~28% of the day | moved to `api.jup.ag` with `x-api-key`; measured 0 × 429 after |
| Rate limiting | one 429 tripped a **global 30s backoff**, freezing quoting for every token | header-aware governor: reads the 10 req/s bucket from `x-ratelimit-*`, pulls the slot to the reset when ≤1 remains. `backing off (429)` went 2,720 → 0 |
| Position monitor | missing sell quote hit an early `return`, leaving `pnl_percent` NULL — **SL, trailing and max-hold never evaluated** | fallback mark valuation (`valuationStatus='mark_fallback'`) keeps every rule alive; unquotable exits get closed and labelled |
| Stop loss | realised average **−27.2%** against a −20% config | after the monitor fix: **−20.6%** |
| Entry gate | two fresh quotes 2s apart rejected **714 mints/day** (`reference_quote_missing_or_stale`) on un-indexed `*pump` tokens; `pumpportal_graduated` converted 1.5% of candidates | 3 retries, 700ms apart, for fresh graduates only |
| Misreported reason | `missing_decimals_or_sol_price` — decimals were always present, the SOL/USD fetch was failing | split into two reasons; SOL/USD cached 60s with a 10-minute last-good fallback |
| Slippage gate | `slippage_exceeds_3_percent` looked like a bug (185 critical alerts/day) | **not a bug.** Replayed 24 rejected mints against Jupiter candles: median **−5.6%** at 3m, **−19.3%** at 5m, **−38.4%** at 10m, only 10% positive at 10m. Gate stays at 3%; the drift is now in the message and the alert downgraded to informational |
| Signal ingress | `trending_enabled=false` only stopped the internal poller — `single_source` / `graduated_trending` still arrived via the signal server and were traded | enforced at `serverClient` ingress, then superseded by the route allowlist below |
| Route allowlist | routes decayed into negative expectancy but kept trading | `allowed_routes` gate at the top of `processCandidateFromSignals()`, ahead of enrichment — covers all seven ingress paths in one place |
| Liquidity floor | `$6,000` hardcoded | reads `min_liquidity_usd` from settings, default unchanged |
| pump.fun access | `403 Just a moment` from `frontend-api-v3.pump.fun`, permanent | headless-Chromium sidecar on loopback (see below) |
| GMGN market cap | `price` is an **object**; `Number(info.price)` was NaN for every live mint, so mcap resolved to `0` and the graduation check could never fire | unwrap the nested object, fall back to `migration_market_cap`, regression tests |
| Bridge | `dry_run_trades(position_id)` had no index → query >60s → unit timed out on every run; plus an internal 8s deadline in `bridge-export.py` | index added (~0.5s), deadline raised to 20s, `CPUQuota` set |
| Config drift | `max_open_positions` was 3 / 5 / 15 across `.env`, strategy and settings — the bot used 15, multiplying quote pressure | 5 everywhere; `TRENDING_ENABLED` aligned |
| Disk | `charon.log` unrotated at 351 MB on a 92%-full disk | `/etc/logrotate.d/charon` (daily, 7 rotations, 200 MB cap, `copytruncate`) |

### 2026-10-25 — GMGN queue starvation

The bot went ~38 hours without opening a position while `pumpfun_pregrad` candidates kept arriving. Cause was upstream of the filter: every candidate had `gmgn = null`, so `metrics.liquidityUsd` fell back to Jupiter's DEX liquidity (~$10.7k) instead of GMGN's pool liquidity (~$22.7k) — and the $15k floor rejected 169 of 176 candidates in 24 hours.

| Area | Symptom | Fix |
|---|---|---|
| GMGN queue | single serial queue with 2.5s pacing; one overrunning request held the chain forever, so every later caller died at the 15s deadline (`gmgn queue deadline exceeded`) and `fetchGmgnTokenInfo` returned `null` silently | the chain is now bounded by the deadline, not by the work item |
| Feed hygiene | the pumpportal bonding-curve monitor polled GMGN for up to 50 tracked mints every 25s even though its only route (`pumpportal_graduated`) was allowlisted out — 2 req/s of demand against 0.4 req/s of capacity | token tracking stops when the route is not in `allowed_routes`; the DOWN alert now says "no trading impact" instead of paging "bot blind to new tokens" |
| Recovery | restarting cleared the wedge and the next pregrad candidate enriched correctly (liq $22,758, filter passed, position opened) | — |

pumpportal.fun itself was serving `502 Bad Gateway` from nginx on `/api/data` (both HTTP and WebSocket upgrade) for the entire window — an upstream outage, not a client fault, and unrelated to the zero-entry problem.

### Optional: pump.fun Cloudflare sidecar

If your host gets `403` from `frontend-api-v3.pump.fun`, the pregrad scanner and graduation detection cannot reach the REST API directly. They fall back to a local daemon that fetches through headless Chromium.

```bash
python3 -m venv /opt/charon-cf/venv
/opt/charon-cf/venv/bin/pip install playwright==1.63.0
/opt/charon-cf/venv/bin/playwright install chromium
# run /opt/charon-cf/fetchd.py under systemd, loopback only
```

It binds `127.0.0.1:8799`, serves `GET /fetch?url=<target>` with a host allowlist, and holds no credentials or wallet keys. Override with `CHARON_CF_FETCH_URL`. Without it the bot still runs — those two routes just stay dark.

## Requirements

- **Node.js 20+** (tested on 22)
- Native build tools: `build-essential python3 pkg-config libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev`
- A **Telegram bot token** and chat ID
- A **signal server key** — see the [original repo](https://github.com/yunus-0x/charon) for access
- A **Helius RPC endpoint** (free tier is fine for `dry_run`)
- For `live` only: a **Solana wallet private key** and a **Jupiter API key**

## Operations

```bash
systemctl status charon
tail -f charon.log | grep -E "429|quote|exit|\[candidate\]"

# exit-reason breakdown — read this before the total
sqlite3 charon.sqlite "SELECT exit_reason, COUNT(*), ROUND(AVG(pnl_percent),2)
  FROM dry_run_positions GROUP BY 1;"
```

Start with `TRADING_MODE=dry_run`, watch it for a week. Dry run uses executable quotes on both sides now, but it is still an estimate: API failures trigger fallbacks, and live swaps add wallet state, priority fees, confirmation latency and worse slippage than the quote you saw.

## Notes

Operational notes I wish someone had written down for me. Read them before drawing conclusions from the numbers.

- **The old +40 SOL "profit" was an artifact.** Before `quote-paper-2.0` (2026-10-06) dry-run PnL came from indexer **mark** prices, not prices you could fill at. It looked great and meant nothing. Records before that date are not comparable to records after it — the pricing model changed, not the market.
- **Fill-to-fill PnL is the only number worth arguing about.** Even it is optimistic against live: real swaps add priority fees, wallet state, confirmation latency, and worse slippage than the quote you saw.
- **Stop loss is a target, not a guarantee.** The bot exits *at* the quote it receives. On thin books the realised number lands a couple of points worse than `sl_percent`. Seeing −27% on a −20% stop is a plumbing problem (no quote at evaluation time), not a rounding error.
- **A strategy can be profitable and still be a loser.** Win rate × average win has to beat (1 − win rate) × average loss. At −20% stops and +25% targets you need >45% win rate just to break even. Check the exit-reason breakdown, not the total.
- **Route composition beats parameter tuning.** Replaying all 1,580 era-2 entries through Jupiter 1m candles under the current exit config (2% round-trip cost): `single_source` −3.3%, `graduated_trending` −6.2%, `trenches_completed` −0.7%, `pumpportal_graduated` +1.0% (n=22), `pumpfun_pregrad` **+0.2%** — the only route with a large enough sample to be non-negative, and only barely. Those are replay numbers, not live PnL, and they are optimistic: entries whose candles could not be aligned to the real entry price (dead markets, mostly heavy losers) are excluded. Treat +0.2% as a ceiling. No exit configuration rescues a route with negative expectancy — that is why the allowlist exists, and why this is an experiment rather than a proven edge.
- **1,580 entries is not 1,580 opportunities.** Replaying the same trades showed a median peak of **+18% at 10 minutes** and **+26% at 30**, but the deployed exits captured far less — the path was there, the exit plumbing was not. That is a fill-and-monitor problem first, a signal problem second.
- **Concentration has a cost.** `pumpfun_pregrad` only accepts tokens at 90–100% of the bonding curve with a real SOL reserve in a narrow band, so expect **a few trades a day with 30–60 minute gaps**, not a steady stream. Low trade count is the route working as designed, not the bot idling.
- **Signal sources are not free.** Each route has its own fee, liquidity and latency profile, and a route that worked for months can decay.
- **Disk grows faster than you think.** The database reaches multiple GB in weeks and the WAL follows it. Check `df -h` before maintenance like `VACUUM` — it needs free space roughly equal to the database size.
- **GMGN rate limits are aggressive.** Don't push `GMGN_REQUEST_DELAY_MS` below 2500 unless you enjoy banned keys.
- **pump.fun REST sits behind Cloudflare.** `403 Just a moment` is not rate limiting; retrying harder makes it worse. Use the sidecar.
- **This is a personal setup, not a product.** No support, no roadmap, no guarantee it still works tomorrow. It is published because reading someone else's plumbing is the fastest way to fix your own.

## Security — credentials never go in this repo

- **No API keys, bot tokens, RPC keys, wallet private keys or seed phrases are committed here.** Everything sensitive is read from `.env`, which is `.gitignore`d.
- `.env.example` contains **placeholders only** (`your_helius_key`, `123456:ABC-DEF...`). If you see something that looks real in this repo, treat it as leaked: rotate it, don't reuse it.
- Wallet keys are only needed for `live`. Use a dedicated wallet funded with money you can afford to lose completely — never your main wallet.
- Bundled scripts and the Cloudflare sidecar hold no credentials; the sidecar inherits nothing from `.env` and binds to loopback.
- Database files (`*.sqlite`), logs (`*.log`) and render artifacts are gitignored — they hold trade history and potentially chat identifiers.
- Before pushing your own fork, run: `git grep -nE "sk-[A-Za-z0-9]{20,}|[0-9]{8,10}:AA[A-Za-z0-9_-]{30,}|PRIVATE_KEY *= *\["`

## Credit

Original project: [yunus-0x/charon](https://github.com/yunus-0x/charon). If you want upstream, that's the one. This fork is my personal trading setup, shared as-is.
