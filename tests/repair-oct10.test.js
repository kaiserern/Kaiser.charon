import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(join(tmpdir(), 'charon-repair-'));
process.env.DB_PATH = join(dir, 'test.sqlite');
process.env.GMGN_ENABLED = 'true';
const seed = new Database(process.env.DB_PATH);
seed.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
seed.prepare('INSERT INTO settings VALUES (?,?)').run('gmgn_request_delay_ms', '0');
seed.close();
const fixture = JSON.parse(readFileSync(new URL('./fixtures/momentum-real.json', import.meta.url))).candidate;
const { momentumFilter } = await import('../src/pipeline/momentumFilter.js');
const gmgn = await import('../src/enrichment/gmgn.js');
const originalFetch = global.fetch;

function features(candidate) {
  const code = 'import sys,json;sys.path.insert(0,"src/pipeline");from predict_momentum import extract_features;print(json.dumps(extract_features(json.load(sys.stdin))))';
  const result = spawnSync('python3', ['-c', code], { input: JSON.stringify(candidate), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('Jupiter graduate reaches model rather than false no_price_data', async () => {
  const result = await momentumFilter(fixture);
  assert.notEqual(result.reason, 'no_price_data');
  assert.ok(result.score >= 0 && result.score <= 1, JSON.stringify(result));
});
test('Jupiter Python features carry real spot and matching 5m/1h evidence', () => {
  const f = features(fixture);
  assert.equal(f.price_current, fixture.jupiterAsset.usdPrice);
  assert.ok(Math.abs(f.price_velocity_5m - fixture.jupiterAsset.stats5m.priceChange / 100) < 1e-9);
  assert.equal(f.volume_5m, fixture.jupiterAsset.stats5m.buyVolume + fixture.jupiterAsset.stats5m.sellVolume);
  assert.equal(f.swaps_5m, fixture.jupiterAsset.stats5m.numBuys + fixture.jupiterAsset.stats5m.numSells);
  assert.equal(f.price_1m, 0, 'do not manufacture 1m history from 5m stats');
});
test('missing price and invalid threshold remain fail closed', async () => {
  assert.equal((await momentumFilter({ token: { mint: 'missing' } })).passed, false);
  assert.equal((await momentumFilter(fixture, NaN)).passed, false);
});
test('GMGN historical schema retains exact feature values', () => {
  const f = features({ gmgn: { price: { price: 2, price_1m: 1.8, price_5m: 1, price_1h: .5, volume_5m: 50, volume_1h: 100 } } });
  assert.equal(f.price_current, 2); assert.equal(f.price_velocity_5m, 1); assert.equal(f.volume_5m_ratio, .5);
});
test('numeric GMGN token-info price reaches JS and Python model', async()=>{
 const candidate={ ...fixture, jupiterAsset:null, gmgn:{price:0.001,market_cap:10000},metrics:{...fixture.metrics,priceUsd:0.001} };
 assert.equal(features(candidate).price_current,0.001);
 assert.notEqual((await momentumFilter(candidate)).reason,'no_price_data');
});
test('GMGN queue cannot park execution indefinitely behind discovery', async () => {
  let release;
  global.fetch = () => new Promise(r => { release = r; });
  const first = gmgn.gmgnFetch('/test/first', { deadlineMs: 60 }).then(() => 'ok', e => e.message);
  await new Promise(r => setTimeout(r, 10));
  const second = gmgn.gmgnFetch('/test/second', { deadlineMs: 30 }).then(() => 'ok', e => e.message);
  const result = await Promise.race([second, new Promise(r => setTimeout(() => r('hung'), 120))]);
  release(new Response('{}', { status: 200 }));
  await first;
  assert.match(result, /deadline|timeout/);
  global.fetch = originalFetch;
});
test.after(() => { global.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });
