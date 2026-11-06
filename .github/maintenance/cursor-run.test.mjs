import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollCursorRun } from './cursor-run.mjs';

const receipt = { agentId:'bc-fixture',runId:'run-fixture',head:'a'.repeat(40) };
function fixture(responses, changes = {}) {
  let time = 0;
  let calls = 0;
  return {
    receipt,apiKey:'secret-fixture',maxWaitMs:100,pollMs:30,
    now:()=>time,sleep:async ms=>{time+=ms;},assertCurrent:async()=>{},
    fetcher:async (url,options)=>{
      assert.equal(url,'https://api.cursor.com/v1/agents/bc-fixture/runs/run-fixture');
      assert.equal(options.headers.Authorization,'Bearer secret-fixture');
      const response = responses[Math.min(calls++,responses.length-1)];
      return new Response(JSON.stringify({id:receipt.runId,agentId:receipt.agentId,...response}));
    }, ...changes,
  };
}
test('polls creating and running until a source-verified finished result', async()=>{
  let checked = false;
  const result = await pollCursorRun(fixture([{status:'CREATING'},{status:'RUNNING'},{status:'FINISHED',result:'review'}],{assertCurrent:async()=>{checked=true;}}));
  assert.equal(result.status,'completed'); assert.equal(result.polls,3); assert.equal(checked,true); assert.equal(result.result,'review');
});
for (const status of ['ERROR','CANCELLED','EXPIRED']) test(`${status} remains failed`,async()=>{
  assert.equal((await pollCursorRun(fixture([{status}]))).status,'failed');
});
test('exhausted wait leaves remote execution pending without cancellation',async()=>{
  const result = await pollCursorRun(fixture([{status:'RUNNING'}]));
  assert.equal(result.status,'pending'); assert.equal(result.waitBudgetExhausted,true); assert.equal(result.polls,4);
});
test('changed source revision supersedes otherwise finished result',async()=>{
  const result=await pollCursorRun(fixture([{status:'FINISHED'}],{assertCurrent:async()=>{throw new Error('SUPERSEDED_REVISION');}}));
  assert.equal(result.status,'superseded'); assert.equal(result.sourceRevisionVerified,undefined);
});
test('unknown status or mismatched run identity fails closed',async()=>{
  assert.equal((await pollCursorRun(fixture([{status:'UNKNOWN'}]))).status,'failed');
  assert.equal((await pollCursorRun(fixture([{status:'FINISHED',id:'run-other'}]))).status,'failed');
});
test('results are bounded and credentials removed',async()=>{
  const result=await pollCursorRun(fixture([{status:'FINISHED',result:'secret-fixture'+'x'.repeat(40000)}]));
  assert.equal(result.result.length,32768); assert.equal(result.result.includes('secret-fixture'),false); assert.equal(result.resultTruncated,true);
});
test('authentication errors fail without retaining response bodies',async()=>{
  const result=await pollCursorRun(fixture([],{fetcher:async()=>new Response('secret-fixture',{status:401})}));
  assert.equal(result.status,'failed'); assert.equal(result.error,'CURSOR_STATUS_HTTP_401'); assert.equal(JSON.stringify(result).includes('secret-fixture'),false);
});
test('network failures and 429 remain bounded pending observations',async()=>{
  const result=await pollCursorRun(fixture([],{fetcher:async()=>{throw new Error('secret-fixture');}}));
  assert.equal(result.status,'pending'); assert.equal(JSON.stringify(result).includes('secret-fixture'),false);
  assert.equal((await pollCursorRun(fixture([],{fetcher:async()=>new Response('',{status:429})}))).status,'pending');
});
