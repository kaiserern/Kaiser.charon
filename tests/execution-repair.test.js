import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
const dir = mkdtempSync(join(tmpdir(), 'charon-execution-test-'));
process.env.DB_PATH = join(dir, 'db.sqlite');
process.env.GMGN_ENABLED = 'false';
const { db, initDb } = await import('../src/db/connection.js');
initDb();
const { setSetting } = await import('../src/db/settings.js');
setSetting('trading_mode', 'dry_run');
const { upsertCandidate } = await import('../src/db/candidates.js');
const { refreshCandidateForExecution } = await import('../src/execution/positions.js');
const { handleApprovedBuy } = await import('../src/pipeline/orchestrator.js');
const { fetchJupiterAsset } = await import('../src/enrichment/jupiter.js');
const { fetchGraduatedCoins, graduated } = await import('../src/signals/graduated.js');
const { startOfficeBroker } = await import('../src/signals/officeBroker.js');
const originalGet = axios.get;
const base = JSON.parse(readFileSync(new URL('./fixtures/momentum-real.json', import.meta.url))).candidate;
function row() {
 const candidate = structuredClone(base); candidate.token.mint = 'So11111111111111111111111111111111111111112'; candidate.filters = {passed:true, failures:[]};
 return { id: upsertCandidate(candidate), candidate };
}

test('failed execution refresh never falls back to stored spot/market cap', async () => {
 axios.get = async () => { throw new Error('test network unavailable'); };
 const fresh = await refreshCandidateForExecution(row());
 assert.equal(fresh.candidate.filters.passed, false);
 assert.ok(fresh.candidate.filters.failures.some(x => /fresh|execution price/.test(x)));
});
test('forced Jupiter refresh never serves cached data after network failure', async () => {
 const mint='So11111111111111111111111111111111111111112';
 axios.get = async () => ({data:[{id:mint, usdPrice:1, mcap:10000}]});
 assert.ok(await fetchJupiterAsset(mint,{useCache:false}));
 axios.get = async () => {throw new Error('network unavailable');};
 assert.equal(await fetchJupiterAsset(mint,{useCache:false}),null);
});
test('refresh errors produce durable rejection, not stale-row entry attempt', async () => {
 const r=row(); db.exec('DROP TABLE saved_wallets');
 axios.get=async url => ({data: url.includes('/holders/') ? {holders:[{address:'holder',amount:1}]} : [base.jupiterAsset]});
 await handleApprovedBuy(r,{verdict:'BUY',confidence:100},null,[r],r.id);
 db.exec('CREATE TABLE saved_wallets (label TEXT PRIMARY KEY,address TEXT,created_at_ms INTEGER)');
 const event=db.prepare('select action from decision_logs order by id desc limit 1').get();
 assert.equal(event.action,'entry_rejected_refresh');
 assert.equal(db.prepare('select count(*) n from dry_run_positions').get().n,0);
});
test('Office socket remains disabled without explicit opt-in', () => {
 assert.equal(startOfficeBroker(),null);
});
test('graduation fallback includes only complete recent coins, not old active ones', async () => {
 axios.get=async url => {
   if(url.includes('advanced-api')) { const e=new Error('530'); e.response={status:530}; throw e; }
   return {data:[{mint:'recent-complete',complete:true,created_timestamp:Date.now()-1000}, {mint:'old-complete',complete:true,created_timestamp:Date.now()-7*86400000}, {mint:'not-complete',complete:false,created_timestamp:Date.now()-1000}]};
 };
 await fetchGraduatedCoins();
 assert.ok(graduated.has('recent-complete'));
 assert.equal(graduated.has('old-complete'),false);
 assert.equal(graduated.has('not-complete'),false);
});
test('position notification persists Telegram acknowledgment', async()=>{
 const { sendPositionOpen } = await import('../src/telegram/send.js');
 const at=Date.now();
 const result=db.prepare(`INSERT INTO dry_run_positions (mint,symbol,status,opened_at_ms,size_sol,snapshot_json,tp_percent,sl_percent,trailing_enabled,trailing_percent) VALUES (?,?,?, ?,?,?,75,-20,1,10)`).run(base.token.mint,base.token.symbol,'open',at,0.1,'{}');
 await sendPositionOpen(Number(result.lastInsertRowid));
 const alert=db.prepare("select kind,telegram_message_id from alerts where kind='position_open' order by id desc limit 1").get();
 assert.ok(alert?.telegram_message_id>0);
});
test('signal-server query follows active strategy source-count contract', async()=>{
 let sources;
 axios.get=async url=>{sources=new URL(url).searchParams.get('minSources');return {data:{signals:[]}};};
 const { fetchServerSignals }=await import('../src/signals/serverClient.js');
 const strat=JSON.parse(db.prepare('select config_json from strategies where enabled=1').get().config_json);
 await fetchServerSignals();
 assert.equal(Number(sources),Math.max(1,Number(strat.min_source_count)||1));
});
test.after(()=>{axios.get=originalGet;db.close();rmSync(dir,{recursive:true,force:true});});
