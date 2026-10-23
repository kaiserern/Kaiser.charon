import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'charon-route-test-')), 'db.sqlite');
process.env.GMGN_ENABLED = 'false';

const { initDb } = await import('../src/db/connection.js');
initDb();
const { setSetting } = await import('../src/db/settings.js');
const { routeAllowed } = await import('../src/pipeline/orchestrator.js');

test('route allowlist is open by default', () => {
  assert.equal(routeAllowed('single_source'), true);
  assert.equal(routeAllowed(undefined), true);
});

test('route allowlist admits only listed routes', () => {
  setSetting('allowed_routes', 'pumpfun_pregrad');
  assert.equal(routeAllowed('pumpfun_pregrad'), true);
  assert.equal(routeAllowed('single_source'), false);
  assert.equal(routeAllowed('graduated_trending'), false);
  assert.equal(routeAllowed(''), false);
});

test('route allowlist tolerates spacing and multiple routes', () => {
  setSetting('allowed_routes', ' pumpfun_pregrad , pumpportal_graduated ');
  assert.equal(routeAllowed('pumpportal_graduated'), true);
  assert.equal(routeAllowed('trenches_completed'), false);
});

test('clearing the allowlist reopens every route', () => {
  setSetting('allowed_routes', '');
  assert.equal(routeAllowed('single_source'), true);
});
