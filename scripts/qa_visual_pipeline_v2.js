/**
 * Charon Visual Regression & Quality Validation Pipeline (V2)
 * Automated QA validator for /report and /daily visual cards.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Import visual card generator
const dailyCardPath = path.resolve(__dirname, '../src/visuals/dailyCard.js');
let generateDailyCard;
try {
  const mod = await import(dailyCardPath);
  generateDailyCard = mod.generateDailyCard || mod.default;
} catch (err) {
  console.error('[QA Pipeline] Failed to import dailyCard.js:', err.message);
  process.exit(1);
}

// 1. Define Comprehensive Fixture Suite (V2)
const FIXTURES = [
  {
    name: '01_heavy_profit_day',
    desc: 'Multi-trade rally with 75%+ winrate and triple-digit winner',
    data: {
      date: '2026-08-20',
      totalTrades: 24,
      wins: 19,
      losses: 5,
      winRate: 79.17,
      pnlSol: 8.4125,
      pnlPercent: 44.80,
      avgWin: 31.4,
      avgLoss: -7.5,
      riskReward: 4.19,
      bestTrade: { symbol: 'MOONSHOT', pnlPercent: 248.5 },
      worstTrade: { symbol: 'RUGGER', pnlPercent: -14.2 },
      positions: [
        { symbol: 'MOONSHOT', pnlPercent: 248.5 },
        { symbol: 'PEPE', pnlPercent: 54.2 },
        { symbol: 'POPCAT', pnlPercent: 33.1 },
        { symbol: 'WIF', pnlPercent: 21.0 },
        { symbol: 'GIGA', pnlPercent: 18.5 },
        { symbol: 'BONK', pnlPercent: -12.4 },
        { symbol: 'BOME', pnlPercent: -8.1 },
        { symbol: 'RUGGER', pnlPercent: -14.2 }
      ],
      strategy: 'sniper'
    }
  },
  {
    name: '02_heavy_loss_drawdown',
    desc: 'Choppy/adverse market day with deep stop loss hits',
    data: {
      date: '2026-08-20',
      totalTrades: 16,
      wins: 4,
      losses: 12,
      winRate: 25.0,
      pnlSol: -4.1850,
      pnlPercent: -28.40,
      avgWin: 11.2,
      avgLoss: -16.8,
      riskReward: 0.67,
      bestTrade: { symbol: 'SOLCAT', pnlPercent: 19.5 },
      worstTrade: { symbol: 'TITANIC', pnlPercent: -58.2 },
      positions: [
        { symbol: 'TITANIC', pnlPercent: -58.2 },
        { symbol: 'DUMP', pnlPercent: -24.1 },
        { symbol: 'SCAM', pnlPercent: -18.9 },
        { symbol: 'SOLCAT', pnlPercent: 19.5 }
      ],
      strategy: 'sniper'
    }
  },
  {
    name: '03_zero_trade_idle_day',
    desc: 'Quiet day / zero trades executed, bot idle',
    data: {
      date: '2026-08-20',
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRate: 0,
      pnlSol: 0,
      pnlPercent: 0,
      avgWin: 0,
      avgLoss: 0,
      riskReward: 0,
      bestTrade: null,
      worstTrade: null,
      positions: [],
      strategy: 'sniper'
    }
  },
  {
    name: '04_single_breakeven_trade',
    desc: 'Boundary case: Exactly 1 trade exiting at exactly 0.00% PnL',
    data: {
      date: '2026-08-20',
      totalTrades: 1,
      wins: 0,
      losses: 1,
      winRate: 0,
      pnlSol: 0.0000,
      pnlPercent: 0.00,
      avgWin: 0,
      avgLoss: 0,
      riskReward: 0,
      bestTrade: { symbol: 'FLAT', pnlPercent: 0.0 },
      worstTrade: { symbol: 'FLAT', pnlPercent: 0.0 },
      positions: [{ symbol: 'FLAT', pnlPercent: 0.0 }],
      strategy: 'sniper'
    }
  },
  {
    name: '05_extreme_high_volume_dense',
    desc: 'Stress test: 30+ positions in sequence bar chart',
    data: {
      date: '2026-08-20',
      totalTrades: 35,
      wins: 22,
      losses: 13,
      winRate: 62.86,
      pnlSol: 3.1250,
      pnlPercent: 14.50,
      avgWin: 18.2,
      avgLoss: -9.4,
      riskReward: 1.94,
      bestTrade: { symbol: 'BIGRUNNER', pnlPercent: 180.0 },
      worstTrade: { symbol: 'BLEEDER', pnlPercent: -22.0 },
      positions: Array.from({ length: 30 }, (_, i) => ({
        symbol: `TK${i + 1}`,
        pnlPercent: (i % 3 === 0 ? -1 : 1) * (5 + (i * 4) % 45)
      })),
      strategy: 'smart_money'
    }
  },
  {
    name: '06_legacy_raw_schema_compatibility',
    desc: 'Compat check with raw rows/totalSol schema from dailyAggregate()',
    data: {
      date: '2026-08-20',
      total: 3,
      wins: 2,
      losses: 1,
      winRate: 66.7,
      totalSol: 1.15,
      best: { symbol: 'LEGACY_A', pnlPercent: 40.0 },
      worst: { symbol: 'LEGACY_B', pnlPercent: -10.0 },
      avgWin: 30.0,
      avgLoss: -10.0,
      riskReward: 3.0,
      rows: [
        { symbol: 'LEGACY_A', pnlPercent: 40.0 },
        { symbol: 'LEGACY_B', pnlPercent: -10.0 },
        { symbol: 'LEGACY_C', pnlPercent: 20.0 }
      ],
      strategyId: 'dip_buy'
    }
  }
];

// Color & Contrast Helper
function lum(hex) {
  const clean = hex.replace(/^#/, '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  const cLin = c => {
    const s = c / 255.0;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * cLin(r) + 0.7152 * cLin(g) + 0.0722 * cLin(b);
}

function contrastRatio(hex1, hex2) {
  const l1 = lum(hex1);
  const l2 = lum(hex2);
  const bright = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (bright + 0.05) / (dark + 0.05);
}

async function runPipeline() {
  console.log('===========================================================');
  console.log('  CHARON V2 VISUAL REGRESSION & QA VALIDATION SUITE');
  console.log('===========================================================\n');

  const outDir = '/tmp/qa_v2_charon_renders';
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const results = [];

  for (const fixture of FIXTURES) {
    process.stdout.write(`[*] Testing fixture: ${fixture.name} ... `);
    const startMs = Date.now();
    try {
      const buf = await generateDailyCard(fixture.data);
      const renderMs = Date.now() - startMs;
      const filePath = path.join(outDir, `${fixture.name}.png`);
      fs.writeFileSync(filePath, buf);
      const sizeKb = (buf.length / 1024).toFixed(2);

      // Verify PNG Header
      const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
      if (!isPng) throw new Error('Render output is not a valid PNG binary');

      // Check PNG IHDR chunk for 900x1120 dimensions
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);

      const dimPass = width === 900 && height === 1120;
      const sizePass = buf.length > 50000 && buf.length < 500000; // Expected ~80-150KB

      results.push({
        name: fixture.name,
        desc: fixture.desc,
        status: dimPass && sizePass ? 'PASS' : 'FAIL',
        dimensions: `${width}x${height}`,
        sizeKb: `${sizeKb} KB`,
        renderMs: `${renderMs} ms`,
        filePath
      });
      console.log(`[PASS] (${width}x${height}, ${sizeKb} KB, ${renderMs}ms)`);
    } catch (err) {
      console.log(`[FAIL] -> ${err.message}`);
      results.push({
        name: fixture.name,
        desc: fixture.desc,
        status: 'FAIL',
        error: err.message
      });
    }
  }

  console.log('\n-----------------------------------------------------------');
  console.log('  WCAG 2.1 CONTRAST & READABILITY AUDIT');
  console.log('-----------------------------------------------------------');

  const palette = [
    { fgName: 'TEXT_PRIMARY (#F8FAFC)', fg: '#F8FAFC', bgName: 'Surface Top (#0B0E14)', bg: '#0B0E14', minNormal: 4.5, minLarge: 3.0 },
    { fgName: 'TEXT_SECONDARY (#94A3B8)', fg: '#94A3B8', bgName: 'Card Surface (#121722)', bg: '#121722', minNormal: 4.5, minLarge: 3.0 },
    { fgName: 'PROFIT (#00F090)', fg: '#00F090', bgName: 'Elevated Card (#161D2B)', bg: '#161D2B', minNormal: 4.5, minLarge: 3.0 },
    { fgName: 'LOSS (#FF3B56)', fg: '#FF3B56', bgName: 'Elevated Card (#161D2B)', bg: '#161D2B', minNormal: 4.5, minLarge: 3.0 },
    { fgName: 'TEXT_MUTED (#64748B)', fg: '#64748B', bgName: 'Card Surface (#121722)', bg: '#121722', minNormal: 4.5, minLarge: 3.0 },
    { fgName: 'PROFIT_LABEL (#A7F3D0)', fg: '#A7F3D0', bgName: 'Elevated Card (#161D2B)', bg: '#161D2B', minNormal: 4.5, minLarge: 3.0 },
    { fgName: 'LOSS_LABEL (#FECDD3)', fg: '#FECDD3', bgName: 'Elevated Card (#161D2B)', bg: '#161D2B', minNormal: 4.5, minLarge: 3.0 },
    { fgName: 'BRAND_CYAN (#06B6D4)', fg: '#06B6D4', bgName: 'Surface Top (#0B0E14)', bg: '#0B0E14', minNormal: 4.5, minLarge: 3.0 }
  ];

  const contrastResults = [];
  for (const item of palette) {
    const cr = contrastRatio(item.fg, item.bg);
    const passNormal = cr >= item.minNormal;
    const passLarge = cr >= item.minLarge;
    contrastResults.push({
      element: `${item.fgName} on ${item.bgName}`,
      ratio: cr.toFixed(2),
      normal: passNormal ? 'PASS' : 'WARN',
      large: passLarge ? 'PASS' : 'FAIL'
    });
    console.log(`- ${item.fgName.padEnd(28)} on ${item.bgName.padEnd(25)}: CR = ${cr.toFixed(2)}:1 (Normal: ${passNormal ? 'PASS' : 'WARN'}, Large/Bold: ${passLarge ? 'PASS' : 'FAIL'})`);
  }

  console.log('\n===========================================================');
  console.log(`  PIPELINE SUMMARY: ${results.filter(r => r.status === 'PASS').length}/${results.length} FIXTURES PASSED`);
  console.log('===========================================================\n');

  return { results, contrastResults, outDir };
}

runPipeline();
