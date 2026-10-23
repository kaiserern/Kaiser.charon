import fs from 'fs';
import path from 'path';
import { generateDailyCard } from './src/visuals/dailyCard.js';

const outDir = '/home/ubuntu/projects/charon/artifacts/renders';
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

async function run() {
  const profitReport = {
    date: '2026-08-20',
    strategy: 'sniper-v2',
    totalTrades: 18,
    wins: 14,
    losses: 4,
    winRate: 77.78,
    pnlSol: 14.8520,
    pnlPercent: 38.64,
    avgWin: 16.4,
    avgLoss: -6.8,
    riskReward: 2.41,
    bestTrade: { symbol: 'BONK', pnlPercent: 142.8 },
    worstTrade: { symbol: 'WIF', pnlPercent: -10.5 },
    positions: [
      { symbol: 'BONK', pnlPercent: 142.8 },
      { symbol: 'POPCAT', pnlPercent: 36.2 },
      { symbol: 'JUP', pnlPercent: 19.5 },
      { symbol: 'MEW', pnlPercent: -8.4 },
      { symbol: 'BOME', pnlPercent: 24.1 },
      { symbol: 'WIF', pnlPercent: -10.5 },
      { symbol: 'PYTH', pnlPercent: 15.0 },
      { symbol: 'DRIFT', pnlPercent: -5.2 }
    ]
  };

  const lossReport = {
    date: '2026-08-20',
    strategy: 'sniper-v2',
    totalTrades: 15,
    wins: 5,
    losses: 10,
    winRate: 33.33,
    pnlSol: -6.4210,
    pnlPercent: -14.20,
    avgWin: 8.2,
    avgLoss: -11.5,
    riskReward: 0.71,
    bestTrade: { symbol: 'JTO', pnlPercent: 22.4 },
    worstTrade: { symbol: 'POPCAT', pnlPercent: -28.6 },
    positions: [
      { symbol: 'POPCAT', pnlPercent: -28.6 },
      { symbol: 'WIF', pnlPercent: -14.2 },
      { symbol: 'JTO', pnlPercent: 22.4 },
      { symbol: 'BONK', pnlPercent: -9.8 },
      { symbol: 'RAY', pnlPercent: -12.1 },
      { symbol: 'MEW', pnlPercent: 11.5 }
    ]
  };

  const neutralReport = {
    date: '2026-08-20',
    strategy: 'sniper-v2',
    totalTrades: 8,
    wins: 4,
    losses: 4,
    winRate: 50.0,
    pnlSol: 0.0000,
    pnlPercent: 0.00,
    avgWin: 7.5,
    avgLoss: -7.5,
    riskReward: 1.00,
    bestTrade: { symbol: 'SOL', pnlPercent: 12.0 },
    worstTrade: { symbol: 'BONK', pnlPercent: -12.0 },
    positions: [
      { symbol: 'SOL', pnlPercent: 12.0 },
      { symbol: 'BONK', pnlPercent: -12.0 },
      { symbol: 'JUP', pnlPercent: 6.5 },
      { symbol: 'WIF', pnlPercent: -6.5 }
    ]
  };

  const pBuf = await generateDailyCard(profitReport);
  fs.writeFileSync(path.join(outDir, 'sample_profit_v2.png'), pBuf);
  console.log('Generated sample_profit_v2.png:', pBuf.length, 'bytes');

  const lBuf = await generateDailyCard(lossReport);
  fs.writeFileSync(path.join(outDir, 'sample_loss_v2.png'), lBuf);
  console.log('Generated sample_loss_v2.png:', lBuf.length, 'bytes');

  const nBuf = await generateDailyCard(neutralReport);
  fs.writeFileSync(path.join(outDir, 'sample_neutral_v2.png'), nBuf);
  console.log('Generated sample_neutral_v2.png:', nBuf.length, 'bytes');
}

run().catch(console.error);
