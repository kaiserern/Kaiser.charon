import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID, DB_PATH } from '../config.js';
import { generateDailyCard } from '../visuals/dailyCard.js';
import { escapeHtml } from '../format.js';
import { writeFileSync, unlinkSync } from 'fs';
import Database from 'better-sqlite3';

export async function buildDailyReport() {
  const db = new Database(DB_PATH);
  try {
    const now = Date.now();
    // Start of today in Jakarta time (UTC+7): midnight WIB = UTC midnight - 7h
    const wibOffset = 7 * 60 * 60 * 1000;
    const nowWIB = now + wibOffset;
    const todayWIBStart = Math.floor(nowWIB / 86400000) * 86400000; // midnight WIB in UTC+7 frame
    const startWIBmidnight = todayWIBStart - wibOffset; // convert back to UTC ms

    // All closed positions since WIB midnight (dry_run + live)
    const closedPositions = db.prepare(`
      SELECT * FROM dry_run_positions
      WHERE status = 'closed' AND closed_at_ms >= ?
      ORDER BY closed_at_ms DESC
    `).all(startWIBmidnight);

    const getLatestSellTrade = db.prepare(`
      SELECT * FROM dry_run_trades
      WHERE position_id = ? AND side = 'sell'
        AND json_extract(payload_json, '$.receivedSol') IS NOT NULL
      ORDER BY at_ms DESC LIMIT 1
    `);

    // Recompute realized PnL from actual sell rows, fallback to position pnl_sol
    const recomputed = [];
    for (const pos of closedPositions) {
      const sellTrade = getLatestSellTrade.get(pos.id);
      let realizedPnlSol, realizedPnlPercent;

      if (sellTrade) {
        try {
          const sellPayload = JSON.parse(sellTrade.payload_json || '{}');
          const receivedSol = Number(sellPayload.receivedSol);
          if (receivedSol && receivedSol > 0) {
            let entrySnapshot = {};
            try { entrySnapshot = JSON.parse(pos.snapshot_json || '{}'); } catch {}
            const entrySwap = entrySnapshot.swap || {};
            const sellSwap = sellPayload.sell || {};
            const entrySigFee = Number(entrySwap?.order?.signatureFeeLamports || 0);
            const entryPrioFee = Number(entrySwap?.order?.prioritizationFeeLamports || 0);
            const sellSigFee = Number(sellSwap?.order?.signatureFeeLamports || 0);
            const sellPrioFee = Number(sellSwap?.order?.prioritizationFeeLamports || 0);
            const totalFeesSol = (entrySigFee + entryPrioFee + sellSigFee + sellPrioFee) / 1_000_000_000;
            const sizeSol = Number(pos.size_sol);
            realizedPnlSol = receivedSol - sizeSol - totalFeesSol;
            realizedPnlPercent = sizeSol > 0 ? (realizedPnlSol / sizeSol) * 100 : 0;
          }
        } catch { /* fall through to fallback */ }
      }

      // Fallback: use position pnl_sol / pnl_percent for dry_run trades
      if (realizedPnlSol === undefined) {
        realizedPnlSol = Number(pos.pnl_sol || 0);
        realizedPnlPercent = Number(pos.pnl_percent || 0);
      }

      recomputed.push({
        pnlPercent: realizedPnlPercent,
        pnlSol: realizedPnlSol,
        symbol: pos.symbol || '',
        exitReason: pos.exit_reason,
        closedAtMs: pos.closed_at_ms,
      });
    }

    const totalTrades = recomputed.length;
    const wins = recomputed.filter(p => p.pnlSol > 0).length;
    const losses = recomputed.filter(p => p.pnlSol <= 0).length;
    const winRate = totalTrades > 0 ? (wins / totalTrades * 100) : 0;
    const pnlSol = recomputed.reduce((sum, p) => sum + p.pnlSol, 0);
    const pnlPercent = totalTrades > 0
      ? recomputed.reduce((sum, p) => sum + p.pnlPercent, 0) / totalTrades
      : 0;

    const sorted = [...recomputed].sort((a, b) => b.pnlPercent - a.pnlPercent);
    const bestTrade = totalTrades > 0
      ? { pnlPercent: sorted[0].pnlPercent, symbol: sorted[0].symbol }
      : null;
    const worstTrade = totalTrades > 0
      ? { pnlPercent: sorted[sorted.length - 1].pnlPercent, symbol: sorted[sorted.length - 1].symbol }
      : null;

    const winTrades = recomputed.filter(p => p.pnlSol > 0);
    const lossTrades = recomputed.filter(p => p.pnlSol <= 0);
    const avgWin = winTrades.length > 0
      ? winTrades.reduce((s, p) => s + p.pnlPercent, 0) / winTrades.length
      : 0;
    const avgLoss = lossTrades.length > 0
      ? lossTrades.reduce((s, p) => s + p.pnlPercent, 0) / lossTrades.length
      : 0;
    const riskReward = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

    return {
      totalTrades,
      wins,
      losses,
      winRate,
      pnlSol,
      pnlPercent,
      bestTrade,
      worstTrade,
      avgWin,
      avgLoss,
      riskReward,
      positions: recomputed.map(p => ({
        pnlPercent: p.pnlPercent,
        pnlSol: p.pnlSol,
        symbol: p.symbol,
        exitReason: p.exitReason,
      })),
      strategy: 'sniper',
    };
  } finally {
    db.close();
  }
}

const MODE_LABEL = { live: '(live)', dry_run: '(dry_run)' }[process.env.TRADING_MODE] || '(unknown)';

export function buildReportCaption(report) {
  const mode = (process.env.TRADING_MODE || 'dry_run').toUpperCase();
  const strat = String(report.strategy || 'sniper').toUpperCase();
  const dateStr = new Date().toISOString().slice(0, 10);
  const pnlSolSign = report.pnlSol >= 0 ? '+' : '';
  const pnlPctSign = report.pnlPercent >= 0 ? '+' : '';
  const avgWinSign = report.avgWin >= 0 ? '+' : '';
  const avgLossSign = report.avgLoss >= 0 ? '+' : '';

  const bestStr = report.bestTrade
    ? `• 🟢 Best: <b>$${escapeHtml(report.bestTrade.symbol)}</b> <code>${report.bestTrade.pnlPercent >= 0 ? '+' : ''}${report.bestTrade.pnlPercent.toFixed(2)}%</code>`
    : '• 🟢 Best: <i>none</i>';

  const worstStr = report.worstTrade
    ? `• 🔴 Worst: <b>$${escapeHtml(report.worstTrade.symbol)}</b> <code>${report.worstTrade.pnlPercent >= 0 ? '+' : ''}${report.worstTrade.pnlPercent.toFixed(2)}%</code>`
    : '• 🔴 Worst: <i>none</i>';

  return [
    `📊 <b>CHARON DAILY REPORT</b> <code>[${mode}]</code>`,
    `📅 <code>${dateStr} (WIB)</code> · Strategy: <code>${strat}</code>`,
    `━━━━━━━━━━━━━━━━━━━━━`,
    `<b>📈 Performance Summary</b>`,
    `• Net PnL: <b>${pnlSolSign}${report.pnlSol.toFixed(4)} SOL</b> (<code>avg ${pnlPctSign}${report.pnlPercent.toFixed(2)}%</code>)`,
    `• Win Rate: <b>${report.winRate.toFixed(1)}%</b> (${report.wins}W · ${report.losses}L · ${report.totalTrades} Trades)`,
    `• Risk/Reward: <b>1:${report.riskReward.toFixed(2)}</b> (Avg ${avgWinSign}${report.avgWin.toFixed(2)}% / ${avgLossSign}${report.avgLoss.toFixed(2)}%)`,
    ``,
    `<b>🎯 Highlights</b>`,
    bestStr,
    worstStr,
    `━━━━━━━━━━━━━━━━━━━━━`,
  ].join('\n');
}

export async function sendDailyReport(chatId = TELEGRAM_CHAT_ID) {
  let tmpPath = '';
  try {
    const report = await buildDailyReport();
    const buffer = await generateDailyCard(report);
    tmpPath = `/tmp/charon_daily_${new Date().toISOString().slice(0, 10)}.png`;
    writeFileSync(tmpPath, buffer);

    await bot.sendPhoto(chatId, tmpPath, {
      caption: buildReportCaption(report),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    });
    console.log('[dailyReport] sent successfully');
  } catch (err) {
    console.error('[dailyReport] failed:', err.message);
    // fallback text
    const report = await buildDailyReport().catch(() => ({ totalTrades: 0, pnlSol: 0, wins: 0, losses: 0, winRate: 0, pnlPercent: 0, avgWin: 0, avgLoss: 0, riskReward: 0, bestTrade: null, worstTrade: null }));
    const mode = (process.env.TRADING_MODE || 'dry_run').toUpperCase();
    const strat = String(report.strategy || 'sniper').toUpperCase();
    const dateStr = new Date().toISOString().slice(0, 10);
    const pnlSolSign = (report.pnlSol || 0) >= 0 ? '+' : '';
    const pnlPctSign = (report.pnlPercent || 0) >= 0 ? '+' : '';

    const bestStr = report.bestTrade
      ? `• Best Trade: <b>$${escapeHtml(report.bestTrade.symbol)}</b> (<code>${report.bestTrade.pnlPercent >= 0 ? '+' : ''}${report.bestTrade.pnlPercent.toFixed(2)}%</code>)`
      : '• Best Trade: <i>none</i>';

    const worstStr = report.worstTrade
      ? `• Worst Trade: <b>$${escapeHtml(report.worstTrade.symbol)}</b> (<code>${report.worstTrade.pnlPercent >= 0 ? '+' : ''}${report.worstTrade.pnlPercent.toFixed(2)}%</code>)`
      : '• Worst Trade: <i>none</i>';

    const fallbackText = [
      `📊 <b>CHARON DAILY REPORT</b> <code>[${mode}]</code>`,
      `📅 <code>${dateStr} (WIB)</code> · Strategy: <code>${strat}</code>`,
      `━━━━━━━━━━━━━━━━━━━━━`,
      `<b>📈 Summary:</b>`,
      `• Total Trades: <b>${report.totalTrades || 0}</b> (${report.wins || 0}W / ${report.losses || 0}L)`,
      `• Win Rate: <b>${(report.winRate || 0).toFixed(1)}%</b>`,
      `• Realized PnL: <b>${pnlSolSign}${(report.pnlSol || 0).toFixed(4)} SOL</b> (avg <b>${pnlPctSign}${(report.pnlPercent || 0).toFixed(2)}%</b>)`,
      ``,
      `<b>⚖️ Risk & Return:</b>`,
      `• Avg Win: <code>${(report.avgWin || 0) >= 0 ? '+' : ''}${(report.avgWin || 0).toFixed(2)}%</code>`,
      `• Avg Loss: <code>${(report.avgLoss || 0) >= 0 ? '+' : ''}${(report.avgLoss || 0).toFixed(2)}%</code>`,
      `• R:R Ratio: <code>1:${(report.riskReward || 0).toFixed(2)}</code>`,
      ``,
      `<b>🎯 Outliers:</b>`,
      bestStr,
      worstStr,
      `━━━━━━━━━━━━━━━━━━━━━`,
      `<i>⚠️ Image generation fallback mode</i>`,
    ].join('\n');
    try {
      await bot.sendMessage(chatId, fallbackText, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
      });
    } catch { /* give up */ }
  } finally {
    if (tmpPath) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}
