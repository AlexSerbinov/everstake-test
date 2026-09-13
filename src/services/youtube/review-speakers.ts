import {readFileSync} from 'node:fs';
import {z} from 'zod';
import type {ModelClient} from '../../contracts.js';
import type {Turn} from './turns.js';
const reviewSchema=z.object({status:z.enum(['reviewed','needs_review']),speakers:z.array(z.object({label:z.string(),name:z.string().nullable(),roleAtRecording:z.string().nullable(),participantType:z.enum(['employee','interviewer','third_party','unknown']),evidenceTurnIndexes:z.array(z.number().int().nonnegative()),reason:z.string()})),suspiciousIntervals:z.array(z.object({fromTurn:z.number().int().nonnegative(),toTurn:z.number().int().nonnegative(),reason:z.string()})),limitations:z.array(z.string())});
export async function reviewSpeakers(model:ModelClient,runId:string,turns:Turn[],metadata:unknown) {
 const response=await model.generate({runId,stage:'youtube-speaker-review',system:readFileSync('prompts/speaker-review.md','utf8'),messages:[{role:'user',text:JSON.stringify({metadata,untrustedTurns:turns})}],maxOutputTokens:5000});
 const review=reviewSchema.parse(JSON.parse(response.text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')));
 const labels=new Set(turns.map(t=>t.speaker));
 for(const speaker of review.speakers) {
  if(!labels.has(speaker.label)||speaker.evidenceTurnIndexes.some(i=>i>=turns.length))throw new Error('Speaker review references nonexistent transcript evidence');
  if((speaker.name||speaker.roleAtRecording)&&!speaker.evidenceTurnIndexes.length) {speaker.name=null;speaker.roleAtRecording=null;speaker.participantType='unknown';review.status='needs_review';}
 }
 if(review.suspiciousIntervals.some(i=>i.toTurn>=turns.length||i.fromTurn>i.toTurn))throw new Error('Invalid review interval');
 if(review.suspiciousIntervals.length)review.status='needs_review';
 return review;
}
