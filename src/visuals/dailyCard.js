import { createCanvas, registerFont } from 'canvas';
import fs from 'fs';

// Try register Inter & JetBrains Mono if available
const interPath = '/home/ubuntu/.local/share/fonts/Inter-Variable.ttf';
const jbMonoPath = '/home/ubuntu/.local/share/fonts/JetBrainsMono-Variable.ttf';

if (fs.existsSync(interPath)) {
  registerFont(interPath, { family: 'Inter' });
}
if (fs.existsSync(jbMonoPath)) {
  registerFont(jbMonoPath, { family: 'JetBrainsMono' });
}

// Canvas Dimensions - Ultra Crisp HiDPI 1000 x 1360 (Modern Bento aspect ratio)
const W = 1000;
const H = 1360;

// Luxury Obsidian / Deep Space Theme Palette
const PALETTE = {
  cardBg: 'rgba(17, 24, 39, 0.72)',
  cardBgElevated: 'rgba(23, 33, 51, 0.85)',
  cardBorder: 'rgba(255, 255, 255, 0.08)',
  cardBorderLight: 'rgba(255, 255, 255, 0.14)',
  
  // Neon Accents
  profitGreen: '#00F29D',
  profitGreenMuted: 'rgba(0, 242, 157, 0.14)',
  profitGlow: 'rgba(0, 242, 157, 0.35)',
  profitBorder: 'rgba(0, 242, 157, 0.45)',

  lossRed: '#FF3B69',
  lossRedMuted: 'rgba(255, 59, 105, 0.14)',
  lossGlow: 'rgba(255, 59, 105, 0.35)',
  lossBorder: 'rgba(255, 59, 105, 0.45)',

  brandSolana: '#9945FF',
  brandSolanaCyan: '#14F195',
  brandCyan: '#38BDF8',
  brandPurple: '#A78BFA',

  // Typography
  textPrimary: '#FFFFFF',
  textSecondary: '#94A3B8',
  textMuted: '#64748B',
  textGhost: '#475569',
};

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

function drawGlassCard(ctx, x, y, w, h, r = 20, bg = null, border = null) {
  ctx.save();
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = bg || PALETTE.cardBg;
  ctx.fill();
  ctx.strokeStyle = border || PALETTE.cardBorder;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  // Subtle top specular highlight (machined glass edge)
  ctx.beginPath();
  ctx.moveTo(x + r, y + 1);
  ctx.lineTo(x + w - r, y + 1);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.restore();
}

function fmtSol(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '0.0000';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toFixed(4)}`;
}

function fmtPct(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '0.00%';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

function normalizeReport(report = {}) {
  const best = report.bestTrade || report.best || null;
  const worst = report.worstTrade || report.worst || null;
  const positions = Array.isArray(report.positions) ? report.positions
    : Array.isArray(report.rows) ? report.rows : [];

  return {
    totalTrades: Number(report.totalTrades || positions.length || 0),
    wins: Number(report.wins || 0),
    losses: Number(report.losses || 0),
    winRate: Number(report.winRate || 0),
    pnlSol: Number(report.pnlSol || 0),
    pnlPercent: Number(report.pnlPercent || 0),
    bestTrade: best ? { symbol: String(best.symbol || 'N/A'), pnlPercent: Number(best.pnlPercent || 0) } : null,
    worstTrade: worst ? { symbol: String(worst.symbol || 'N/A'), pnlPercent: Number(worst.pnlPercent || 0) } : null,
    avgWin: Number(report.avgWin || 0),
    avgLoss: Number(report.avgLoss || 0),
    riskReward: Number(report.riskReward || 0),
    strategy: String(report.strategy || 'SNIPER').toUpperCase(),
    positions: positions.map(p => ({
      symbol: String(p.symbol || 'TOKEN').replace(/^\$/, ''),
      pnlPercent: Number(p.pnlPercent || 0),
      pnlSol: Number(p.pnlSol || 0),
      exitReason: String(p.exitReason || p.exit_reason || 'TP/SL'),
    })),
    // Overridable branding so the same card renders monthly reports too
    badge: String(report.badge || 'DAILY INTELLIGENCE V2'),
    pill: String(report.pill || '● LIVE'),
    dateLabel: String(report.dateLabel || `${new Date().toISOString().slice(0, 10)} WIB`),
  };
}

export async function generateDailyCard(rawReport = {}) {
  const report = normalizeReport(rawReport);
  const isProfit = report.pnlSol >= 0;
  const accentColor = isProfit ? PALETTE.profitGreen : PALETTE.lossRed;
  const accentMuted = isProfit ? PALETTE.profitGreenMuted : PALETTE.lossRedMuted;
  const accentGlow = isProfit ? PALETTE.profitGlow : PALETTE.lossGlow;
  const accentBorder = isProfit ? PALETTE.profitBorder : PALETTE.lossBorder;

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 1. Deep Space Obsidian Background
  const bgGrad = ctx.createRadialGradient(W / 2, 220, 40, W / 2, H / 2, 950);
  bgGrad.addColorStop(0, isProfit ? '#0E1D22' : '#1F0F17');
  bgGrad.addColorStop(0.4, '#0A0E17');
  bgGrad.addColorStop(1, '#030508');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Subtle ambient glow orbs
  ctx.save();
  const orb1 = ctx.createRadialGradient(180, 180, 10, 180, 180, 400);
  orb1.addColorStop(0, accentGlow);
  orb1.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = orb1;
  ctx.fillRect(0, 0, W, H);

  const orb2 = ctx.createRadialGradient(W - 160, 480, 10, W - 160, 480, 420);
  orb2.addColorStop(0, 'rgba(56, 189, 248, 0.10)');
  orb2.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = orb2;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // Subtle background dot grid pattern
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
  for (let x = 30; x < W; x += 32) {
    for (let y = 30; y < H; y += 32) {
      ctx.beginPath();
      ctx.arc(x, y, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  // 2. HEADER BAR
  const pad = 44;
  const headerY = 44;
  const headerW = W - pad * 2;
  const headerH = 80;

  drawGlassCard(ctx, pad, headerY, headerW, headerH, 18, 'rgba(15, 23, 42, 0.75)', PALETTE.cardBorderLight);

  // Logo Icon (Geometric Neon Emblem)
  const iconX = pad + 24;
  const iconY = headerY + 22;
  roundRect(ctx, iconX, iconY, 36, 36, 10);
  ctx.fillStyle = accentMuted;
  ctx.fill();
  ctx.strokeStyle = accentBorder;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.font = 'bold 20px "JetBrainsMono", monospace';
  ctx.fillStyle = accentColor;
  ctx.textAlign = 'center';
  ctx.fillText('⚡', iconX + 18, iconY + 25);
  ctx.textAlign = 'left';

  // Title Text
  ctx.font = 'bold 22px "Inter", "DejaVu Sans", sans-serif';
  ctx.fillStyle = PALETTE.textPrimary;
  ctx.fillText('CHARON', iconX + 48, headerY + 46);

  ctx.font = 'bold 12px "JetBrainsMono", monospace';
  ctx.fillStyle = PALETTE.brandCyan;
  ctx.fillText(report.badge, iconX + 160, headerY + 45);

  // Mode & Date
  // Date badge (right-aligned against the pill so long ranges don't collide)
  ctx.font = '500 13px "JetBrainsMono", monospace';
  ctx.fillStyle = PALETTE.textSecondary;
  const dateText = report.dateLabel;
  ctx.textAlign = 'right';
  ctx.fillText(dateText, pad + headerW - 136, headerY + 46);
  ctx.textAlign = 'left';

  // Distinct Live Badge Pill (Always LIVE per TASK-CHARON-IMG-002)
  const pillW = 100;
  const pillH = 34;
  const pillX = pad + headerW - pillW - 20;
  const pillY = headerY + 23;
  roundRect(ctx, pillX, pillY, pillW, pillH, 8);

  ctx.fillStyle = 'rgba(0, 242, 157, 0.18)'; // Emerald translucent
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 242, 157, 0.6)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  ctx.font = 'bold 12px "JetBrainsMono", monospace';
  ctx.fillStyle = PALETTE.profitGreen;
  ctx.textAlign = 'center';
  ctx.fillText(report.pill, pillX + pillW / 2, pillY + 21);
  ctx.textAlign = 'left';

  // 3. HERO PNL BENTO CARD (Split: Net PnL + Winrate Radial/Meter Box)
  const heroY = 144;
  const heroH = 248;
  drawGlassCard(ctx, pad, heroY, headerW, heroH, 24, 'rgba(16, 24, 39, 0.88)', accentBorder);

  // Left vertical glowing neon bar
  ctx.save();
  ctx.fillStyle = accentColor;
  roundRect(ctx, pad + 6, heroY + 24, 5, heroH - 48, 3);
  ctx.fill();
  ctx.restore();

  // Header Subtitles
  ctx.font = '600 13px "Inter", "DejaVu Sans", sans-serif';
  ctx.fillStyle = PALETTE.textSecondary;
  ctx.fillText('NET REALIZED PERFORMANCE', pad + 32, heroY + 46);

  // Strategy Pill
  const stratX = pad + 270;
  const stratY = heroY + 31;
  roundRect(ctx, stratX, stratY, 130, 22, 6);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.stroke();
  ctx.font = 'bold 11px "JetBrainsMono", monospace';
  ctx.fillStyle = PALETTE.brandPurple;
  ctx.fillText(`STRATEGY: ${report.strategy}`, stratX + 10, stratY + 15);

  // Big Bold PnL in SOL
  const pnlSolFormatted = `${fmtSol(report.pnlSol)} SOL`;
  ctx.font = 'bold 58px "Inter", "DejaVu Sans", sans-serif';
  ctx.fillStyle = accentColor;
  ctx.fillText(pnlSolFormatted, pad + 32, heroY + 124);

  // Large Percentage Pill
  const pctStr = `${fmtPct(report.pnlPercent)} AVG`;
  ctx.font = 'bold 18px "JetBrainsMono", monospace';
  const pctMetrics = ctx.measureText(pctStr);
  const pctPillW = pctMetrics.width + 36;
  const pctPillH = 38;
  const pctPillX = pad + 32;
  const pctPillY = heroY + 156;

  roundRect(ctx, pctPillX, pctPillY, pctPillW, pctPillH, 10);
  ctx.fillStyle = accentMuted;
  ctx.fill();
  ctx.strokeStyle = accentBorder;
  ctx.lineWidth = 1.2;
  ctx.stroke();

  ctx.fillStyle = accentColor;
  ctx.fillText(pctStr, pctPillX + 18, pctPillY + 25);

  // Hero Right Column: Trade Win/Loss Box with Visual Bar
  const statBoxX = pad + headerW - 330;
  const statBoxY = heroY + 28;
  const statBoxW = 302;
  const statBoxH = heroH - 56;

  drawGlassCard(ctx, statBoxX, statBoxY, statBoxW, statBoxH, 18, 'rgba(10, 15, 26, 0.85)', 'rgba(255,255,255,0.08)');

  ctx.font = '600 12px "Inter", "DejaVu Sans", sans-serif';
  ctx.fillStyle = PALETTE.textSecondary;
  ctx.fillText('WIN / LOSS DISTRIBUTION', statBoxX + 20, statBoxY + 30);

  // Win vs Loss Counts
  ctx.font = 'bold 26px "JetBrainsMono", monospace';
  ctx.fillStyle = PALETTE.profitGreen;
  ctx.fillText(`${report.wins}W`, statBoxX + 20, statBoxY + 68);
  const wWidth = ctx.measureText(`${report.wins}W`).width;

  ctx.fillStyle = PALETTE.textGhost;
  ctx.fillText(' / ', statBoxX + 20 + wWidth, statBoxY + 68);
  const slashWidth = ctx.measureText(' / ').width;

  ctx.fillStyle = PALETTE.lossRed;
  ctx.fillText(`${report.losses}L`, statBoxX + 20 + wWidth + slashWidth, statBoxY + 68);

  // Segmented Multi-Bar Visual Progress
  const barX = statBoxX + 20;
  const barY = statBoxY + 94;
  const barW = statBoxW - 40;
  const barH = 14;

  roundRect(ctx, barX, barY, barW, barH, 6);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.fill();

  const winFillW = Math.max(0, Math.min(barW, (report.winRate / 100) * barW));
  if (winFillW > 0) {
    roundRect(ctx, barX, barY, winFillW, barH, 6);
    ctx.fillStyle = PALETTE.profitGreen;
    ctx.fill();
  }

  // Winrate Label & Total Trades
  ctx.font = 'bold 16px "JetBrainsMono", monospace';
  ctx.fillStyle = PALETTE.textPrimary;
  ctx.fillText(`${report.winRate.toFixed(1)}% WINRATE`, statBoxX + 20, statBoxY + 144);

  ctx.font = '500 12px "Inter", "DejaVu Sans", sans-serif';
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(`${report.totalTrades} Executed Orders`, statBoxX + 20, statBoxY + 168);

  // 4. BENTO ROW 2: Key Analytics Matrix (4 Cards)
  const row2Y = 412;
  const colGap = 16;
  const colW = (headerW - colGap * 3) / 4;
  const row2H = 120;

  const metricCards = [
    { label: 'PROFIT FACTOR', val: `1:${report.riskReward.toFixed(2)}`, sub: 'Risk / Reward Ratio', color: PALETTE.brandCyan },
    { label: 'AVERAGE GAIN', val: fmtPct(report.avgWin), sub: `${report.wins} Winner trades`, color: PALETTE.profitGreen },
    { label: 'AVERAGE LOSS', val: fmtPct(report.avgLoss), sub: `${report.losses} Stopped trades`, color: PALETTE.lossRed },
    { label: 'BEST ALPHA', val: report.bestTrade ? fmtPct(report.bestTrade.pnlPercent) : '0.00%', sub: report.bestTrade ? `$${report.bestTrade.symbol}` : 'No trades', color: PALETTE.profitGreen },
  ];

  metricCards.forEach((card, idx) => {
    const cardX = pad + idx * (colW + colGap);
    drawGlassCard(ctx, cardX, row2Y, colW, row2H, 16, PALETTE.cardBg, PALETTE.cardBorder);

    ctx.font = '600 11px "Inter", "DejaVu Sans", sans-serif';
    ctx.fillStyle = PALETTE.textSecondary;
    ctx.fillText(card.label, cardX + 16, row2Y + 28);

    ctx.font = 'bold 22px "JetBrainsMono", monospace';
    ctx.fillStyle = card.color;
    ctx.fillText(card.val, cardX + 16, row2Y + 68);

    ctx.font = '500 11px "Inter", "DejaVu Sans", sans-serif';
    ctx.fillStyle = PALETTE.textMuted;
    ctx.fillText(card.sub, cardX + 16, row2Y + 98);
  });

  // 5. BENTO ROW 3: TRADE EXECUTION LOG (Terminal/DexScreener Card)
  const tableY = 552;
  const tableH = 690;
  drawGlassCard(ctx, pad, tableY, headerW, tableH, 22, PALETTE.cardBgElevated, PALETTE.cardBorderLight);

  // Table Title Header
  ctx.font = 'bold 18px "Inter", "DejaVu Sans", sans-serif';
  ctx.fillStyle = PALETTE.textPrimary;
  ctx.fillText('LIVE EXECUTION TELEMETRY', pad + 24, tableY + 42);

  ctx.font = '500 13px "Inter", "DejaVu Sans", sans-serif';
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText(`Detailed session order fills & exit reasons`, pad + 300, tableY + 41);

  // Table Column Headers
  const thY = tableY + 84;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
  roundRect(ctx, pad + 16, thY - 24, headerW - 32, 40, 10);
  ctx.fill();

  ctx.font = 'bold 11px "Inter", "DejaVu Sans", sans-serif';
  ctx.fillStyle = PALETTE.textSecondary;
  ctx.fillText('#', pad + 32, thY + 2);
  ctx.fillText('ASSET PAIR', pad + 76, thY + 2);
  ctx.fillText('EXIT REASON', pad + 310, thY + 2);
  ctx.fillText('REALIZED (SOL)', pad + 520, thY + 2);
  ctx.textAlign = 'right';
  ctx.fillText('RETURN %', pad + headerW - 32, thY + 2);
  ctx.textAlign = 'left';

  // Table Rows (Max 7 rows)
  const rows = report.positions.slice(0, 7);
  const rowH = 72;
  const startRowY = thY + 32;

  if (rows.length === 0) {
    ctx.font = '500 15px "Inter", "DejaVu Sans", sans-serif';
    ctx.fillStyle = PALETTE.textMuted;
    ctx.textAlign = 'center';
    ctx.fillText('No closed positions logged for this session yet.', W / 2, tableY + tableH / 2);
    ctx.textAlign = 'left';
  } else {
    rows.forEach((row, i) => {
      const currentY = startRowY + i * rowH;
      const isItemProfit = row.pnlSol >= 0 || row.pnlPercent >= 0;
      const rowAccent = isItemProfit ? PALETTE.profitGreen : PALETTE.lossRed;
      const rowBg = i % 2 === 0 ? 'rgba(255, 255, 255, 0.02)' : 'rgba(0, 0, 0, 0.2)';

      // Row container
      roundRect(ctx, pad + 16, currentY - 14, headerW - 32, rowH - 8, 12);
      ctx.fillStyle = rowBg;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
      ctx.stroke();

      // Row index
      ctx.font = '500 13px "JetBrainsMono", monospace';
      ctx.fillStyle = PALETTE.textMuted;
      ctx.fillText(`0${i + 1}`, pad + 32, currentY + 26);

      // Asset Symbol Badge
      const tokenSym = `$${row.symbol.toUpperCase()}`;
      ctx.font = 'bold 16px "Inter", "DejaVu Sans", sans-serif';
      ctx.fillStyle = PALETTE.textPrimary;
      ctx.fillText(tokenSym, pad + 76, currentY + 26);

      // Exit Reason tag
      roundRect(ctx, pad + 310, currentY + 6, 130, 26, 6);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.fill();

      ctx.font = '600 11px "JetBrainsMono", monospace';
      ctx.fillStyle = PALETTE.textSecondary;
      ctx.fillText(row.exitReason.slice(0, 15), pad + 320, currentY + 23);

      // PnL in SOL
      ctx.font = 'bold 15px "JetBrainsMono", monospace';
      ctx.fillStyle = rowAccent;
      ctx.fillText(`${fmtSol(row.pnlSol)} SOL`, pad + 520, currentY + 26);

      // Return % Badge (Pill)
      const pillText = fmtPct(row.pnlPercent);
      ctx.font = 'bold 14px "JetBrainsMono", monospace';
      const pW = ctx.measureText(pillText).width + 24;
      const pX = pad + headerW - 32 - pW;
      const pY = currentY + 5;

      roundRect(ctx, pX, pY, pW, 30, 8);
      ctx.fillStyle = isItemProfit ? PALETTE.profitGreenMuted : PALETTE.lossRedMuted;
      ctx.fill();
      ctx.strokeStyle = isItemProfit ? 'rgba(0, 242, 157, 0.35)' : 'rgba(255, 59, 105, 0.35)';
      ctx.stroke();

      ctx.fillStyle = rowAccent;
      ctx.fillText(pillText, pX + 12, pY + 20);
    });
  }

  // 6. FOOTER BRANDING & TELEMETRY
  const footerY = H - 72;
  ctx.font = '600 12px "Inter", "DejaVu Sans", sans-serif';
  ctx.fillStyle = PALETTE.textMuted;
  ctx.fillText('CHARON HIGH-FREQUENCY SOLANA TRADING PROTOCOL', pad + 6, footerY + 36);

  ctx.font = '500 12px "JetBrainsMono", monospace';
  ctx.fillStyle = PALETTE.textGhost;
  ctx.textAlign = 'right';
  ctx.fillText('INTEGRATED WITH JUPITER DEX AGGREGATOR', pad + headerW - 6, footerY + 36);
  ctx.textAlign = 'left';

  return canvas.toBuffer('image/png');
}
