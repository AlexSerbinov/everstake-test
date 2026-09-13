import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../../storage/database.js';
import { answerQuestion } from './answer-question.js';
import { verifyAnswer } from './verify-answer.js';
import { calculate } from './calculate.js';
test('provider errors are errors, not abstentions',async()=>{
 const db=openDatabase(':memory:');const events:string[]=[];
 const result=await answerQuestion({db,model:{generate:async()=>{throw new Error('Provider unavailable');}},finish:()=>{},receipt:id=>({runId:id,calls:1,inputTokens:0,outputTokens:0,knownCostUsd:0,unknownCalls:1,elapsedMs:10})},'Unknown role?','r',e=>events.push(e.type));
 assert.equal(result.status,'error');assert.equal(result.trust,null);assert.equal(events.at(-1),'done');db.close();
});
test('invented citations and quantities cannot pass',()=>{
 const checks=verifyAnswer([{text:'Supports 2700 networks',citations:['invented'],asOf:null}],new Map(),'');
 assert.equal(checks.filter(c=>c.status==='failed').length,3);
});
test('calculator supports bounded arithmetic and rejects executable operations',()=>{
 assert.equal(calculate('multiply',[64,32]),2048);assert.throws(()=>calculate('eval',[1,2]));assert.throws(()=>calculate('divide',[1,0]));
});
test('malformed final actions are infrastructure errors, not corpus absence',async()=>{
 const db=openDatabase(':memory:');const result=await answerQuestion({db,model:{generate:async()=>({text:'invalid',model:'mock',inputTokens:0,outputTokens:0})},finish:()=>{},receipt:id=>({runId:id,calls:6,inputTokens:0,outputTokens:0,knownCostUsd:0,unknownCalls:0,elapsedMs:10})},'Anything?','bad');assert.equal(result.status,'error');db.close();
});
