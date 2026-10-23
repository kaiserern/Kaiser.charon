// Monthly PnL report for Charon. Usage: node scripts/monthlyPnl.js [YYYY-MM]
// WIB month boundaries (matches the bot's report convention).
import Database from 'better-sqlite3';
import { writeFileSync } from 'fs';
import { DB_PATH } from '../src/config.js';
import { generateDailyCard } from '../src/visuals/dailyCard.js';

const WIB = 7 * 3600 * 1000;
const month = process.argv[2] || new Date(Date.now() + WIB).toISOString().slice(0, 7);
const [y, m] = month.split('-').map(Number);
const startMs = Date.UTC(y, m - 1, 1) - WIB;
const endMs = Date.UTC(y, m, 1) - WIB;

const db = new Database(DB_PATH, { readonly: true });
const rows = db.prepare(`
  SELECT id, symbol, strategy_id, size_sol, pnl_sol, pnl_percent, exit_reason,
         opened_at_ms, closed_at_ms
  FROM dry_run_positions
  WHERE status = 'closed' AND closed_at_ms >= ? AND closed_at_ms < ?
  ORDER BY pnl_sol DESC
`).all(startMs, endMs);
db.close();

if (!rows.length) {
  console.log(JSON.stringify({ month, totalTrades: 0 }));
  process.exit(0);
}

const wins = rows.filter(r => r.pnl_sol > 0);
const losses = rows.filter(r => r.pnl_sol <= 0);
const grossWin = wins.reduce((s, r) => s + r.pnl_sol, 0);
const grossLoss = losses.reduce((s, r) => s + r.pnl_sol, 0);
const pnlSol = grossWin + grossLoss;
const volumeSol = rows.reduce((s, r) => s + r.size_sol, 0);
const avgWin = wins.reduce((s, r) => s + r.pnl_percent, 0) / (wins.length || 1);
const avgLoss = losses.reduce((s, r) => s + r.pnl_percent, 0) / (losses.length || 1);
const avgHoldMin = rows.reduce((s, r) => s + (r.closed_at_ms - r.opened_at_ms), 0) / rows.length / 60000;
const exitReasons = {};
for (const r of rows) {
  const k = r.exit_reason || 'UNKNOWN';
  exitReasons[k] = exitReasons[k] || { n: 0, pnl: 0 };
  exitReasons[k].n++;
  exitReasons[k].pnl += r.pnl_sol;
}
const daily = {};
for (const r of rows) {
  const d = new Date(r.closed_at_ms + WIB).toISOString().slice(0, 10);
  daily[d] = daily[d] || { n: 0, pnl: 0, w: 0 };
  daily[d].n++;
  daily[d].pnl += r.pnl_sol;
  if (r.pnl_sol > 0) daily[d].w++;
}
const top10 = rows.slice(0, 10).reduce((s, r) => s + r.pnl_sol, 0);

let solUsd = 0;
try {
  const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
  solUsd = (await res.json())?.solana?.usd || 0;
} catch { /* price optional */ }

const firstDay = new Date(startMs + 86400000).toISOString().slice(0, 10).slice(8);
const lastDay = new Date(endMs - 1).toISOString().slice(0, 10).slice(8);

const out = {
  month, solUsd, totalTrades: rows.length,
  wins: wins.length, losses: losses.length,
  winRate: (wins.length / rows.length) * 100,
  pnlSol, pnlUsd: pnlSol * solUsd,
  volumeSol, volumeUsd: volumeSol * solUsd,
  avgSizeSol: volumeSol / rows.length,
  grossWin, grossLoss, profitFactor: grossWin / -grossLoss,
  expectancySol: pnlSol / rows.length,
  avgWin, avgLoss, avgHoldMin,
  bestTrade: { symbol: rows[0].symbol, pnlPercent: rows[0].pnl_percent, pnlSol: rows[0].pnl_sol },
  worstTrade: { symbol: rows[rows.length - 1].symbol, pnlPercent: rows[rows.length - 1].pnl_percent, pnlSol: rows[rows.length - 1].pnl_sol },
  top10Share: (top10 / pnlSol) * 100,
  exitReasons, daily,
  startDate: `${y}-${String(m).padStart(2, '0')}-${firstDay}`,
  endDate: `${y}-${String(m).padStart(2, '0')}-${lastDay}`,
};

const dailySum = Object.values(daily).reduce((s, d) => s + d.pnl, 0);
if (Math.abs(dailySum - pnlSol) > 1e-6) throw new Error('daily buckets do not reconcile with net pnl');
if (wins.length + losses.length !== rows.length) throw new Error('win/loss split does not cover all trades');

const buffer = await generateDailyCard({
  ...out,
  badge: 'MONTHLY INTELLIGENCE',
  pill: '● LIVE',
  dateLabel: `${out.startDate} > ${out.endDate} WIB`,
  positions: rows.slice(0, 7).map(r => ({
    symbol: r.symbol, pnlPercent: r.pnl_percent, pnlSol: r.pnl_sol, exitReason: r.exit_reason,
  })),
});

const png = `/tmp/charon_pnl_${month}.png`;
writeFileSync(png, buffer);
out.png = png;
console.log(JSON.stringify(out, null, 2));
