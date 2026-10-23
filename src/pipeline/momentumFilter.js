/**
 * Momentum filter — calls Python ML model to predict if a candidate
 * will be a runner (TRAILING_TP) or sideways (MAX_HOLD).
 * 
 * SAFETY: If the model fails or times out, rejects the candidate; missing evidence is not a successful check.
 */

import { momentumResult } from '../execution/paperSafety.js';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON_SCRIPT = path.join(__dirname, 'predict_momentum.py');
const TIMEOUT_MS = 8000; // 8 seconds max for Python
const DEFAULT_THRESHOLD = 0.5;

/**
 * Score a candidate using the momentum model.
 * Spawns a fresh Python process per request (model is small, loads fast).
 */
export async function momentumFilter(candidate, threshold = DEFAULT_THRESHOLD) {
  const startTime = Date.now();
  const mint = candidate.token?.mint?.slice(0, 8) || 'unknown';
  
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    return { passed: false, score: -1, reason: 'invalid_threshold' };
  }
  // Spot evidence can come from either enrichment schema. Historical windows
  // are handled in Python; never manufacture history by repeating spot values.
  const gmgnPrice = candidate.gmgn?.price;
  const prices = [typeof gmgnPrice === 'object' ? gmgnPrice?.price : gmgnPrice, candidate.jupiterAsset?.usdPrice, candidate.metrics?.priceUsd];
  if (!prices.some(value => Number.isFinite(Number(value)) && Number(value) > 0)) {
    console.log(`[momentum] ${mint}... no price data — blocked`);
    return { passed: false, score: -1, reason: 'no_price_data' };
  }
  
  return new Promise((resolve) => {
    const proc = spawn('python3', [PYTHON_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
    });
    
    let stdout = '';
    let stderr = '';
    let resolved = false;
    
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      try { proc.kill(); } catch (e) { /* ignore */ }
      resolve(result);
    };
    
    const timeout = setTimeout(() => {
      stderr && console.error(`[momentum] ${mint}... stderr: ${stderr.trim()}`);
      console.error(`[momentum] ${mint}... timeout after ${TIMEOUT_MS}ms — blocked`);
      finish({ passed: false, score: -1, reason: 'timeout' });
    }, TIMEOUT_MS);
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('error', (err) => {
      clearTimeout(timeout);
      console.error(`[momentum] ${mint}... spawn error: ${err.message} — blocked`);
      finish({ passed: false, score: -1, reason: err.message });
    });
    
    proc.on('close', (code) => {
      clearTimeout(timeout);
      
      if (code !== 0) {
        console.error(`[momentum] ${mint}... exit code ${code} — blocked`);
        finish({ passed: false, score: -1, reason: `exit_${code}` });
        return;
      }
      
      try {
        const result = JSON.parse(stdout.trim());
        const validated = momentumResult(result, threshold);
        const score = validated.score;
        
        if (score < 0) {
          console.error(`[momentum] ${mint}... model error: ${result.error} — blocked`);
          finish({ passed: false, score: -1, reason: result.error });
          return;
        }
        
        const passed = score >= threshold;
        const latency = Date.now() - startTime;
        
        if (!passed) {
          console.log(`[momentum] ${mint}... REJECTED score=${score.toFixed(3)} < ${threshold} (${latency}ms)`);
        } else {
          console.log(`[momentum] ${mint}... PASSED score=${score.toFixed(3)} (${latency}ms)`);
        }
        
        finish({ passed, score, latency });
      } catch (e) {
        console.error(`[momentum] ${mint}... JSON parse error: ${e.message} — blocked`);
        finish({ passed: false, score: -1, reason: 'parse_error' });
      }
    });
    
    // Send candidate JSON to Python
    const input = JSON.stringify({ candidate });
    proc.stdin.on('error', () => { clearTimeout(timeout); finish({ passed: false, score: -1, reason: 'stdin_error' }); });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

/**
 * Synchronous fallback — cannot validate ML evidence.
 */
export function momentumScoreSync(candidate) {
  return { passed: false, score: -1, reason: 'sync_fallback' };
}

/**
 * Get the current momentum threshold from strategy.
 */
export function getMomentumThreshold(strat) {
  return strat?.momentum_threshold ?? DEFAULT_THRESHOLD;
}