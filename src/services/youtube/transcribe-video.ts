import {createHash, randomUUID} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {basename} from 'node:path';
import type {Database} from '../../storage/database.js';
import {groupTurns,type Turn} from './turns.js';
export interface TranscriptionJob {videoId:string;audioHash:string;model:string;fileId?:string;transcriptionId?:string;status:string;turns?:Turn[];providerMetadata?:unknown;startedAt:string;}
export interface TranscriptionMeter {start:(metadata:Record<string,unknown>)=>string;finish:(attemptId:string,status:'completed'|'error',metadata:Record<string,unknown>)=>void;}
/** Persist submitted jobs before polling. Ambiguous submissions require reconciliation, never blind retries. */
export async function transcribeVideo(db:Database,videoId:string,audioPath:string,meter:TranscriptionMeter):Promise<TranscriptionJob> {
 if(!/^[\w-]{11}$/.test(videoId))throw new Error('Invalid video ID');
 const key=process.env.SONIOX_API_KEY;if(!key)throw new Error('Missing SONIOX_API_KEY');
 const bytes=readFileSync(audioPath);const audioHash=createHash('sha256').update(bytes).digest('hex');
 const model=process.env.SONIOX_MODEL??'stt-async-v5';
 const row=db.prepare('SELECT data FROM youtube_jobs WHERE video_id=?').get(videoId);
 let job:TranscriptionJob=row?JSON.parse(String(row.data)):{videoId,audioHash,model,status:'new',startedAt:new Date().toISOString()};
 if(job.audioHash!==audioHash||job.model!==model)throw new Error('Audio/model changed: retain prior job and explicitly create a new revision');
 const persist=()=>{db.prepare('INSERT OR REPLACE INTO youtube_jobs(video_id,status,data) VALUES(?,?,?)').run(videoId,job.status,JSON.stringify(job));mkdirSync('data/youtube',{recursive:true});writeFileSync(`data/youtube/${videoId}.json`,JSON.stringify(job,null,2));};
 const request=async(path:string,init:RequestInit={})=>{
  const r=await fetch(`https://api.soniox.com/v1${path}`,{...init,headers:{Authorization:`Bearer ${key}`,...init.headers},signal:AbortSignal.timeout(120000)});
  if(!r.ok)throw new Error(`Soniox HTTP ${r.status}`);return await r.json() as Record<string,unknown>;
 };
 if(job.status==='completed')return job;
 if(job.status==='submission_unknown')throw new Error('Prior Soniox submission is ambiguous; reconcile client reference in provider logs before resubmitting');
 if(!job.fileId) {
  const form=new FormData();form.append('file',new Blob([bytes]),basename(audioPath));
  const uploaded=await request('/files',{method:'POST',body:form});if(typeof uploaded.id!=='string')throw new Error('Invalid Soniox upload response');job.fileId=uploaded.id;job.status='uploaded';persist();
 }
 let attemptId:string|undefined;
 if(!job.transcriptionId) {
  attemptId=meter.start({videoId,audioHash,model,clientReference:videoId,operationId:randomUUID()});
  job.status='submission_unknown';persist();
  try {
   const submitted=await request('/transcriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,file_id:job.fileId,enable_speaker_diarization:true,enable_language_identification:true,client_reference_id:`everstate-${videoId}`})});
   if(typeof submitted.id!=='string')throw new Error('Invalid Soniox transcription response');
   job.transcriptionId=submitted.id;job.status='submitted';job.providerMetadata={attemptId};persist();
  }catch(error){meter.finish(attemptId,'error',{videoId,submissionAmbiguous:true});throw error;}
 } else {attemptId=(job.providerMetadata as {attemptId?:string}|undefined)?.attemptId;}
 const deadline=Date.now()+30*60*1000;
 while(Date.now()<deadline) {
  const status=await request(`/transcriptions/${job.transcriptionId}`);
  if(status.status==='completed') {
   const transcript=await request(`/transcriptions/${job.transcriptionId}/transcript`);
   job.turns=groupTurns(transcript.tokens);job.status='completed';job.providerMetadata={...status,attemptId,transcript};persist();
   if(attemptId)meter.finish(attemptId,'completed',{videoId,transcriptionId:job.transcriptionId,providerMetadata:status,costStatus:'Awaiting provider usage/billing reconciliation; duration forecast is not actual cost'});
   return job;
  }
  if(['error','failed','canceled','cancelled'].includes(String(status.status))) {
   job.status='failed';job.providerMetadata={...status,attemptId};persist();
   if(attemptId)meter.finish(attemptId,'error',{videoId,providerMetadata:status});throw new Error('Soniox transcription failed');
  }
  await new Promise(resolve=>setTimeout(resolve,5000));
 }
 job.status='poll_timeout';persist();throw new Error('Soniox polling timed out; rerun resumes the existing paid job');
}
