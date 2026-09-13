import {test} from 'node:test';import assert from 'node:assert/strict';
import {groupTurns} from './turns.js';import {screenVideo} from './screen-videos.js';
test('speaker changes preserve question and correcting response separately',()=>{
 const turns=groupTurns([{text:'2700 networks?',speaker:'1',start_ms:0,end_ms:2000},{text:'No, 130.',speaker:'2',start_ms:2200,end_ms:4000}]);assert.equal(turns.length,2);assert.equal(turns[0]!.speaker,'1');assert.equal(turns[1]!.text,'No, 130.');
});
test('unknown timestamps and identities remain unknown',()=>{assert.deepEqual(groupTurns([{text:'Hello'}]),[{speaker:null,startMs:null,endMs:null,text:'Hello'}]);});
test('provider subword tokens retain their original spacing',()=>{const turns=groupTurns([{text:' He',speaker:'1'},{text:'llo',speaker:'1'},{text:' world',speaker:'1'},{text:'!',speaker:'1'}]);assert.equal(turns[0]!.text,'Hello world!');});
test('brand-like metadata does not earn official authority',()=>{const r=screenVideo({id:'x',title:'Everstake music',channelId:'unrelated',url:'https://youtube.com/watch?v=x',publishedAt:null,durationSeconds:10},['official']);assert.equal(r.decision,'needs_review');});
