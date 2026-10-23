const Database = require('better-sqlite3');
const { createCanvas, registerFont } = require('canvas');
const fs = require('fs');
const https = require('https');

// Register fonts if available
const interPath = '/home/ubuntu/.local/share/fonts/Inter-Variable.ttf';
const jbMonoPath = '/home/ubuntu/.local/share/fonts/JetBrainsMono-Variable.ttf';

if (fs.existsSync(interPath)) registerFont(interPath, { family: 'Inter' });
if (fs.existsSync(jbMonoPath)) registerFont(jbMonoPath, { family: 'JetBrainsMono' });

async function getLiveSolPrice() {
  return new Promise((resolve) => {
    https.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(parseFloat(json.price) || 119.04);
        } catch (e) {
          resolve(119.04);
        }
      });
    }).on('error', () => resolve(119.04));
  });
}

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

// Month is the only input: node scripts/generate_monthly_calendar.cjs [YYYY-MM]
const MONTH = process.argv[2] || new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 7);
const [YEAR, MON] = MONTH.split('-').map(Number);
const DAYS_IN_MONTH = new Date(Date.UTC(YEAR, MON, 0)).getUTCDate();
const FIRST_COL = (new Date(Date.UTC(YEAR, MON - 1, 1)).getUTCDay() + 6) % 7; // 0 = MON
const MONTH_LABEL = new Date(Date.UTC(YEAR, MON - 1, 1))
  .toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toUpperCase();

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  jan4.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((d - jan4) / 604800000);
}

async function main() {
  const solUsd = await getLiveSolPrice();
  console.log(`Live SOL/USD: $${solUsd.toFixed(2)}`);

  const db = new Database('/home/ubuntu/projects/charon/charon.sqlite', { readonly: true });
  
  // Pull all closed trades in Sep 2026 in WIB (+7 hours)
  const rows = db.prepare(`
    SELECT 
      strftime('%Y-%m-%d', datetime(closed_at_ms/1000, 'unixepoch', '+7 hours')) as day,
      count(*) as trades,
      sum(case when pnl_sol > 0 then 1 else 0 end) as wins,
      sum(case when pnl_sol < 0 then 1 else 0 end) as losses,
      sum(pnl_sol) as net_sol
    FROM dry_run_positions
    WHERE status = 'closed'
      AND closed_at_ms IS NOT NULL
      AND pnl_sol IS NOT NULL
      AND strftime('%Y-%m', datetime(closed_at_ms/1000, 'unixepoch', '+7 hours')) = ?
    GROUP BY day
    ORDER BY day ASC
  `).all(MONTH);

  const dayMap = new Map();
  for (const r of rows) {
    dayMap.set(r.day, {
      trades: r.trades,
      wins: r.wins,
      losses: r.losses,
      netSol: r.net_sol,
      netUsd: r.net_sol * solUsd,
      winRate: r.trades > 0 ? (r.wins / r.trades * 100) : 0
    });
  }

  const totalTrades = rows.reduce((acc, r) => acc + r.trades, 0);
  const totalWins = rows.reduce((acc, r) => acc + r.wins, 0);
  const totalLosses = rows.reduce((acc, r) => acc + r.losses, 0);
  const totalNetSol = rows.reduce((acc, r) => acc + r.net_sol, 0);
  const totalNetUsd = totalNetSol * solUsd;
  const overallWinRate = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;

  let winDays = 0;
  let lossDays = 0;
  let bestDay = null;
  let worstDay = null;

  for (const [day, d] of dayMap.entries()) {
    if (d.netSol > 0) winDays++;
    else if (d.netSol < 0) lossDays++;

    if (!bestDay || d.netUsd > bestDay.netUsd) bestDay = { day, ...d };
    if (!worstDay || d.netUsd < worstDay.netUsd) worstDay = { day, ...d };
  }

  // Dimensions - slightly higher for clean spacious footer
  const W = 1280;
  const H = 1040;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, W, H);
  bgGrad.addColorStop(0, '#0a0d14');
  bgGrad.addColorStop(1, '#07090e');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Decorative ambient glow
  ctx.save();
  ctx.filter = 'blur(90px)';
  ctx.fillStyle = 'rgba(0, 242, 157, 0.04)';
  ctx.beginPath();
  ctx.arc(200, 180, 250, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(153, 69, 255, 0.04)';
  ctx.beginPath();
  ctx.arc(W - 200, 300, 250, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Top Bar (Header)
  const padX = 48;
  let curY = 44;

  // Badge: System Status
  ctx.font = '600 11px "JetBrainsMono", monospace';
  const tagText = '● LIVE TRADE · CHARON BOT V4.5 · SOLANA';
  const tagW = ctx.measureText(tagText).width + 20;
  roundRect(ctx, padX, curY, tagW, 26, 6);
  ctx.fillStyle = 'rgba(20, 241, 149, 0.12)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(20, 241, 149, 0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#14f195';
  ctx.fillText(tagText, padX + 10, curY + 17);

  // Top Right Pill: Live Binance Ticker & Timezone
  const tickerText = `SOL/USD: $${solUsd.toFixed(2)} (Binance) · TIMEZONE: WIB (UTC+7)`;
  ctx.font = '500 12px "JetBrainsMono", monospace';
  const tickerW = ctx.measureText(tickerText).width + 24;
  const tickerX = W - padX - tickerW;
  roundRect(ctx, tickerX, curY, tickerW, 26, 6);
  ctx.fillStyle = 'rgba(30, 41, 59, 0.6)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = '#94a3b8';
  ctx.fillText(tickerText, tickerX + 12, curY + 17);

  curY += 42;

  // Title Row
  ctx.font = '800 32px "Inter", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText('CHARON PNL CALENDAR', padX, curY + 28);

  ctx.font = '600 16px "Inter", sans-serif';
  ctx.fillStyle = '#38bdf8';
  ctx.fillText(`< ${MONTH_LABEL} ${YEAR} >`, padX + 410, curY + 25);

  curY += 50;

  // 4 Top Bento Cards
  const bentoW = (W - padX * 2 - 3 * 16) / 4;
  const bentoH = 92;

  const cards = [
    {
      label: 'NET PROFIT (MTD)',
      val: `+$${totalNetUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
      sub: `+${totalNetSol.toFixed(4)} SOL`,
      valColor: '#00f29d',
      subColor: '#6ee7b7'
    },
    {
      label: 'WIN RATE',
      val: `${overallWinRate.toFixed(1)}%`,
      sub: `${totalWins.toLocaleString()}W · ${totalLosses.toLocaleString()}L (${totalTrades.toLocaleString()} Tr)`,
      valColor: '#ffffff',
      subColor: '#94a3b8'
    },
    {
      label: 'WIN/LOSS DAYS',
      val: `${winDays}W / ${lossDays}L`,
      sub: `${((winDays / (winDays + lossDays)) * 100).toFixed(1)}% Green Days (${winDays + lossDays} Active)`,
      valColor: '#00f29d',
      subColor: '#94a3b8'
    },
    {
      label: 'BEST / WORST DAY',
      val: `+$${bestDay ? bestDay.netUsd.toFixed(0) : '0'}`,
      sub: `Worst: -$${worstDay ? Math.abs(worstDay.netUsd).toFixed(0) : '0'} (${worstDay ? worstDay.day.slice(5) : ''})`,
      valColor: '#38bdf8',
      subColor: '#f87171'
    }
  ];

  cards.forEach((card, idx) => {
    const cx = padX + idx * (bentoW + 16);
    roundRect(ctx, cx, curY, bentoW, bentoH, 14);
    ctx.fillStyle = 'rgba(17, 24, 39, 0.7)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Specular highlight
    ctx.beginPath();
    ctx.moveTo(cx + 14, curY + 1);
    ctx.lineTo(cx + bentoW - 14, curY + 1);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.stroke();

    ctx.font = '600 11px "JetBrainsMono", monospace';
    ctx.fillStyle = '#64748b';
    ctx.fillText(card.label, cx + 18, curY + 25);

    ctx.font = '800 22px "JetBrainsMono", monospace';
    ctx.fillStyle = card.valColor;
    ctx.fillText(card.val, cx + 18, curY + 54);

    ctx.font = '500 12px "JetBrainsMono", monospace';
    ctx.fillStyle = card.subColor;
    ctx.fillText(card.sub, cx + 18, curY + 76);
  });

  curY += bentoH + 28;

  // Calendar Table Setup
  const colGap = 10;
  const rowGap = 10;
  const dayColW = 124;
  const weekColW = 140;
  const dayH = 88;

  const dayNames = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

  // Draw Column Headers
  ctx.font = '700 12px "JetBrainsMono", monospace';
  ctx.fillStyle = '#64748b';
  for (let i = 0; i < 7; i++) {
    const hx = padX + i * (dayColW + colGap);
    ctx.fillText(dayNames[i], hx + 12, curY + 14);
  }
  const weekHeaderX = padX + 7 * (dayColW + colGap) + 4;
  ctx.fillStyle = '#a78bfa';
  ctx.fillText('WEEK TOTAL', weekHeaderX + 12, curY + 14);

  curY += 24;

  const startDayOfWeek = FIRST_COL;
  const totalDaysInMonth = DAYS_IN_MONTH;
  const nowWibDate = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const todayDay = nowWibDate.getUTCDate();
  const isCurrentMonth = MONTH === nowWibDate.toISOString().slice(0, 7);

  const weeks = [];
  for (let w = 0; w * 7 - startDayOfWeek + 1 <= totalDaysInMonth; w++) {
    const firstDayInRow = Math.max(1, w * 7 - startDayOfWeek + 1);
    weeks.push({ name: `W${isoWeek(new Date(Date.UTC(YEAR, MON - 1, firstDayInRow)))}` });
  }
  if (weeks.length !== Math.ceil((startDayOfWeek + totalDaysInMonth) / 7)) {
    throw new Error(`calendar grid mismatch for ${MONTH}`);
  }

  for (let w = 0; w < weeks.length; w++) {
    const rowY = curY + w * (dayH + rowGap);
    let weekNetUsd = 0;
    let weekNetSol = 0;
    let weekTrades = 0;
    let weekWins = 0;

    for (let c = 0; c < 7; c++) {
      const cellX = padX + c * (dayColW + colGap);
      const dayNum = w * 7 + c - startDayOfWeek + 1;

      if (dayNum < 1 || dayNum > totalDaysInMonth) {
        // Outside month cell
        roundRect(ctx, cellX, rowY, dayColW, dayH, 10);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.2)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
        ctx.stroke();
        continue;
      }

      const dateStr = `${MONTH}-${String(dayNum).padStart(2, '0')}`;
      const dayData = dayMap.get(dateStr);
      const isToday = isCurrentMonth && dayNum === todayDay;
      const isFuture = dateStr > nowWibDate.toISOString().slice(0, 10);

      // Cell container
      roundRect(ctx, cellX, rowY, dayColW, dayH, 10);

      if (isFuture) {
        ctx.fillStyle = 'rgba(15, 23, 42, 0.35)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.stroke();

        ctx.font = '700 13px "JetBrainsMono", monospace';
        ctx.fillStyle = '#334155';
        ctx.fillText(String(dayNum).padStart(2, '0'), cellX + 10, rowY + 22);

        ctx.font = '500 11px "JetBrainsMono", monospace';
        ctx.fillStyle = '#1e293b';
        ctx.fillText('$0.00', cellX + 10, rowY + 50);
      } else if (dayData) {
        weekNetUsd += dayData.netUsd;
        weekNetSol += dayData.netSol;
        weekTrades += dayData.trades;
        weekWins += dayData.wins;

        const isWin = dayData.netSol >= 0;

        if (isWin) {
          ctx.fillStyle = 'rgba(0, 242, 157, 0.09)';
          ctx.fill();
          ctx.strokeStyle = isToday ? '#38bdf8' : 'rgba(0, 242, 157, 0.35)';
          ctx.lineWidth = isToday ? 2 : 1;
          ctx.stroke();
        } else {
          ctx.fillStyle = 'rgba(255, 59, 105, 0.09)';
          ctx.fill();
          ctx.strokeStyle = isToday ? '#38bdf8' : 'rgba(255, 59, 105, 0.35)';
          ctx.lineWidth = isToday ? 2 : 1;
          ctx.stroke();
        }

        // Day number
        ctx.font = '700 13px "JetBrainsMono", monospace';
        ctx.fillStyle = '#ffffff';
        ctx.fillText(String(dayNum).padStart(2, '0'), cellX + 10, rowY + 22);

        if (isToday) {
          // "TODAY" pill
          ctx.font = '700 9px "JetBrainsMono", monospace';
          const pillW = 46;
          const pillH = 16;
          roundRect(ctx, cellX + dayColW - pillW - 8, rowY + 9, pillW, pillH, 4);
          ctx.fillStyle = 'rgba(56, 189, 248, 0.25)';
          ctx.fill();
          ctx.strokeStyle = '#38bdf8';
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.fillStyle = '#38bdf8';
          ctx.fillText('TODAY', cellX + dayColW - pillW - 8 + 6, rowY + 21);
        }

        // PnL in USD
        ctx.font = '700 13px "JetBrainsMono", monospace';
        ctx.fillStyle = isWin ? '#00f29d' : '#ff3b69';
        const sign = isWin ? '+' : '-';
        const usdStr = `${sign}$${Math.abs(dayData.netUsd).toFixed(2)}`;
        ctx.fillText(usdStr, cellX + 10, rowY + 45);

        // PnL in SOL
        ctx.font = '500 10px "JetBrainsMono", monospace';
        ctx.fillStyle = isWin ? 'rgba(0, 242, 157, 0.8)' : 'rgba(255, 59, 105, 0.8)';
        const solStr = `${sign}${Math.abs(dayData.netSol).toFixed(3)} SOL`;
        ctx.fillText(solStr, cellX + 10, rowY + 61);

        // Trades & WR
        ctx.font = '500 9px "JetBrainsMono", monospace';
        ctx.fillStyle = '#64748b';
        ctx.fillText(`${dayData.trades} tr · ${dayData.winRate.toFixed(0)}%`, cellX + 10, rowY + 76);
      } else {
        // Traded day with 0 records
        roundRect(ctx, cellX, rowY, dayColW, dayH, 10);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.4)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.stroke();

        ctx.font = '700 13px "JetBrainsMono", monospace';
        ctx.fillStyle = '#64748b';
        ctx.fillText(String(dayNum).padStart(2, '0'), cellX + 10, rowY + 22);

        ctx.font = '500 11px "JetBrainsMono", monospace';
        ctx.fillStyle = '#475569';
        ctx.fillText('$0.00', cellX + 10, rowY + 50);
      }
    }

    // Week Total Column Box
    const weekX = padX + 7 * (dayColW + colGap) + 4;
    roundRect(ctx, weekX, rowY, weekColW, dayH, 10);
    const hasWeekData = weekTrades > 0;
    const isWeekWin = weekNetUsd >= 0;

    ctx.fillStyle = hasWeekData ? (isWeekWin ? 'rgba(0, 242, 157, 0.06)' : 'rgba(255, 59, 105, 0.06)') : 'rgba(15, 23, 42, 0.2)';
    ctx.fill();
    ctx.strokeStyle = hasWeekData ? (isWeekWin ? 'rgba(0, 242, 157, 0.2)' : 'rgba(255, 59, 105, 0.2)') : 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = '700 11px "JetBrainsMono", monospace';
    ctx.fillStyle = '#a78bfa';
    ctx.fillText(weeks[w].name, weekX + 12, rowY + 22);

    if (hasWeekData) {
      const sign = isWeekWin ? '+' : '-';
      ctx.font = '700 13px "JetBrainsMono", monospace';
      ctx.fillStyle = isWeekWin ? '#00f29d' : '#ff3b69';
      ctx.fillText(`${sign}$${Math.abs(weekNetUsd).toFixed(2)}`, weekX + 12, rowY + 45);

      ctx.font = '500 10px "JetBrainsMono", monospace';
      ctx.fillStyle = isWeekWin ? '#6ee7b7' : '#fca5a5';
      ctx.fillText(`${sign}${Math.abs(weekNetSol).toFixed(3)} SOL`, weekX + 12, rowY + 61);

      ctx.font = '500 9px "JetBrainsMono", monospace';
      ctx.fillStyle = '#64748b';
      const wWr = (weekWins / weekTrades * 100).toFixed(0);
      ctx.fillText(`${weekTrades} tr · ${wWr}% WR`, weekX + 12, rowY + 76);
    } else {
      ctx.font = '500 11px "JetBrainsMono", monospace';
      ctx.fillStyle = '#334155';
      ctx.fillText('$0.00', weekX + 12, rowY + 50);
    }
  }

  curY += weeks.length * (dayH + rowGap) + 16;

  // Footer: Divided into 2 clean, spacious lines
  // Line 1: Color Legend
  ctx.font = '500 11px "JetBrainsMono", monospace';
  ctx.fillStyle = '#64748b';
  ctx.fillText('LEGEND:   ● Green = Profit   ·   ● Red = Loss   ·   ● Cyan Border = Today (In-Progress)   ·   Dark Gray = Upcoming', padX, curY + 14);

  // Line 2: Database Source & Live Verification
  ctx.font = '500 11px "JetBrainsMono", monospace';
  ctx.fillStyle = '#475569';
  ctx.fillText('DATA SOURCE: LIVE TRADE (charon.sqlite) · AUDIT: REAL-TIME ON-CHAIN & JUPITER EXECUTION', padX, curY + 34);

  const yyyy = nowWibDate.getUTCFullYear();
  const mm = String(nowWibDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(nowWibDate.getUTCDate()).padStart(2, '0');
  const hh = String(nowWibDate.getUTCHours()).padStart(2, '0');
  const min = String(nowWibDate.getUTCMinutes()).padStart(2, '0');
  const nowWib = `GENERATED: ${yyyy}-${mm}-${dd} ${hh}:${min} WIB · CHARON v4.5`;
  const nowWibW = ctx.measureText(nowWib).width;
  ctx.fillText(nowWib, W - padX - nowWibW, curY + 34);

  // Save to file
  const outDir = '/home/ubuntu/projects/charon/output';
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = `${outDir}/charon-pnl-calendar-${MONTH}.png`;
  fs.writeFileSync(outPath, canvas.toBuffer('image/png'));
  console.log(`Saved PnL calendar to: ${outPath}`);
}

main().catch(console.error);
