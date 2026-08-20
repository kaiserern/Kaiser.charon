import { createCanvas, registerFont } from 'canvas';

// 900x1120: Modern 4:5 mobile portrait aspect ratio for Telegram
const W = 900;
const H = 1120;

// High-contrast refined dark fintech palette
const COLOR_BG_TOP = '#0B0E14';
const COLOR_BG_BOTTOM = '#06080C';

// PNL Colors (Vibrant Neon Glow accents)
const PROFIT = '#00F090';       // Electric Emerald
const PROFIT_DIM = '#00F09033';
const PROFIT_BG = 'rgba(0, 240, 144, 0.08)';

const LOSS = '#FF3B56';         // Vivid Crimson
const LOSS_DIM = '#FF3B5633';
const LOSS_BG = 'rgba(255, 59, 86, 0.08)';

const NEUTRAL = '#94A3B8';
const BRAND_PURPLE = '#8B5CF6'; // Charon Accent Violet
const BRAND_CYAN = '#06B6D4';   // Solana / Cyber cyan

const TEXT_PRIMARY = '#F8FAFC';
const TEXT_SECONDARY = '#94A3B8';
const TEXT_MUTED = '#64748B';

const CARD_BG = '#121722';
const CARD_BG_ELEVATED = '#161D2B';
const CARD_BORDER = 'rgba(255, 255, 255, 0.08)';
const CARD_BORDER_GLOW = 'rgba(139, 92, 246, 0.2)';

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function fmtSol(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.0000';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toFixed(4)}`;
}

function fmtPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0.0%';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}${Math.abs(n).toFixed(2)}%`;
}

function fmtDate(value) {
  if (!value) {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  }
  const s = String(value);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function normalizeReport(report) {
  const best = report.bestTrade || report.best || null;
  const worst = report.worstTrade || report.worst || null;
  const positions = Array.isArray(report.positions) ? report.positions
    : Array.isArray(report.rows) ? report.rows : [];
  return {
    date: fmtDate(report.date),
    totalTrades: Number(report.totalTrades ?? report.total ?? positions.length ?? 0),
    wins: Number(report.wins ?? 0),
    losses: Number(report.losses ?? 0),
    winRate: Number(report.winRate ?? 0),
    pnlSol: Number(report.pnlSol ?? report.totalSol ?? 0),
    pnlPercent: Number(report.pnlPercent ?? 0),
    bestTrade: best ? {
      pnlPercent: Number(best.pnlPercent ?? 0),
      symbol: String(best.symbol || best.mint || '—'),
    } : null,
    worstTrade: worst ? {
      pnlPercent: Number(worst.pnlPercent ?? 0),
      symbol: String(worst.symbol || worst.mint || '—'),
    } : null,
    avgWin: Number(report.avgWin ?? 0),
    avgLoss: Number(report.avgLoss ?? 0),
    riskReward: Number(report.riskReward ?? 0),
    positions,
    strategy: report.strategy || report.strategyId || 'sniper',
  };
}

function drawBackground(ctx) {
  // Deep space subtle gradient
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, COLOR_BG_TOP);
  grad.addColorStop(1, COLOR_BG_BOTTOM);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Subtle ambient radial glow behind hero PNL
  const radialGlow = ctx.createRadialGradient(W / 2, 260, 40, W / 2, 260, 400);
  radialGlow.addColorStop(0, 'rgba(139, 92, 246, 0.12)');
  radialGlow.addColorStop(0.6, 'rgba(6, 182, 212, 0.04)');
  radialGlow.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = radialGlow;
  ctx.fillRect(0, 0, W, H);

  // Geometric subtle ambient grid
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
  ctx.lineWidth = 1;
  const gridSize = 40;
  for (let x = 0; x < W; x += gridSize) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();
  }
  for (let y = 0; y < H; y += gridSize) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawHeader(ctx, report) {
  const padX = 40;
  const topY = 48;

  // Charon Logo mark / symbol
  ctx.save();
  const logoX = padX;
  const logoY = topY;
  const logoSize = 36;

  // Logo container
  const logoGrad = ctx.createLinearGradient(logoX, logoY, logoX + logoSize, logoY + logoSize);
  logoGrad.addColorStop(0, BRAND_PURPLE);
  logoGrad.addColorStop(1, BRAND_CYAN);
  ctx.fillStyle = logoGrad;
  roundedRect(ctx, logoX, logoY, logoSize, logoSize, 8);
  ctx.fill();

  // Logo geometric icon (Skull / Delta mark stylized)
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 18px "DejaVu Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('⚡', logoX + logoSize / 2, logoY + logoSize / 2 + 1);

  // Bot Brand Title
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = 'bold 22px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.fillText('CHARON', logoX + logoSize + 14, logoY);

  // Subtitle / Strategy tag
  ctx.font = '600 11px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText(`SOLANA TRADING BOT · ${report.strategy.toUpperCase()}`, logoX + logoSize + 14, logoY + 22);

  // Right Date & Live Badge
  const dateStr = report.date;
  ctx.font = '600 12px "DejaVu Sans", sans-serif';
  const dateW = ctx.measureText(dateStr).width + 24;
  const dateX = W - padX - dateW;
  const dateY = topY + 4;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
  roundedRect(ctx, dateX, dateY, dateW, 28, 6);
  ctx.fill();
  ctx.strokeStyle = CARD_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = TEXT_SECONDARY;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(dateStr, dateX + dateW / 2, dateY + 14);

  ctx.restore();
}

function drawHeroPnlCard(ctx, report) {
  const padX = 40;
  const y = 110;
  const w = W - padX * 2;
  const h = 230;

  const isProfit = report.pnlSol >= 0;
  const accentColor = isProfit ? PROFIT : LOSS;
  const accentDim = isProfit ? PROFIT_DIM : LOSS_DIM;
  const accentBg = isProfit ? PROFIT_BG : LOSS_BG;

  ctx.save();

  // Glass Card Background
  const cardGrad = ctx.createLinearGradient(padX, y, padX, y + h);
  cardGrad.addColorStop(0, CARD_BG_ELEVATED);
  cardGrad.addColorStop(1, CARD_BG);
  ctx.fillStyle = cardGrad;
  roundedRect(ctx, padX, y, w, h, 16);
  ctx.fill();

  // Card Outer Glow & Border
  ctx.strokeStyle = isProfit ? 'rgba(0, 240, 144, 0.25)' : 'rgba(255, 59, 86, 0.25)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Top header inside Hero Card
  ctx.font = '700 11px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('REALIZED NET PROFIT / LOSS', padX + 24, y + 24);

  // Status Badge Pill (PROFIT / LOSS / BREAKEVEN)
  const statusText = report.pnlSol > 0 ? 'PROFIT' : report.pnlSol < 0 ? 'LOSS' : 'BREAK-EVEN';
  ctx.font = 'bold 11px "DejaVu Sans", sans-serif';
  const badgeW = ctx.measureText(statusText).width + 20;
  const badgeX = padX + w - 24 - badgeW;
  const badgeY = y + 20;

  ctx.fillStyle = accentBg;
  roundedRect(ctx, badgeX, badgeY, badgeW, 24, 12);
  ctx.fill();
  ctx.strokeStyle = accentDim;
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = accentColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(statusText, badgeX + badgeW / 2, badgeY + 12);

  // Huge Net SOL PnL Display
  const solText = `${fmtSol(report.pnlSol)} SOL`;
  ctx.font = 'bold 54px "DejaVu Sans", sans-serif';
  ctx.fillStyle = accentColor;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(solText, padX + 24, y + 58);

  // Percentage Badge & Subtitle
  const pctText = `${fmtPct(report.pnlPercent)} Return`;
  ctx.font = 'bold 16px "DejaVu Sans", sans-serif';
  ctx.fillStyle = isProfit ? '#A7F3D0' : '#FECDD3';
  ctx.fillText(pctText, padX + 24, y + 128);

  // Inline Bottom Metrics Bar inside Hero Card
  const innerBarY = y + 164;
  const innerBarH = 46;
  const innerBarW = w - 48;
  const innerBarX = padX + 24;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  roundedRect(ctx, innerBarX, innerBarY, innerBarW, innerBarH, 10);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // 3 Mini columns in hero card bottom
  const colW = innerBarW / 3;
  
  // Trades Count
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '600 11px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText('Trades:', innerBarX + 16, innerBarY + innerBarH / 2);
  ctx.font = 'bold 12px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.fillText(`${report.totalTrades} (${report.wins}W / ${report.losses}L)`, innerBarX + 66, innerBarY + innerBarH / 2);

  // Win Rate
  const col2X = innerBarX + colW;
  ctx.font = '600 11px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText('Win Rate:', col2X + 12, innerBarY + innerBarH / 2);
  ctx.font = 'bold 12px "DejaVu Sans", sans-serif';
  ctx.fillStyle = report.winRate >= 50 ? PROFIT : LOSS;
  ctx.fillText(`${report.winRate.toFixed(1)}%`, col2X + 76, innerBarY + innerBarH / 2);

  // Risk / Reward
  const col3X = innerBarX + colW * 2;
  ctx.font = '600 11px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText('R:R Ratio:', col3X + 12, innerBarY + innerBarH / 2);
  ctx.font = 'bold 12px "DejaVu Sans", sans-serif';
  ctx.fillStyle = report.riskReward >= 1 ? PROFIT : TEXT_PRIMARY;
  const rrStr = report.riskReward > 0 ? `1:${report.riskReward.toFixed(2)}` : '—';
  ctx.fillText(rrStr, col3X + 80, innerBarY + innerBarH / 2);

  ctx.restore();
}

function drawMetricGrid(ctx, report) {
  const padX = 40;
  const y = 360;
  const gap = 16;
  const w = (W - padX * 2 - gap) / 2;
  const h = 100;

  // Box 1: Avg Win
  drawMetricCard(
    ctx, padX, y, w, h,
    'AVG WINNING TRADE',
    fmtPct(report.avgWin),
    'Per profitable position',
    PROFIT,
    '▲'
  );

  // Box 2: Avg Loss
  drawMetricCard(
    ctx, padX + w + gap, y, w, h,
    'AVG LOSING TRADE',
    fmtPct(report.avgLoss),
    'Per stopped out position',
    LOSS,
    '▼'
  );

  // Row 2: Best & Worst Trade Cards
  const y2 = y + h + gap;

  // Box 3: Best Trade
  const bestSymbol = report.bestTrade ? `$${report.bestTrade.symbol}` : '—';
  const bestPct = report.bestTrade ? fmtPct(report.bestTrade.pnlPercent) : '—';
  drawTradeHighlightCard(
    ctx, padX, y2, w, h,
    'TOP PERFORMER',
    bestSymbol,
    bestPct,
    PROFIT,
    '💎'
  );

  // Box 4: Worst Trade
  const worstSymbol = report.worstTrade ? `$${report.worstTrade.symbol}` : '—';
  const worstPct = report.worstTrade ? fmtPct(report.worstTrade.pnlPercent) : '—';
  drawTradeHighlightCard(
    ctx, padX + w + gap, y2, w, h,
    'MAX DRAWDOWN TRADE',
    worstSymbol,
    worstPct,
    LOSS,
    '⚠️'
  );
}

function drawMetricCard(ctx, x, y, w, h, label, value, subtext, valueColor, icon) {
  ctx.save();
  ctx.fillStyle = CARD_BG;
  roundedRect(ctx, x, y, w, h, 14);
  ctx.fill();
  ctx.strokeStyle = CARD_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Top Label
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '700 10px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText(label, x + 18, y + 16);

  // Main Value with subtle icon
  ctx.font = 'bold 24px "DejaVu Sans", sans-serif';
  ctx.fillStyle = valueColor;
  ctx.fillText(value, x + 18, y + 36);

  // Subtext
  ctx.font = '500 11px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_SECONDARY;
  ctx.fillText(subtext, x + 18, y + 70);

  ctx.restore();
}

function drawTradeHighlightCard(ctx, x, y, w, h, label, symbol, pct, valueColor, badgeIcon) {
  ctx.save();
  ctx.fillStyle = CARD_BG;
  roundedRect(ctx, x, y, w, h, 14);
  ctx.fill();
  ctx.strokeStyle = CARD_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Top Label
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '700 10px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText(label, x + 18, y + 16);

  // Symbol name
  ctx.font = 'bold 20px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_PRIMARY;
  ctx.fillText(symbol, x + 18, y + 40);

  // PnL Value on right side
  ctx.textAlign = 'right';
  ctx.font = 'bold 20px "DejaVu Sans", sans-serif';
  ctx.fillStyle = valueColor;
  ctx.fillText(pct, x + w - 18, y + 40);

  // Sub indicator line
  ctx.font = '500 11px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.textAlign = 'left';
  ctx.fillText('Closed Trade PnL', x + 18, y + 70);

  ctx.restore();
}

function drawDistributionAndBarChart(ctx, report) {
  const padX = 40;
  const y = 600;
  const w = W - padX * 2;
  const h = 210;

  ctx.save();
  ctx.fillStyle = CARD_BG;
  roundedRect(ctx, padX, y, w, h, 14);
  ctx.fill();
  ctx.strokeStyle = CARD_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Section Header
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '700 11px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText('TRADE DISTRIBUTION & SEQUENCE', padX + 20, y + 18);

  const positions = report.positions || [];
  const count = positions.length;

  if (count === 0) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '500 14px "DejaVu Sans", sans-serif';
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText('No trade positions recorded today.', padX + w / 2, y + h / 2);
    ctx.restore();
    return;
  }

  // Win / Loss Progress bar overview
  const barY = y + 44;
  const barH = 12;
  const barW = w - 40;
  const barX = padX + 20;

  const winRatio = report.totalTrades > 0 ? report.wins / report.totalTrades : 0;
  const winBarW = Math.round(barW * winRatio);
  const lossBarW = barW - winBarW;

  // Background track
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  roundedRect(ctx, barX, barY, barW, barH, 6);
  ctx.fill();

  if (winBarW > 0) {
    ctx.fillStyle = PROFIT;
    roundedRect(ctx, barX, barY, Math.max(winBarW, 6), barH, 6);
    ctx.fill();
  }
  if (lossBarW > 0 && winRatio < 1) {
    ctx.fillStyle = LOSS;
    roundedRect(ctx, barX + winBarW, barY, lossBarW, barH, 6);
    ctx.fill();
  }

  // Distribution legend
  ctx.font = '600 11px "DejaVu Sans", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillStyle = PROFIT;
  ctx.fillText(`● ${report.wins} Wins (${(winRatio * 100).toFixed(0)}%)`, barX, barY + 22);

  ctx.textAlign = 'right';
  ctx.fillStyle = LOSS;
  ctx.fillText(`● ${report.losses} Losses (${((1 - winRatio) * 100).toFixed(0)}%)`, barX + barW, barY + 22);

  // Historical Bar Chart (Last N positions)
  const chartY = y + 90;
  const chartH = 100;
  const chartW = barW;
  const chartX = barX;

  const chartPositions = positions.slice(0, 24); // Show up to 24 bars
  const numBars = chartPositions.length;
  const barGap = 4;
  const singleBarW = Math.max(4, (chartW - barGap * (numBars - 1)) / numBars);

  const midLineY = chartY + chartH / 2 + 8;

  // Baseline zero line
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(chartX, midLineY);
  ctx.lineTo(chartX + chartW, midLineY);
  ctx.stroke();

  // Find max abs pnl for proper relative scaling
  let maxVal = 0;
  for (const pos of chartPositions) {
    const val = Math.abs(Number(pos.pnlPercent || 0));
    if (val > maxVal) maxVal = val;
  }
  if (maxVal === 0) maxVal = 1;

  for (let i = 0; i < numBars; i++) {
    const pos = chartPositions[i];
    const val = Number(pos.pnlPercent || 0);
    const isUp = val >= 0;
    const barHeight = Math.max(3, (Math.abs(val) / maxVal) * (chartH / 2 - 12));
    const bx = chartX + i * (singleBarW + barGap);

    ctx.fillStyle = isUp ? PROFIT : LOSS;
    if (isUp) {
      roundedRect(ctx, bx, midLineY - barHeight, singleBarW, barHeight, 2);
      ctx.fill();
    } else {
      roundedRect(ctx, bx, midLineY, singleBarW, barHeight, 2);
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawRecentTradesTable(ctx, report) {
  const padX = 40;
  const y = 826;
  const w = W - padX * 2;
  const h = 210;

  ctx.save();
  ctx.fillStyle = CARD_BG;
  roundedRect(ctx, padX, y, w, h, 14);
  ctx.fill();
  ctx.strokeStyle = CARD_BORDER;
  ctx.lineWidth = 1;
  ctx.stroke();

  // Header Title
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = '700 11px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText('RECENT CLOSED POSITIONS', padX + 20, y + 16);

  const positions = (report.positions || []).slice(0, 4); // Top 4 recent positions
  if (positions.length === 0) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '500 13px "DejaVu Sans", sans-serif';
    ctx.fillStyle = TEXT_MUTED;
    ctx.fillText('No closed trades in this session.', padX + w / 2, y + h / 2 + 10);
    ctx.restore();
    return;
  }

  // Draw 4 rows
  const rowStartY = y + 42;
  const rowHeight = 38;

  for (let i = 0; i < positions.length; i++) {
    const pos = positions[i];
    const ry = rowStartY + i * rowHeight;
    const isUp = Number(pos.pnlPercent || 0) >= 0;
    const accent = isUp ? PROFIT : LOSS;

    // Alternating subtle row background
    if (i % 2 === 1) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
      roundedRect(ctx, padX + 12, ry, w - 24, rowHeight - 4, 6);
      ctx.fill();
    }

    // Symbol
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 13px "DejaVu Sans", sans-serif';
    ctx.fillStyle = TEXT_PRIMARY;
    ctx.fillText(`$${pos.symbol || 'UNKNOWN'}`, padX + 24, ry + (rowHeight - 4) / 2);

    // Direction Tag
    ctx.font = '600 10px "DejaVu Sans", sans-serif';
    ctx.fillStyle = isUp ? PROFIT : LOSS;
    ctx.fillText(isUp ? 'WIN' : 'LOSS', padX + 180, ry + (rowHeight - 4) / 2);

    // PnL %
    ctx.textAlign = 'right';
    ctx.font = 'bold 13px "DejaVu Sans", sans-serif';
    ctx.fillStyle = accent;
    ctx.fillText(fmtPct(pos.pnlPercent), padX + w - 24, ry + (rowHeight - 4) / 2);
  }

  ctx.restore();
}

function drawFooter(ctx, report) {
  const padX = 40;
  const footerY = H - 42;

  ctx.save();
  ctx.textBaseline = 'middle';

  // Left side: Bot status
  ctx.textAlign = 'left';
  ctx.font = '600 11px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  ctx.fillText('CHARON TRADING SYSTEM · HIGH FREQUENCY SNIPER', padX, footerY);

  // Right side: Timestamp
  ctx.textAlign = 'right';
  ctx.font = '500 11px "DejaVu Sans", sans-serif';
  ctx.fillStyle = TEXT_MUTED;
  const nowStr = new Date().toISOString().slice(11, 19) + ' UTC';
  ctx.fillText(`Generated ${nowStr}`, W - padX, footerY);

  ctx.restore();
}

export async function generateDailyCard(report) {
  if (!report || typeof report !== 'object') {
    throw new Error('generateDailyCard: report object is required');
  }
  const data = normalizeReport(report);

  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.antialias = 'subpixel';
  ctx.patternQuality = 'bilinear';
  ctx.quality = 'bilinear';

  drawBackground(ctx);
  drawHeader(ctx, data);
  drawHeroPnlCard(ctx, data);
  drawMetricGrid(ctx, data);
  drawDistributionAndBarChart(ctx, data);
  drawRecentTradesTable(ctx, data);
  drawFooter(ctx, data);

  return canvas.toBuffer('image/png');
}

export default generateDailyCard;
