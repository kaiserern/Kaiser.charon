const { createCanvas, registerFont } = require('canvas');
const fs = require('fs');
const path = require('path');

// Ensure output dir
const outDir = '/home/ubuntu/.hermes/artifacts';
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Check fonts
const interPath = '/home/ubuntu/.local/share/fonts/Inter-Variable.ttf';
const jbMonoPath = '/home/ubuntu/.local/share/fonts/JetBrainsMono-Variable.ttf';
if (fs.existsSync(interPath)) registerFont(interPath, { family: 'Inter' });
if (fs.existsSync(jbMonoPath)) registerFont(jbMonoPath, { family: 'JetBrainsMono' });

const PALETTE = {
  bgDark: '#030508',
  bgObsidian: '#070B12',
  bgCard: 'rgba(11, 19, 32, 0.75)',
  borderMuted: 'rgba(255, 255, 255, 0.08)',
  borderGlow: 'rgba(0, 242, 157, 0.4)',
  
  // Neon Cybernetics and Arc / Circle Brand Colors
  arcEmerald: '#00F29D',
  arcEmeraldGlow: 'rgba(0, 242, 157, 0.35)',
  arcCyan: '#00E5FF',
  arcCyanGlow: 'rgba(0, 229, 255, 0.35)',
  circleBlue: '#0066FF',
  circleBlueDeep: '#0D3B85',
  circleBlueGlow: 'rgba(0, 102, 255, 0.35)',
  electricIndigo: '#5856D6',
  
  textWhite: '#FFFFFF',
  textSecondary: '#94A3B8',
  textMuted: '#64748B',
  textGhost: '#334155'
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

// -------------------------------------------------------------
// 1. GENERATE LOGO (512x512)
// -------------------------------------------------------------
function generateLogo() {
  const size = 512;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;

  // Background gradient: Deep obsidian with radial cybernetic falloff
  const bgGrad = ctx.createRadialGradient(cx, cy, 30, cx, cy, size * 0.72);
  bgGrad.addColorStop(0, '#0A1322');
  bgGrad.addColorStop(0.5, '#050912');
  bgGrad.addColorStop(1, '#020407');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, size, size);

  // Ambient glow orbs
  const glow1 = ctx.createRadialGradient(cx, cy, 10, cx, cy, 220);
  glow1.addColorStop(0, 'rgba(0, 229, 255, 0.18)');
  glow1.addColorStop(0.5, 'rgba(0, 242, 157, 0.12)');
  glow1.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, size, size);

  // Subtle circular radar and telemetry grid
  ctx.save();
  ctx.lineWidth = 1;
  [80, 140, 195, 235].forEach((r, idx) => {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(0, 229, 255, ${0.05 + idx * 0.02})`;
    ctx.stroke();
  });

  // Crosshairs and precision hash marks
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.beginPath();
  ctx.moveTo(cx - 240, cy); ctx.lineTo(cx - 210, cy);
  ctx.moveTo(cx + 210, cy); ctx.lineTo(cx + 240, cy);
  ctx.moveTo(cx, cy - 240); ctx.lineTo(cx, cy - 210);
  ctx.moveTo(cx, cy + 210); ctx.lineTo(cx, cy + 240);
  ctx.stroke();

  // Angular telemetry ticks on 195 radius
  ctx.save();
  ctx.translate(cx, cy);
  for (let i = 0; i < 36; i++) {
    const angle = (i * 10 * Math.PI) / 180;
    const len = i % 9 === 0 ? 12 : i % 3 === 0 ? 6 : 3;
    const r1 = 205;
    const r2 = r1 + len;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * r1, Math.sin(angle) * r1);
    ctx.lineTo(Math.cos(angle) * r2, Math.sin(angle) * r2);
    ctx.strokeStyle = i % 9 === 0 ? PALETTE.arcEmerald : 'rgba(0, 229, 255, 0.25)';
    ctx.lineWidth = i % 9 === 0 ? 2 : 1;
    ctx.stroke();
  }
  ctx.restore();

  // OUTER ARC: Electric Emerald and Cyan Dynamic Segment
  ctx.save();
  ctx.shadowColor = PALETTE.arcEmerald;
  ctx.shadowBlur = 18;
  ctx.lineWidth = 8;
  const outerArcGrad = ctx.createLinearGradient(cx - 180, cy - 180, cx + 180, cy + 180);
  outerArcGrad.addColorStop(0, PALETTE.arcEmerald);
  outerArcGrad.addColorStop(0.5, PALETTE.arcCyan);
  outerArcGrad.addColorStop(1, PALETTE.circleBlue);
  ctx.strokeStyle = outerArcGrad;

  // Segment 1 (Top-Right to Bottom Arc)
  ctx.beginPath();
  ctx.arc(cx, cy, 168, -0.6 * Math.PI, 0.85 * Math.PI);
  ctx.stroke();

  // Segment 2 (Opposite counter-arc with smaller radius)
  ctx.beginPath();
  ctx.arc(cx, cy, 168, 1.1 * Math.PI, 1.35 * Math.PI);
  ctx.stroke();
  ctx.restore();

  // SECONDARY ARC: Intersecting Circle Blue Core Ring (Circle homage)
  ctx.save();
  ctx.shadowColor = PALETTE.circleBlue;
  ctx.shadowBlur = 22;
  ctx.lineWidth = 5;
  const innerArcGrad = ctx.createLinearGradient(cx - 120, cy + 120, cx + 120, cy - 120);
  innerArcGrad.addColorStop(0, '#00D4FF');
  innerArcGrad.addColorStop(0.5, PALETTE.circleBlue);
  innerArcGrad.addColorStop(1, PALETTE.electricIndigo);
  ctx.strokeStyle = innerArcGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, 126, 0.4 * Math.PI, 1.75 * Math.PI);
  ctx.stroke();
  ctx.restore();

  // Orbital Satellite Nodes / Micro Data Cores
  const nodes = [
    { angle: -0.6 * Math.PI, r: 168, color: PALETTE.arcEmerald, size: 6 },
    { angle: 0.85 * Math.PI, r: 168, color: PALETTE.arcCyan, size: 6 },
    { angle: 0.4 * Math.PI, r: 126, color: '#00D4FF', size: 5 },
    { angle: 1.75 * Math.PI, r: 126, color: PALETTE.electricIndigo, size: 5 },
  ];
  nodes.forEach(n => {
    const nx = cx + Math.cos(n.angle) * n.r;
    const ny = cy + Math.sin(n.angle) * n.r;
    ctx.save();
    ctx.shadowColor = n.color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(nx, ny, n.size, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = n.color;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.restore();
  });

  // CENTER CORE: Geometric Futuristic AI Monogram ("A" Prism and Neural Core)
  ctx.save();
  ctx.shadowColor = PALETTE.arcCyan;
  ctx.shadowBlur = 25;

  // Prism Apex coordinates
  const topX = cx;
  const topY = cy - 72;
  const leftX = cx - 62;
  const leftY = cy + 54;
  const rightX = cx + 62;
  const rightY = cy + 54;

  // Draw multifaceted faceted A-prism
  // Left facet
  const leftGrad = ctx.createLinearGradient(leftX, topY, cx, leftY);
  leftGrad.addColorStop(0, PALETTE.arcEmerald);
  leftGrad.addColorStop(1, PALETTE.circleBlue);
  ctx.fillStyle = leftGrad;
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(cx, cy);
  ctx.lineTo(leftX, leftY);
  ctx.lineTo(topX - 18, topY + 45);
  ctx.closePath();
  ctx.fill();

  // Right facet
  const rightGrad = ctx.createLinearGradient(rightX, topY, cx, rightY);
  rightGrad.addColorStop(0, PALETTE.arcCyan);
  rightGrad.addColorStop(1, PALETTE.circleBlue);
  ctx.fillStyle = rightGrad;
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(rightX, rightY);
  ctx.lineTo(cx, cy);
  ctx.closePath();
  ctx.fill();

  // Center glowing diamond / Neural Singularity
  const coreGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, 32);
  coreGrad.addColorStop(0, '#FFFFFF');
  coreGrad.addColorStop(0.3, PALETTE.arcCyan);
  coreGrad.addColorStop(0.8, PALETTE.circleBlue);
  coreGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 28);
  ctx.lineTo(cx + 28, cy);
  ctx.lineTo(cx, cy + 28);
  ctx.lineTo(cx - 28, cy);
  ctx.closePath();
  ctx.fill();

  // Sharp outer stroke of the core Prism
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(rightX, rightY);
  ctx.lineTo(cx + 18, rightY - 14);
  ctx.lineTo(cx - 18, leftY - 14);
  ctx.lineTo(leftX, leftY);
  ctx.closePath();
  ctx.stroke();

  // Horizontal Cybernetic Stabilizer Crossbeam
  ctx.strokeStyle = PALETTE.arcEmerald;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(cx - 44, cy + 16);
  ctx.lineTo(cx + 44, cy + 16);
  ctx.stroke();

  // Center spark
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Precision Telemetry Label at bottom rim
  ctx.font = 'bold 11px "JetBrainsMono", monospace';
  ctx.fillStyle = 'rgba(0, 242, 157, 0.7)';
  ctx.textAlign = 'center';
  ctx.fillText('ARC // AI-AGENT v1.0', cx, size - 28);
  
  ctx.font = '600 9px "JetBrainsMono", monospace';
  ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
  ctx.fillText('NATIVE SETTLEMENT LAYER', cx, size - 14);

  // Outer border chamfer ring
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(1, 1, size - 2, size - 2);

  return canvas.toBuffer('image/png');
}

// -------------------------------------------------------------
// 2. GENERATE TOKEN ICON (512x512 CIRCLE CROPPED FOR LAUNCHPADS)
// -------------------------------------------------------------
function generateTokenIcon() {
  const size = 512;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const r = 246; // Safe padding inside 512

  // Circular clip for clean launchpad rendering (transparent edges)
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();

  // High-contrast Radial Background
  const bgGrad = ctx.createRadialGradient(cx, cy, 20, cx, cy, r);
  bgGrad.addColorStop(0, '#0B1627');
  bgGrad.addColorStop(0.65, '#050912');
  bgGrad.addColorStop(1, '#020306');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, size, size);

  // Concentric Rings
  [70, 130, 180, 220].forEach(cr => {
    ctx.beginPath();
    ctx.arc(cx, cy, cr, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.stroke();
  });

  // Outer Glowing Bezel
  ctx.save();
  ctx.shadowColor = PALETTE.arcEmerald;
  ctx.shadowBlur = 24;
  ctx.strokeStyle = PALETTE.arcEmerald;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(cx, cy, 224, -0.6 * Math.PI, 0.8 * Math.PI);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.shadowColor = PALETTE.circleBlue;
  ctx.shadowBlur = 24;
  ctx.strokeStyle = PALETTE.circleBlue;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(cx, cy, 224, 0.9 * Math.PI, 1.3 * Math.PI);
  ctx.stroke();
  ctx.restore();

  // Core Arc AI Mark
  ctx.save();
  ctx.shadowColor = PALETTE.arcCyan;
  ctx.shadowBlur = 28;

  // Intersecting Inner Circle
  ctx.lineWidth = 5;
  const innerGrad = ctx.createLinearGradient(cx - 140, cy - 140, cx + 140, cy + 140);
  innerGrad.addColorStop(0, PALETTE.arcCyan);
  innerGrad.addColorStop(0.5, PALETTE.circleBlue);
  innerGrad.addColorStop(1, PALETTE.arcEmerald);
  ctx.strokeStyle = innerGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, 145, 0, Math.PI * 2);
  ctx.stroke();

  // Glowing nodes
  for (let i = 0; i < 6; i++) {
    const angle = (i * 60 * Math.PI) / 180;
    const nx = cx + Math.cos(angle) * 145;
    const ny = cy + Math.sin(angle) * 145;
    ctx.fillStyle = i % 2 === 0 ? PALETTE.arcEmerald : PALETTE.arcCyan;
    ctx.beginPath();
    ctx.arc(nx, ny, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Futuristic 'A' Core
  const topX = cx;
  const topY = cy - 85;
  const leftX = cx - 74;
  const leftY = cy + 65;
  const rightX = cx + 74;
  const rightY = cy + 65;

  ctx.fillStyle = 'rgba(0, 229, 255, 0.15)';
  ctx.beginPath();
  ctx.moveTo(topX, topY);
  ctx.lineTo(rightX, rightY);
  ctx.lineTo(leftX, leftY);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(leftX, leftY);
  ctx.lineTo(topX, topY);
  ctx.lineTo(rightX, rightY);
  ctx.stroke();

  // Horizontal AI Bridge
  ctx.strokeStyle = PALETTE.arcEmerald;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(cx - 48, cy + 18);
  ctx.lineTo(cx + 48, cy + 18);
  ctx.stroke();

  // Quantum core spark
  const coreGrad = ctx.createRadialGradient(cx, cy, 2, cx, cy, 28);
  coreGrad.addColorStop(0, '#FFFFFF');
  coreGrad.addColorStop(0.5, PALETTE.arcCyan);
  coreGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = coreGrad;
  ctx.beginPath();
  ctx.arc(cx, cy, 28, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
  ctx.restore(); // Restore clip

  // Crisp Border Rim
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  return canvas.toBuffer('image/png');
}

// -------------------------------------------------------------
// 3. GENERATE X/TWITTER BANNER (1500x500)
// -------------------------------------------------------------
function generateBanner() {
  const W = 1500;
  const H = 500;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Deep Obsidian / Cybernetic Grid Space
  const bgGrad = ctx.createRadialGradient(W * 0.72, H * 0.5, 50, W * 0.6, H * 0.5, 900);
  bgGrad.addColorStop(0, '#0B172B');
  bgGrad.addColorStop(0.45, '#050A14');
  bgGrad.addColorStop(1, '#020306');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  // Ambient glows
  const orbRight = ctx.createRadialGradient(W - 320, H / 2, 20, W - 320, H / 2, 400);
  orbRight.addColorStop(0, 'rgba(0, 229, 255, 0.25)');
  orbRight.addColorStop(0.6, 'rgba(0, 242, 157, 0.15)');
  orbRight.addColorStop(1, 'transparent');
  ctx.fillStyle = orbRight;
  ctx.fillRect(0, 0, W, H);

  const orbBlue = ctx.createRadialGradient(400, 100, 10, 400, 100, 450);
  orbBlue.addColorStop(0, 'rgba(0, 102, 255, 0.2)');
  orbBlue.addColorStop(1, 'transparent');
  ctx.fillStyle = orbBlue;
  ctx.fillRect(0, 0, W, H);

  // Perspective Cybernetic Matrix Grid at Bottom
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.07)';
  ctx.lineWidth = 1;
  const gridY = 320;
  for (let x = -200; x < W + 400; x += 60) {
    ctx.beginPath();
    ctx.moveTo(x, H);
    ctx.lineTo(W * 0.6 + (x - W * 0.6) * 0.3, gridY);
    ctx.stroke();
  }
  for (let y = gridY; y < H; y += 30) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }
  ctx.restore();

  // Subtle Matrix Dots
  ctx.save();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
  for (let x = 40; x < W; x += 36) {
    for (let y = 30; y < 320; y += 36) {
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();

  // LEFT CONTENT: Typography & Narrative (Safe from Avatar at bottom-left)
  const textLeft = 140;

  // Header Sub-bar / Kicker
  roundRect(ctx, textLeft, 70, 220, 28, 6);
  ctx.fillStyle = 'rgba(0, 242, 157, 0.12)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 242, 157, 0.35)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = 'bold 11px "JetBrainsMono", monospace';
  ctx.fillStyle = PALETTE.arcEmerald;
  ctx.fillText('● ARC NATIVE AI PROTOCOL', textLeft + 14, 88);

  // Main Headline
  ctx.font = 'bold 54px "Inter", sans-serif';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText('ARC // AGENT', textLeft, 156);

  // Gradient Accent Line under title
  const titleLineGrad = ctx.createLinearGradient(textLeft, 172, textLeft + 380, 172);
  titleLineGrad.addColorStop(0, PALETTE.arcEmerald);
  titleLineGrad.addColorStop(0.5, PALETTE.arcCyan);
  titleLineGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = titleLineGrad;
  ctx.fillRect(textLeft, 172, 380, 3);

  // Value Proposition / Subtitle
  ctx.font = '500 18px "Inter", sans-serif';
  ctx.fillStyle = '#94A3B8';
  ctx.fillText('The Autonomous AI Execution Engine on Arc Settlement Layer', textLeft, 214);

  // Feature Badges (3 horizontal chips)
  const badges = [
    { label: 'CIRCLE USDC', sub: 'Native Settlement', color: PALETTE.circleBlue },
    { label: '< 1.2s FINALITY', sub: 'High-Throughput', color: PALETTE.arcCyan },
    { label: 'ERC-4337', sub: 'Autonomous Safe', color: PALETTE.arcEmerald },
  ];

  badges.forEach((b, i) => {
    const bx = textLeft + i * 180;
    const by = 250;
    const bw = 165;
    const bh = 54;
    roundRect(ctx, bx, by, bw, bh, 10);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.7)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Top accent indicator
    roundRect(ctx, bx + 12, by + 10, 8, 8, 2);
    ctx.fillStyle = b.color;
    ctx.fill();

    ctx.font = 'bold 12px "JetBrainsMono", monospace';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(b.label, bx + 28, by + 20);

    ctx.font = '500 10px "Inter", sans-serif';
    ctx.fillStyle = '#64748B';
    ctx.fillText(b.sub, bx + 14, by + 40);
  });

  // Telemetry Terminal Box (Bottom row safe zone)
  const termX = textLeft;
  const termY = 325;
  const termW = 525;
  const termH = 115;
  roundRect(ctx, termX, termY, termW, termH, 12);
  ctx.fillStyle = 'rgba(7, 12, 22, 0.85)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(0, 229, 255, 0.2)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Terminal header bar
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
  roundRect(ctx, termX, termY, termW, 26, 8);
  ctx.fill();

  ctx.fillStyle = '#EF4444'; ctx.beginPath(); ctx.arc(termX + 16, termY + 13, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#F59E0B'; ctx.beginPath(); ctx.arc(termX + 30, termY + 13, 4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#10B981'; ctx.beginPath(); ctx.arc(termX + 44, termY + 13, 4, 0, Math.PI * 2); ctx.fill();

  ctx.font = '600 10px "JetBrainsMono", monospace';
  ctx.fillStyle = '#64748B';
  ctx.fillText('agent@arc-settlement:~ (telemetry-feed)', termX + 60, termY + 17);

  // Terminal content
  ctx.font = '500 11px "JetBrainsMono", monospace';
  ctx.fillStyle = PALETTE.arcEmerald;
  ctx.fillText('> [SYS:INIT] Verified Arc L2 execution bridge connected.', termX + 16, termY + 50);
  ctx.fillStyle = PALETTE.arcCyan;
  ctx.fillText('> [AGENT:RUN] Autonomous liquidity & order routing active.', termX + 16, termY + 72);
  ctx.fillStyle = '#94A3B8';
  ctx.fillText('> [SETTLE] Circle CCTP zero-slippage pool synced (ID: #ARC-8829).', termX + 16, termY + 94);

  // RIGHT CONTENT: Massive Holographic Arc AI Engine Illustration
  const engineX = W - 340;
  const engineY = H / 2;

  // Concentric Orbitals
  [210, 165, 125, 85].forEach((r, idx) => {
    ctx.save();
    ctx.beginPath();
    ctx.arc(engineX, engineY, r, 0, Math.PI * 2);
    ctx.strokeStyle = idx % 2 === 0 ? 'rgba(0, 229, 255, 0.15)' : 'rgba(0, 242, 157, 0.12)';
    ctx.setLineDash(idx % 2 === 0 ? [8, 12] : [4, 8]);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  });

  // Main dynamic glowing Arc Rings
  ctx.save();
  ctx.shadowColor = PALETTE.arcEmerald;
  ctx.shadowBlur = 32;
  ctx.lineWidth = 7;
  const arcGrad = ctx.createLinearGradient(engineX - 160, engineY - 160, engineX + 160, engineY + 160);
  arcGrad.addColorStop(0, PALETTE.arcEmerald);
  arcGrad.addColorStop(0.5, PALETTE.arcCyan);
  arcGrad.addColorStop(1, PALETTE.circleBlue);
  ctx.strokeStyle = arcGrad;
  ctx.beginPath();
  ctx.arc(engineX, engineY, 155, -0.75 * Math.PI, 0.65 * Math.PI);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.shadowColor = PALETTE.circleBlue;
  ctx.shadowBlur = 35;
  ctx.lineWidth = 5;
  ctx.strokeStyle = PALETTE.circleBlue;
  ctx.beginPath();
  ctx.arc(engineX, engineY, 115, 0.3 * Math.PI, 1.8 * Math.PI);
  ctx.stroke();
  ctx.restore();

  // Central Hologram Monogram 'A'
  ctx.save();
  ctx.shadowColor = PALETTE.arcCyan;
  ctx.shadowBlur = 30;

  const topPX = engineX;
  const topPY = engineY - 65;
  const leftPX = engineX - 55;
  const leftPY = engineY + 45;
  const rightPX = engineX + 55;
  const rightPY = engineY + 45;

  ctx.fillStyle = 'rgba(0, 229, 255, 0.2)';
  ctx.beginPath();
  ctx.moveTo(topPX, topPY);
  ctx.lineTo(rightPX, rightPY);
  ctx.lineTo(leftPX, leftPY);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(leftPX, leftPY);
  ctx.lineTo(topPX, topPY);
  ctx.lineTo(rightPX, rightPY);
  ctx.stroke();

  ctx.strokeStyle = PALETTE.arcEmerald;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(engineX - 35, engineY + 10);
  ctx.lineTo(engineX + 35, engineY + 10);
  ctx.stroke();

  // Center Core Singularity
  const singGrad = ctx.createRadialGradient(engineX, engineY, 2, engineX, engineY, 25);
  singGrad.addColorStop(0, '#FFFFFF');
  singGrad.addColorStop(0.4, PALETTE.arcCyan);
  singGrad.addColorStop(1, 'transparent');
  ctx.fillStyle = singGrad;
  ctx.beginPath();
  ctx.arc(engineX, engineY, 25, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Precision HUD Crosshairs & Telemetry on Right
  ctx.font = '600 10px "JetBrainsMono", monospace';
  ctx.fillStyle = 'rgba(0, 242, 157, 0.65)';
  ctx.fillText('ARC_SYS // 0xARC...F29D', engineX - 60, engineY + 195);
  ctx.fillStyle = 'rgba(0, 229, 255, 0.5)';
  ctx.fillText('STATUS: SYNCHRONIZED', engineX - 52, engineY + 210);

  // Border Frame
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = 1;
  ctx.strokeRect(0, 0, W, H);

  return canvas.toBuffer('image/png');
}

// -------------------------------------------------------------
// EXECUTE AND WRITE
// -------------------------------------------------------------
const logoBuffer = generateLogo();
fs.writeFileSync(path.join(outDir, 'arc_agent_logo_512x512.png'), logoBuffer);
console.log('Logo generated:', path.join(outDir, 'arc_agent_logo_512x512.png'), logoBuffer.length, 'bytes');

const tokenIconBuffer = generateTokenIcon();
fs.writeFileSync(path.join(outDir, 'arc_agent_token_icon_512x512.png'), tokenIconBuffer);
console.log('Token Icon generated:', path.join(outDir, 'arc_agent_token_icon_512x512.png'), tokenIconBuffer.length, 'bytes');

const bannerBuffer = generateBanner();
fs.writeFileSync(path.join(outDir, 'arc_agent_banner_1500x500.png'), bannerBuffer);
console.log('Banner generated:', path.join(outDir, 'arc_agent_banner_1500x500.png'), bannerBuffer.length, 'bytes');
