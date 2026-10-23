import test from 'node:test';
import assert from 'node:assert/strict';
import { singleFlight } from '../src/utils/singleFlight.js';
test('slow monitor ticks share work and release lock after failure', async()=>{
 let calls=0, release;
 const tick=singleFlight(async()=>{ calls++; await new Promise(r=>release=r); throw new Error('failure'); });
 const first=tick(); const second=tick();
 await Promise.resolve(); assert.equal(calls,1); assert.equal(first,second);
 release(); await assert.rejects(first,/failure/); await assert.rejects(second,/failure/);
 const third=tick(); await Promise.resolve(); assert.equal(calls,2); release(); await assert.rejects(third,/failure/);
});
