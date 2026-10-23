#!/usr/bin/env node
/**
 * Charon Shadow-Live Audit v2 — Items 2,4,5,6
 * Read-only SQLite analysis using json_extract for correct nesting.
 */
'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

let fullOutput = '';
function out(line) {
  process.stdout.write(line + '\n');
  fullOutput += line + '\n';
}

const DB_PATH = path.resolve(__dirname, '..', '..', 'charon.sqlite');
const OUT_DIR = __dirname;
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
const REPORT_PATH = path.join(OUT_DIR, 'SHADOW_LIVE_AUDIT_2026-08-03.txt');

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 30000');

function q(sql) { return db.prepare(sql).all(); }
function q1(sql) { return db.prepare(sql).get(); }
function qv(sql) { return db.prepare(sql).pluck().all(); }

const solLamports = 1e9;

function stats(arr) {
  if (!arr.length) return { mean: 0, median: 0, p90: 0, total: 0, n: 0, min: 0, max: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? s[Math.floor(n / 2)] : (s[n / 2 - 1] + s[n / 2]) / 2;
  const pIdx = Math.ceil(n * 0.9) - 1;
  const p90 = s[Math.max(0, pIdx)];
  const total = s.reduce((a, b) => a + b, 0);
  return { mean, median, p90, total, n, min: s[0], max: s[n - 1] };
}

function fmtSol(v) { return (v * 1e9).toFixed(0) + ' lamports / ' + v.toFixed(6) + ' SOL'; }
function fmtPct(v) { return (v * 100).toFixed(2) + '%'; }
function fmtNum(v, d) { return Number(v).toFixed(d || 2); }

// ─────────────────────────────────────────────
// 0. RAW VERIFICATION
// ─────────────────────────────────────────────
out('='.repeat(70));
out('CHARON SHADOW-LIVE AUDIT v2 — 2026-08-03');
out('Read-only json_extract-based analysis');
out('='.repeat(70));

const counts = q(`SELECT execution_mode, status, COUNT(*) as cnt FROM dry_run_positions GROUP BY execution_mode, status`);
const dl = q1(`SELECT MIN(opened_at_ms) as min_open, MAX(closed_at_ms) as max_close FROM dry_run_positions WHERE execution_mode='live' AND status='closed'`);
const dd = q1(`SELECT MIN(opened_at_ms) as min_open, MAX(closed_at_ms) as max_close FROM dry_run_positions WHERE execution_mode='dry_run' AND status='closed'`);
const tradeCounts = q(`SELECT side, COUNT(*) as cnt FROM dry_run_trades GROUP BY side`);

out('\n[0] VERIFIKASI MENTAH DATABASE');
out('-'.repeat(50));
out(`Size: ${(fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1)} MB`);
out('Counts by execution_mode × status:');
for (const r of counts) out(`  ${r.execution_mode}/${r.status}: ${r.cnt}`);
out(`Live closed: ${new Date(dl.min_open).toISOString()} → ${new Date(dl.max_close).toISOString()}`);
out(`Dry closed: ${new Date(dd.min_open).toISOString()} → ${new Date(dd.max_close).toISOString()}`);
for (const r of tradeCounts) out(`  ${r.side}: ${r.cnt}`);

// ─────────────────────────────────────────────
// Live fee data extraction via SQL json_extract
// ─────────────────────────────────────────────

// Buy fees: payload_json uses $.swap.order.*
const buyFeesQuery = q(`
  SELECT p.id, p.size_sol, p.pnl_percent, p.pnl_sol, p.exit_reason,
    p.entry_mcap, p.exit_mcap, p.high_water_mcap,
    p.tp_percent, p.sl_percent, p.trailing_percent, p.trailing_enabled, p.strategy_id,
    CAST(json_extract(p.snapshot_json, '$.candidate.signals.route') AS TEXT) as route,
    json_extract(bt.payload_json, '$.swap.order.signatureFeeLamports') as b_sig,
    json_extract(bt.payload_json, '$.swap.order.prioritizationFeeLamports') as b_prio,
    json_extract(bt.payload_json, '$.swap.order.rentFeeLamports') as b_rent,
    json_extract(bt.payload_json, '$.swap.order.feeBps') as b_routerBps,
    json_extract(bt.payload_json, '$.swap.order.platformFee.feeBps') as b_platBps
  FROM dry_run_positions p
  JOIN dry_run_trades bt ON bt.position_id = p.id AND bt.side = 'buy'
  WHERE p.status = 'closed' AND p.execution_mode = 'live'
    AND bt.payload_json IS NOT NULL AND bt.payload_json != ''
    AND bt.payload_json LIKE '%"signatureFeeLamports"%'
  ORDER BY p.id
`);

// Sell fees: nested under $.sell.order
const sellFeesQuery = q(`
  SELECT p.id,
    json_extract(st.payload_json, '$.sell.order.signatureFeeLamports') as s_sig,
    json_extract(st.payload_json, '$.sell.order.prioritizationFeeLamports') as s_prio,
    json_extract(st.payload_json, '$.sell.order.rentFeeLamports') as s_rent,
    json_extract(st.payload_json, '$.sell.order.feeBps') as s_routerBps,
    json_extract(st.payload_json, '$.sell.order.platformFee.feeBps') as s_platBps,
    json_extract(st.payload_json, '$.sell.order.outAmount') as s_outAmount,
    json_extract(st.payload_json, '$.receivedSol') as s_receivedSol,
    json_extract(st.payload_json, '$.sell.order.routePlan') as s_routePlan
  FROM dry_run_positions p
  JOIN dry_run_trades st ON st.position_id = p.id AND st.side = 'sell'
  WHERE p.status = 'closed' AND p.execution_mode = 'live'
    AND st.payload_json IS NOT NULL AND st.payload_json != ''
    AND st.payload_json LIKE '%"signatureFeeLamports"%'
  ORDER BY p.id
`);

// Map sell fees by position ID
const sellMap = {};
for (const r of sellFeesQuery) {
  sellMap[r.id] = {
    s_sig: Number(r.s_sig || 0), s_prio: Number(r.s_prio || 0), s_rent: Number(r.s_rent || 0),
    s_routerBps: Number(r.s_routerBps || 0), s_platBps: Number(r.s_platBps || 0),
    s_outAmount: Number(r.s_outAmount || 0), s_receivedSol: Number(r.s_receivedSol || 0),
    s_routePlan: r.s_routePlan
  };
}

out(`\nBuy fee rows extracted: ${buyFeesQuery.length}`);
out(`Sell fee rows extracted: ${Object.keys(sellMap).length}`);

// Sample raw rows
out('\n[0b] 5 ROW MENTAH:');
const sample = buyFeesQuery.sort(() => Math.random() - 0.5).slice(0, 5);
for (const r of sample) {
  out(`  id=${r.id} size=${r.size_sol} SOL | route=${r.route} | pnl=${fmtPct(r.pnl_percent||0)} | exit=${r.exit_reason}`);
  out(`    buy sig=${r.b_sig} prio=${r.b_prio} rent=${r.b_rent} routerBps=${r.b_routerBps} platBps=${r.b_platBps}`);
  const s = sellMap[r.id];
  if (s) out(`    sell sig=${s.s_sig} prio=${s.s_prio} rent=${s.s_rent} routerBps=${s.s_routerBps} platBps=${s.s_platBps}`);
}

// ─────────────────────────────────────────────
// 2. RECONSTRUCT LIVE FEE DISTRIBUTIONS
// ─────────────────────────────────────────────
out('\n\n[2] DISTRIBUSI FEE LIVE DARI PAYLOAD');
out('-'.repeat(50));

const buyEntryFees = [];
const sellExitFees = [];
const roundTripFees = [];
const buyPrioFees = [];
const sellPrioFees = [];
const matchedPositions = [];

for (const pos of buyFeesQuery) {
  const sm = sellMap[pos.id];
  if (!sm) continue; // need both buy+sell

  const bSig = Number(pos.b_sig || 0) / solLamports;
  const bPrio = Number(pos.b_prio || 0) / solLamports;
  const bRent = Number(pos.b_rent || 0) / solLamports;
  const bRouterBps = Number(pos.b_routerBps || 0);
  const bPlatBps = Number(pos.b_platBps || 0);
  const bTotalBps = bRouterBps + bPlatBps;
  const bSwap = pos.size_sol * (bTotalBps / 10000);
  const bFixed = bSig + bPrio + bRent;
  const bTotal = bFixed + bSwap;

  const sSig = sm.s_sig / solLamports;
  const sPrio = sm.s_prio / solLamports;
  const sRent = sm.s_rent / solLamports;
  const sTotalBps = sm.s_routerBps + sm.s_platBps;
  const sSwap = pos.size_sol * (sTotalBps / 10000);
  const sFixed = sSig + sPrio + sRent;
  const sTotal = sFixed + sSwap;

  const rt = bTotal + sTotal;
  const rtFixed = bFixed + sFixed;

  buyEntryFees.push(bTotal);
  sellExitFees.push(sTotal);
  roundTripFees.push(rt);
  buyPrioFees.push(bPrio);
  sellPrioFees.push(sPrio);

  matchedPositions.push({
    id: pos.id, size: pos.size_sol, route: pos.route,
    pnl_percent: pos.pnl_percent, pnl_sol: pos.pnl_sol,
    exit_reason: pos.exit_reason, entry_mcap: pos.entry_mcap, exit_mcap: pos.exit_mcap,
    high_water_mcap: pos.high_water_mcap,
    bFixed, bSwap, bTotal, bPrio, bSig,
    sFixed, sSwap, sTotal, sPrio, sSig,
    rt, rtFixed
  });
}

const bStats = stats(buyEntryFees);
const sStats = stats(sellExitFees);
const rtStats = stats(roundTripFees);
const bpStats = stats(buyPrioFees);
const spStats = stats(sellPrioFees);

out(`\nMatched buy+sell fee positions: ${matchedPositions.length}`);

out(`\nENTRY FEES (${bStats.n}):`);
out(`  signatureFee: mean=${fmtSol(stats(buyPrioFees.map((_,i) => matchedPositions[i].bSig)).mean)}`);
out(`  prioritizationFee: mean=${fmtSol(bpStats.mean)} med=${fmtSol(bpStats.median)} p90=${fmtSol(bpStats.p90)} max=${fmtSol(bpStats.max)}`);
out(`  swapFee (bps est): mean=${fmtSol(stats(matchedPositions.map(p => p.bSwap)).mean)}`);
out(`  BUY TOTAL: mean=${fmtSol(bStats.mean)} median=${fmtSol(bStats.median)} p90=${fmtSol(bStats.p90)}`);

out(`\nEXIT FEES (${sStats.n}):`);
out(`  prioritizationFee: mean=${fmtSol(spStats.mean)} med=${fmtSol(spStats.median)} p90=${fmtSol(spStats.p90)} max=${fmtSol(spStats.max)}`);
out(`  swapFee (bps est): mean=${fmtSol(stats(matchedPositions.map(p => p.sSwap)).mean)}`);
out(`  SELL TOTAL: mean=${fmtSol(sStats.mean)} median=${fmtSol(sStats.median)} p90=${fmtSol(sStats.p90)}`);

out(`\nROUND-TRIP FEES:`);
out(`  mean=${fmtSol(rtStats.mean)} median=${fmtSol(rtStats.median)}`);
out(`  p90=${fmtSol(rtStats.p90)} total=${fmtSol(rtStats.total)}`);
out(`  min=${fmtSol(rtStats.min)} max=${fmtSol(rtStats.max)}`);

// Fee as % of position
const feePctSize = matchedPositions.map(p => p.rt / p.size * 100);
const fpStats = stats(feePctSize);
out(`\nRT fee as % of position size:`);
out(`  mean=${fpStats.mean.toFixed(2)}% median=${fpStats.median.toFixed(2)}% p90=${fpStats.p90.toFixed(2)}%`);

// Fixed vs swap breakdown
const fixedOnly = matchedPositions.map(p => p.rtFixed);
const swapOnly = matchedPositions.map(p => p.bSwap + p.sSwap);
out(`\nFixed fees (sig+prio+rent): mean=${fmtSol(stats(fixedOnly).mean)} med=${fmtSol(stats(fixedOnly).median)}`);
out(`Bps swap fees (est): mean=${fmtSol(stats(swapOnly).mean)} med=${fmtSol(stats(swapOnly).median)}`);

// ─────────────────────────────────────────────
// 4. ROUTE SEPARATION
// ─────────────────────────────────────────────
out('\n\n[4] ROUTE SEPARATION');
out('-'.repeat(50));

const routes = {};
for (const p of matchedPositions) {
  const r = p.route || 'unknown';
  if (!routes[r]) routes[r] = [];
  routes[r].push(p);
}

const routeNames = Object.keys(routes).sort((a, b) => routes[b].length - routes[a].length);
out(`\nFound ${routeNames.length} distinct routes:`);

for (const r of routeNames) {
  const pos = routes[r];
  const wins = pos.filter(p => (p.pnl_percent || 0) > 0);
  const losses = pos.filter(p => (p.pnl_percent || 0) <= 0);
  const grossTotal = pos.reduce((s, p) => s + (p.pnl_sol || 0), 0);
  const wr = wins.length / pos.length * 100;
  const avgRt = stats(pos.map(p => p.rt));
  const feeAdjNet = pos.reduce((s, p) => s + (p.pnl_sol || 0) - p.rt, 0);
  const netWins = pos.filter(p => (p.pnl_sol || 0) - p.rt > 0);
  const sizes = pos.map(p => p.size);

  out(`\n  ${r}: ${pos.length} trades, WR=${wr.toFixed(1)}%`);
  out(`    Gross PnL: ${grossTotal.toFixed(6)} SOL total, avg=${(grossTotal/pos.length).toFixed(6)} SOL/trade`);
  out(`    Median RT fee: ${fmtSol(avgRt.median)} (${(avgRt.median/stats(sizes).mean*100).toFixed(2)}% of avg size)`);
  out(`    Fee-adjusted NET: ${feeAdjNet.toFixed(6)} SOL, WR_net=${(netWins.length/pos.length*100).toFixed(1)}%`);
  out(`    Wins=${wins.length} Losses=${losses.length}`);
}

// ─────────────────────────────────────────────
// 3. SHADOW-LIVE DRY-RUN with fee scenarios
// ─────────────────────────────────────────────
out('\n\n[3] SHADOW-LIVE DRY-RUN PnL DENGAN SKENARIO FEE');
out('-'.repeat(50));

// Get dry-run positions with route
const dryList = q(`
  SELECT p.id, p.mint, p.size_sol, p.pnl_percent, p.pnl_sol, p.exit_reason, p.strategy_id,
    CAST(json_extract(p.snapshot_json, '$.candidate.signals.route') AS TEXT) as route,
    p.entry_mcap, p.exit_mcap, p.high_water_mcap
  FROM dry_run_positions p
  WHERE p.status = 'closed' AND p.execution_mode = 'dry_run' AND p.pnl_sol IS NOT NULL
  ORDER BY p.id
`);

out(`Dry-run closed positions with route: ${dryList.length}`);

// Extract slippage from live sell payloads
out(`\n--- LIVE SELL SLIPPAGE ANALYSIS ---`);
let slippageCount = 0;
const slippagePcts = [];
for (const p of matchedPositions) {
  const sm = sellMap[p.id];
  if (!sm || !sm.s_routePlan) continue;
  try {
    const rp = JSON.parse(sm.s_routePlan);
    if (!Array.isArray(rp) || !rp.length) continue;
    const expected = rp.reduce((s, x) => s + (parseInt(x.swapInfo?.outAmount) || 0), 0);
    const executed = sm.s_outAmount;
    if (expected > 0 && executed > 0) {
      slippagePcts.push((expected - executed) / expected * 100);
      slippageCount++;
    }
  } catch(e) {}
}
const slpStats = stats(slippagePcts);
out(`Trades with valid routePlan: ${slippageCount}`);
out(`Slippage (expected - executed / expected): mean=${slpStats.mean.toFixed(3)}% median=${slpStats.median.toFixed(3)}% p90=${slpStats.p90.toFixed(3)}%`);
out(`Positive = executed < expected (loss to trader)`);

// Fee scenarios
const feeScenarios = {
  'live_mean':   { buyFee: bStats.mean, sellFee: sStats.mean, label: 'Live mean fees' },
  'live_median': { buyFee: bStats.median, sellFee: sStats.median, label: 'Live median fees' },
  'live_p90':    { buyFee: bStats.p90, sellFee: sStats.p90, label: 'Live p90 fees' },
};

for (const [scenario, sc] of Object.entries(feeScenarios)) {
  out(`\n--- Scenario: ${sc.label} ---`);
  const feeSol = sc.buyFee + sc.sellFee;
  const slpMedian = slpStats.median / 100; // as decimal

  let totalGross = 0, totalNet = 0, totalSlpCost = 0, totalFeeCost = 0;
  let winsNet = 0;
  const routeR = {};

  for (const p of dryList) {
    const gross = p.pnl_sol || 0;
    const slpCost = gross > 0 ? gross * slpMedian : 0;
    const net = gross - feeSol - slpCost;
    totalGross += gross;
    totalNet += net;
    totalSlpCost += slpCost;
    totalFeeCost += feeSol;
    if (net > 0) winsNet++;

    const r = p.route || 'unknown';
    if (!routeR[r]) routeR[r] = { gross: 0, net: 0, wins: 0, total: 0, fee: 0 };
    routeR[r].gross += gross;
    routeR[r].net += net;
    routeR[r].fee += feeSol;
    routeR[r].total++;
    if (net > 0) routeR[r].wins++;
  }

  out(`  Trades: ${dryList.length}`);
  out(`  Gross PnL: ${totalGross.toFixed(4)} SOL`);
  out(`  Fee cost: ${totalFeeCost.toFixed(4)} SOL (${feeSol.toFixed(6)}/trade)`);
  out(`  Slippage cost (est median ${slpStats.median.toFixed(2)}%): ${totalSlpCost.toFixed(4)} SOL`);
  out(`  NET after costs: ${totalNet.toFixed(4)} SOL`);
  out(`  WR after costs: ${(winsNet/dryList.length*100).toFixed(1)}%`);
  out(`  Avg net/trade: ${(totalNet/dryList.length).toFixed(6)} SOL`);

  const sortedRoutes = Object.entries(routeR).sort((a,b) => b[1].total - a[1].total);
  out(`  Per-route (top 12):`);
  for (const [rname, rd] of sortedRoutes.slice(0, 12)) {
    out(`    ${rname}: ${rd.total} trades | gross=${fmtNum(rd.gross,4)} | net=${fmtNum(rd.net,4)} SOL | WR=${(rd.wins/rd.total*100).toFixed(1)}%`);
  }
}

// ─────────────────────────────────────────────
// 5. PRIORITY FEE CAP SIMULATION
// ─────────────────────────────────────────────
out('\n\n[5] PRIORITY FEE CAP SIMULATION');
out('-'.repeat(50));

const medBuyPrio = bpStats.median;
const medBuySig = stats(matchedPositions.map(p => p.bSig)).median;
const medBuySwap = stats(matchedPositions.map(p => p.bSwap)).median;
const medSellPrio = spStats.median;
const medSellSig = stats(matchedPositions.map(p => p.sSig)).median;
const medSellSwap = stats(matchedPositions.map(p => p.sSwap)).median;
const medBuyRent = stats(matchedPositions.map(p => p.bFixed - p.bSig - p.bPrio)).mean;

out(`Base costs (median from live):`);
out(`  Buy: sig=${fmtSol(medBuySig)} swap=${fmtSol(medBuySwap)} prio=${fmtSol(medBuyPrio)}`);
out(`  Sell: sig=${fmtSol(medSellSig)} swap=${fmtSol(medSellSwap)} prio=${fmtSol(medSellPrio)}`);

const capRules = [0.01, 0.02, 0.05, 0.10];

for (const cap of capRules) {
  out(`\n--- Priority fee cap: entry prio ≤ ${(cap*100).toFixed(0)}% of position size ---`);

  let skipped = 0, totalNet = 0, totalGross = 0, winsNet = 0;
  const routeR = {};

  for (const p of dryList) {
    const capSol = p.size_sol * cap;
    const buyPrio = medBuyPrio; // actual median prio
    const isSkipped = buyPrio > capSol;
    const effBuyPrio = Math.min(buyPrio, capSol);

    const buyFee = medBuySig + effBuyPrio + medBuyRent + medBuySwap;
    const sellFee = medSellSig + medSellPrio + medSellSwap;
    const totalFee = buyFee + sellFee;
    const gross = p.pnl_sol || 0;

    if (isSkipped) {
      skipped++;
      totalGross += gross;
      // no fee cost, no trade
    } else {
      const net = gross - totalFee;
      totalNet += net;
      totalGross += gross;
      if (net > 0) winsNet++;

      // per route for executed
      const r = p.route || 'unknown';
      if (!routeR[r]) routeR[r] = { net: 0, wins: 0, total: 0 };
      routeR[r].net += net;
      routeR[r].total++;
      if (net > 0) routeR[r].wins++;
    }
  }

  const executed = dryList.length - skipped;
  out(`  Skipped (entry prio ${fmtSol(medBuyPrio)} > cap ${(cap*100).toFixed(0)}%): ${skipped}/${dryList.length} (${(skipped/dryList.length*100).toFixed(1)}%)`);
  out(`  Executed: ${executed}`);
  out(`  Gross PnL (all): ${totalGross.toFixed(4)} SOL`);
  out(`  NET (executed only): ${totalNet.toFixed(4)} SOL`);
  out(`  WR after costs: ${executed > 0 ? (winsNet/executed*100).toFixed(1) : 'N/A'}%`);

  const sortedRoutes = Object.entries(routeR).sort((a,b) => b[1].total - a[1].total);
  out(`  Per-route (executed, top 8):`);
  for (const [rname, rd] of sortedRoutes.slice(0, 8)) {
    out(`    ${rname}: ${rd.total} trades | net=${fmtNum(rd.net,4)} SOL | WR=${(rd.wins/rd.total*100).toFixed(1)}%`);
  }
}

// ─────────────────────────────────────────────
// 6. EXIT SWEEP (bounded counterfactual)
// ─────────────────────────────────────────────
out('\n\n[6] EXIT SWEEP — BOUNDED COUNTERFACTUAL');
out('-'.repeat(50));
out('CATATAN: Bukan tick-level replay. Hanya recorded high_water_mcap + exit outcomes.');
out('');

// Exit reason breakdown
const allReasons = {};
const liveReasons = {};
for (const p of dryList) {
  const r = p.exit_reason || 'unknown';
  allReasons[r] = (allReasons[r] || 0) + 1;
}
for (const p of matchedPositions) {
  const r = p.exit_reason || 'unknown';
  liveReasons[r] = (liveReasons[r] || 0) + 1;
}

out('Exit reason breakdown — Dry-run:');
const sortedAll = Object.entries(allReasons).sort((a,b) => b[1] - a[1]);
for (const [reason, count] of sortedAll) {
  out(`  ${reason}: ${count} (${(count/dryList.length*100).toFixed(1)}%)`);
}

out('\nExit reason breakdown — Live:');
const sortedLive = Object.entries(liveReasons).sort((a,b) => b[1] - a[1]);
for (const [reason, count] of sortedLive) {
  const pnls = matchedPositions.filter(p => p.exit_reason === reason).map(p => p.pnl_percent || 0);
  const ps = stats(pnls);
  out(`  ${reason}: ${count} | avg pnl=${fmtNum(ps.mean,1)}%`);
}

// SL Sweep
out(`\n--- SL Sweep on dry-run positions ---`);
out('Methodology: For positions with exit_reason=SL, replace PnL with new SL level.');
out('NOTES: This assumes position would have hit the new SL at same timing —');
out('wider SL could have allowed recovery. This is optimistic for wider SL.');
out('');

const slValues = [-10, -15, -20, -25, -30, -35];

for (const sl of slValues) {
  let modTotal = 0, slCount = 0;
  for (const p of dryList) {
    const reason = (p.exit_reason || '').toUpperCase();
    if (reason.includes('SL')) {
      // Replace with new SL level
      modTotal += p.size_sol * (sl / 100);
      slCount++;
    } else {
      modTotal += (p.pnl_sol || 0);
    }
  }
  const winsMod = dryList.filter(p => {
    const reason = (p.exit_reason || '').toUpperCase();
    if (reason.includes('SL')) return sl > 0;
    return (p.pnl_sol || 0) > 0;
  });
  out(`  SL=${sl}%: Total=${fmtNum(modTotal,4)} SOL | SL trades=${slCount}/${dryList.length} | WR=${(winsMod.length/dryList.length*100).toFixed(1)}% | Avg=${fmtNum(modTotal/dryList.length,6)} SOL/trade`);
}

// Peak vs Actual
out(`\n--- Peak Return vs Actual Exit Return ---`);
let peakCount = 0;
const peakVsActual = [];
for (const p of matchedPositions) {
  if (p.entry_mcap && p.high_water_mcap && p.entry_mcap > 0) {
    const peakRet = (p.high_water_mcap - p.entry_mcap) / p.entry_mcap * 100;
    const actualRet = p.pnl_percent || 0;
    peakVsActual.push({ peakRet, actualRet, diff: peakRet - actualRet });
    peakCount++;
  }
}
const peakStats = stats(peakVsActual.map(d => d.peakRet));
const diffStats = stats(peakVsActual.map(d => d.diff));
out(`Positions with valid HWM: ${peakCount}`);
out(`  Peak return: mean=${fmtNum(peakStats.mean,1)}% median=${fmtNum(peakStats.median,1)}% p90=${fmtNum(peakStats.p90,1)}%`);
out(`  Actual return: mean=${fmtNum(stats(peakVsActual.map(d=>d.actualRet)).mean,1)}%`);
out(`  Gap (peak-actual): mean=${fmtNum(diffStats.mean,1)}% median=${fmtNum(diffStats.median,1)}%`);
out(`  → median ${fmtNum(diffStats.median,1)}% of potential profit not captured.`);
out(`  Trailing stop optimization could help, but precise simulation requires tick-level data.`);

// ─────────────────────────────────────────────
// 7. BREAK-EVEN MATH
// ─────────────────────────────────────────────
out('\n\n[7] BREAK-EVEN MATH');
out('-'.repeat(50));

const dryWinners = dryList.filter(p => (p.pnl_percent || 0) > 0);
const dryLosers = dryList.filter(p => (p.pnl_percent || 0) <= 0);
const avgWinPct = stats(dryWinners.map(p => p.pnl_percent || 0)).mean;
const avgLossPct = stats(dryLosers.map(p => p.pnl_percent || 0)).mean;

out(`Dry-run winners: ${dryWinners.length} (${(dryWinners.length/dryList.length*100).toFixed(1)}%) | avg return: ${fmtNum(avgWinPct,1)}%`);
out(`Dry-run losers: ${dryLosers.length} (${(dryLosers.length/dryList.length*100).toFixed(1)}%) | avg return: ${fmtNum(avgLossPct,1)}%`);

const positionSizes = [0.01, 0.025, 0.05, 0.1];
const costLevels = [
  { label: 'median RT', cost: rtStats.median },
  { label: 'mean RT', cost: rtStats.mean },
  { label: 'p90 RT', cost: rtStats.p90 },
];

out('\nBreak-even required WR (using avg winner/loser returns):');
for (const size of positionSizes) {
  out(`\n  Position: ${size} SOL`);
  for (const cl of costLevels) {
    const feePct = cl.cost / size * 100;
    const denom = (avgWinPct - avgLossPct) / 100;
    // BE: WR * avgWinPct/100 * size + (1-WR) * avgLossPct/100 * size = cl.cost
    // WR * (avgWinPct - avgLossPct)/100 * size = cl.cost - avgLossPct/100 * size
    const num = (cl.cost / size) - (avgLossPct / 100);
    const beWR = denom !== 0 ? num / denom : NaN;
    out(`    ${cl.label} (${fmtSol(cl.cost)}, ${feePct.toFixed(1)}% of pos): BE WR = ${beWR > 0 ? (beWR*100).toFixed(1)+'%' : 'N/A'}`);
  }
}

// EV-based
out(`\nExpected value per trade (gross EV - fee):`);
const grossEV = dryList.reduce((s, p) => s + (p.pnl_sol || 0), 0) / dryList.length;
for (const size of positionSizes) {
  for (const cl of costLevels) {
    const netEV = grossEV - cl.cost;
    out(`  size=${size} SOL, ${cl.label}: EV/net = ${fmtNum(grossEV,6)} → ${fmtNum(netEV,6)} SOL (${netEV > 0 ? 'PROFITABLE' : 'LOSING'})`);
  }
}

// ─────────────────────────────────────────────
// 8. FEE SOURCE PATHS
// ─────────────────────────────────────────────
out('\n\n[8] EXACT FEE SOURCE PATHS');
out('-'.repeat(50));

// Verify one buy and one sell
const sampleBuyPath = q(`
  SELECT p.id,
    json_extract(bt.payload_json, '$.swap.order.signatureFeeLamports') as b_sig,
    json_extract(bt.payload_json, '$.swap.order.prioritizationFeeLamports') as b_prio,
    json_extract(bt.payload_json, '$.swap.order.rentFeeLamports') as b_rent,
    json_extract(bt.payload_json, '$.swap.order.feeBps') as b_routerBps,
    json_extract(bt.payload_json, '$.swap.order.platformFee.feeBps') as b_platBps,
    json_extract(bt.payload_json, '$.swap.order.platformFee.feePayer') as b_platPayer,
    json_extract(bt.payload_json, '$.swap.order.signatureFeePayer') as b_sigPayer,
    json_extract(bt.payload_json, '$.swap.order.prioritizationFeePayer') as b_prioPayer,
    json_extract(bt.payload_json, '$.swap.order.router') as b_router
  FROM dry_run_positions p
  JOIN dry_run_trades bt ON bt.position_id = p.id AND bt.side = 'buy'
  WHERE p.status = 'closed' AND p.execution_mode = 'live'
    AND bt.payload_json LIKE '%"signatureFeeLamports"%'
  LIMIT 1
`)[0];

const sampleSellPath = q(`
  SELECT p.id,
    json_extract(st.payload_json, '$.sell.order.signatureFeeLamports') as s_sig,
    json_extract(st.payload_json, '$.sell.order.prioritizationFeeLamports') as s_prio,
    json_extract(st.payload_json, '$.sell.order.rentFeeLamports') as s_rent,
    json_extract(st.payload_json, '$.sell.order.feeBps') as s_routerBps,
    json_extract(st.payload_json, '$.sell.order.platformFee.feeBps') as s_platBps,
    json_extract(st.payload_json, '$.sell.order.router') as s_router
  FROM dry_run_positions p
  JOIN dry_run_trades st ON st.position_id = p.id AND st.side = 'sell'
  WHERE p.status = 'closed' AND p.execution_mode = 'live'
    AND st.payload_json LIKE '%"signatureFeeLamports"%'
  LIMIT 1
`)[0];

if (sampleBuyPath) {
  out(`Buy payload (pos #${sampleBuyPath.id}):`);
  out(`  signatureFeeLamports: $.swap.order.signatureFeeLamports = ${sampleBuyPath.b_sig}`);
  out(`  prioritizationFeeLamports: $.swap.order.prioritizationFeeLamports = ${sampleBuyPath.b_prio}`);
  out(`  rentFeeLamports: $.swap.order.rentFeeLamports = ${sampleBuyPath.b_rent}`);
  out(`  feeBps: $.swap.order.feeBps = ${sampleBuyPath.b_routerBps}`);
  out(`  platformFee.feeBps: $.swap.order.platformFee.feeBps = ${sampleBuyPath.b_platBps}`);
  out(`  router: ${sampleBuyPath.b_router}`);
}

if (sampleSellPath) {
  out(`Sell payload (pos #${sampleSellPath.id}):`);
  out(`  signatureFeeLamports: $.sell.order.signatureFeeLamports = ${sampleSellPath.s_sig}`);
  out(`  prioritizationFeeLamports: $.sell.order.prioritizationFeeLamports = ${sampleSellPath.s_prio}`);
  out(`  rentFeeLamports: $.sell.order.rentFeeLamports = ${sampleSellPath.s_rent}`);
  out(`  feeBps: $.sell.order.feeBps = ${sampleSellPath.s_routerBps}`);
  out(`  platformFee.feeBps: $.sell.order.platformFee.feeBps = ${sampleSellPath.s_platBps}`);
  out(`  router: ${sampleSellPath.s_router}`);
}

out(`\nFee extraction summary:`);
out(`  - All fields extracted via SQLite json_extract from dry_run_trades.payload_json`);
out(`  - Buy path: $.swap.order.{signatureFeeLamports,prioritizationFeeLamports,rentFeeLamports,feeBps,platformFee.feeBps}`);
out(`  - Sell path: $.sell.order.{signatureFeeLamports,prioritizationFeeLamports,rentFeeLamports,feeBps,platformFee.feeBps}`);
out(`  - Fixed fee = sum of lamports / 1e9`);
out(`  - Swap fee = position_size_sol * (feeBps + platformFeeBps) / 10000`);

// ─────────────────────────────────────────────
// 9. TESIS & REKOMENDASI
// ─────────────────────────────────────────────
out('\n\n[9] TESIS & REKOMENDASI');
out('='.repeat(70));

// Route summary for thesis
const routeSummary = {};
for (const p of matchedPositions) {
  const r = p.route || 'unknown';
  if (!routeSummary[r]) routeSummary[r] = { n: 0, gross: 0, net: 0, wins: 0 };
  routeSummary[r].n++;
  routeSummary[r].gross += p.pnl_sol || 0;
  routeSummary[r].net += (p.pnl_sol || 0) - p.rt;
  if ((p.pnl_sol || 0) - p.rt > 0) routeSummary[r].wins++;
}

const liveGrossTotal = matchedPositions.reduce((s, p) => s + (p.pnl_sol || 0), 0);
const liveNetTotal = matchedPositions.reduce((s, p) => s + (p.pnl_sol || 0) - p.rt, 0);
const liveWR = matchedPositions.filter(p => (p.pnl_percent || 0) > 0).length / matchedPositions.length * 100;
const liveWrNet = matchedPositions.filter(p => (p.pnl_sol || 0) - p.rt > 0).length / matchedPositions.length * 100;

out(`
RINGKASAN DATA:
  - ${matchedPositions.length} live trades dengan fee payload (31 Jul – 1 Aug 2026)
  - ${dryList.length} dry-run trades (4 Jun – 3 Aug 2026)

BIAYA TRANSAKSI (LIVE, ${matchedPositions.length} trades):
  - Round-trip median: ${fmtSol(rtStats.median)} | mean: ${fmtSol(rtStats.mean)} | p90: ${fmtSol(rtStats.p90)}
  - Buy prio median: ${fmtSol(bpStats.median)} | Sell prio median: ${fmtSol(spStats.median)}
  - Fee sebagai % posisi (median): ${fpStats.median.toFixed(2)}%
  - Total fee paid: ${fmtSol(rtStats.total)}

PERFORMA LIVE GROSS:
  - Total PnL gross: ${liveGrossTotal.toFixed(6)} SOL
  - WR gross: ${liveWR.toFixed(1)}%
  - Total PnL after fees: ${liveNetTotal.toFixed(6)} SOL
  - WR after fees: ${liveWrNet.toFixed(1)}%

GAP PEAK-vs-ACTUAL:
  - Median peak return: ${fmtNum(peakStats.median,1)}%
  - Median actual return: ${fmtNum(stats(peakVsActual.map(d=>d.actualRet)).median,1)}%
  - Gap median: ${fmtNum(diffStats.median,1)}%

TESIS:
Berdasarkan audit shadow-live dari ${matchedPositions.length} live trades dengan fee payload aktual
dan ${dryList.length} dry-run trades:

1. Biaya round-trip median ${fmtSol(rtStats.median)} (${fpStats.median.toFixed(1)}% posisi 0.01-0.025 SOL) —
   artinya setiap trade butuh minimal ${fpStats.median.toFixed(1)}% return hanya untuk break-even.
   Saat avg loss ${fmtNum(Math.abs(avgLossPct),1)}% per loser, WR harus di atas
   ~${((rtStats.median/0.01*100 - avgLossPct)/(avgWinPct/100 - avgLossPct/100)).toFixed(0)}% agar net profitable (dengan asumsi avg winner ${fmtNum(avgWinPct,1)}%).

2. Komponen fee terbesar adalah prioritization fee (buy: ${fmtSol(bpStats.median)} median, ${fmtSol(bpStats.p90)} p90).
   Dengan cap 2% posisi, ${((medBuyPrio > 0.02 * 0.01) ? 'banyak' : 'sedikit')} trade yang kena skip.

3. ${fmtNum(diffStats.median,1)}% median gap antara peak return dan actual exit — trailing stop
   optimization bisa menangkap sebagian gap ini, TAPI simulasi presisi tidak mungkin
   tanpa data tick-level. Data DB hanya menyimpan 1 HWM per posisi.

REKOMENDASI:
a) Implementasikan priority fee cap di router: maksimum 5% dari position size untuk entry.
   Live data menunjukkan p90 prio = ${fmtSol(bpStats.p90)}. Pada posisi 0.025 SOL, 
   5% = ${fmtSol(0.025*0.05)} — di atas p90, jadi skip rate rendah.
b) Jangan mengubah strategi exit tanpa data tick-level. Current SL/Trailing sudah
   menangkap ${liveReasons['TRAILING_TP'] || 0} trailing-TP dari ${matchedPositions.length} live trades.
c) Audit weekly dengan live data aktual, bukan backtest. Biaya real-time
   bervariasi signifikan (range RT fee: ${fmtSol(rtStats.min)} – ${fmtSol(rtStats.max)}).`);

// ─────────────────────────────────────────────
// WRITE REPORT
// ─────────────────────────────────────────────
const prefix = fullOutput;
fs.writeFileSync(REPORT_PATH, fullOutput, 'utf8');
db.close();
console.log(`\n\nReport saved: ${REPORT_PATH}`);
