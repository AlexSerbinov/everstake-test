import {createModelClient,createEmbeddingClient} from './providers/model-client.js';
import {beginRun,finishRun,buildReceipt,costOverview,withRun} from './services/measurements/index.js';
import {answerQuestion} from './services/answer/answer-question.js';
import {hybridSearch,embedCorpus} from './services/search/hybrid-search.js';
import {readActiveDocuments} from './workflows/build-corpus.js';
import {buildIndex} from './services/indexer/build-index.js';
import {refreshCorpus} from './workflows/refresh-corpus.js';
import {readSources} from './config.js';
import {getSetting,type Database} from './storage/database.js';
import type {Emit} from './contracts.js';
export function createApplication(db:Database) {
 const model=createModelClient(db);const embeddings=createEmbeddingClient(db);
 const ask=async(question:string,emit:Emit=()=>{},mode:'agent'|'baseline'='agent')=>{
  const runId=beginRun(db,mode==='agent'?'query':'baseline',{question,corpusVersion:getSetting(db,'corpus_version')});
  return answerQuestion({db,model,search:(query,limit)=>hybridSearch(db,embeddings,runId,query,limit),receipt:id=>buildReceipt(db,id),finish:(id,status)=>finishRun(db,id,status==='error'?'failed':'completed')},question,runId,emit,mode);
 };
 const costs=()=>({...costOverview(db),runs:db.prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT 100').all().map(r=>({id:r.id,kind:r.kind,startedAt:r.started_at,status:r.status,question:null,receipt:buildReceipt(db,String(r.id))}))});
 const refresh=async(sourceId?:string)=>{
  const runId=beginRun(db,'refresh',{sourceId});const prior=readActiveDocuments(db);const priorVersion=getSetting(db,'corpus_version');
  try{const report=await refreshCorpus(db,readSources(),{sourceIds:sourceId?[sourceId]:undefined,crawl:{maxPages:1000,concurrency:3},onProgress:event=>console.log(JSON.stringify(event))});
   const index=report.index?await embedCorpus(db,embeddings,runId):null;finishRun(db,runId,'completed');return {...report,index,receipt:buildReceipt(db,runId)};
  }catch(e){if(prior.length&&getSetting(db,'corpus_version')!==priorVersion)buildIndex(db,prior,{version:priorVersion});finishRun(db,runId,'failed');throw e;}
 };
 return {db,ask,costs,refresh,model,embeddings};
}
