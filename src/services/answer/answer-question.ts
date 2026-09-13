import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';
import type { AnswerResult, Emit, EvidencePassage, ModelClient, ModelMessage, Receipt } from '../../contracts.js';
import { getSetting, type Database } from '../../storage/database.js';
import { readDocument, searchCorpus } from '../search/search-corpus.js';
import { scoreEvidence } from '../trust/score-evidence.js';
import { calculate } from './calculate.js';
import { numbers, verifyAnswer } from './verify-answer.js';

const claimSchema=z.object({text:z.string().min(1).max(3000),citations:z.array(z.string()).min(1).max(10),asOf:z.string().nullable()});
const actionSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('search'),query:z.string().min(1).max(1000)}),
 z.object({action:z.literal('read'),documentId:z.string(),offset:z.number().int().min(0).max(500).default(0)}),
 z.object({action:z.literal('calculate'),operation:z.enum(['add','subtract','multiply','divide']),operands:z.array(z.number()).min(2).max(10),citations:z.array(z.string()).min(1)}),
 z.object({action:z.literal('answer'),status:z.enum(['answered','partial','no_reliable_answer']),claims:z.array(claimSchema).max(15),reason:z.string().optional()})
]);
export interface AnswerDependencies { db: Database; model: ModelClient; search?:(query:string,limit?:number)=>Promise<EvidencePassage[]>; receipt:(runId:string)=>Receipt; finish:(runId:string,status:string)=>void; }
export async function answerQuestion(deps: AnswerDependencies, question: string, runId: string, emit: Emit=()=>{}, mode:'agent'|'baseline'='agent'): Promise<AnswerResult> {
 const {db,model}=deps;
 const search=deps.search??(async(query:string,limit=12)=>searchCorpus(db,query,limit));
 const send=(type:Parameters<Emit>[0]['type'],label:string,data?:unknown)=>emit({runId,type,label,data,at:new Date().toISOString()});
 const definition=parse(readFileSync('agents/researcher.yaml','utf8')) as {prompt:string;skills:string[];maxSteps:number};
 const system=[readFileSync(definition.prompt,'utf8'),...definition.skills.map(p=>readFileSync(p,'utf8'))].join('\n\n');
 let answeredAction=false;
 const registry=new Map<string,EvidencePassage>();
 const messages:ModelMessage[]=[{role:'user',text:question}];
 let result:AnswerResult={runId,status:'no_reliable_answer',question,text:'No reliable answer was found in the available evidence.',asOf:null,claims:[],sources:[],checks:[],trust:null,receipt:deps.receipt(runId),corpusVersion:getSetting(db,'corpus_version','unbuilt')};
 const register=(sources:EvidencePassage[])=>{
  const fresh=sources.filter(s=>!registry.has(s.id)); const repeated=sources.length-fresh.length;
  for(const source of sources) registry.set(source.id,source);
  send('sources',`Found ${fresh.length} new passages, ${repeated} already seen`,{sources,newCount:fresh.length,repeated});
 };
 try {
  send('step','Searching the crawled corpus');
  const initial=await search(question,mode==='baseline'?6:12); register(initial);
  messages.push({role:'user',text:JSON.stringify({untrustedEvidence:initial})});
  const steps=mode==='baseline'?1:Math.min(definition.maxSteps,8);
  for(let step=0;step<steps;step++) {
   send('step',mode==='baseline'?'Generating plain-RAG baseline':`Research step ${step+1} of ${steps}`);
   const instruction=mode==='baseline'?'Return answer action now using only supplied initial passages.':step===steps-1?'This is your final turn: return answer action using evidence collected so far.':'';
   const response=await model.generate({runId,stage:mode==='baseline'?'baseline':'answer',system,messages:[...messages,{role:'user',text:instruction||'Choose the next research action.'}],maxOutputTokens:4000});
   messages.push({role:'model',text:response.text});
   let action:z.infer<typeof actionSchema>;
   try { action=actionSchema.parse(JSON.parse(response.text.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''))); }
   catch { messages.push({role:'user',text:'Invalid action schema. Return one valid JSON action; this consumes a research step.'}); continue; }
   if(action.action==='answer') {
    answeredAction=true;
    if(action.status==='no_reliable_answer') { result.checks=[{rule:'abstention',status:'passed',reason:'No factual claims emitted'}]; break; }
    const checks=verifyAnswer(action.claims,registry,question);
    if(!action.claims.length) checks.push({rule:'nonempty',status:'failed',reason:'Answer has no claims'});
    send('verification','Checking citations, dates and quantities',checks);
    if(checks.some(c=>c.status==='failed')) {
     result.checks=checks;
     messages.push({role:'user',text:JSON.stringify({rejectedDraftChecks:checks,instruction:'Fix using actual evidence or abstain. Do not invent citations or unsupported numbers.'})});continue;
    }
    const ids=new Set(action.claims.flatMap(c=>c.citations));
    const sources=[...ids].map(id=>registry.get(id)!);
    result={...result,status:action.status,claims:action.claims,checks,sources,asOf:action.claims.map(c=>c.asOf).filter(Boolean).sort().at(-1)??null,
     text:action.claims.map(c=>`${c.text} ${c.citations.map(id=>`[${id}]`).join(' ')}`).join('\n\n'),trust:scoreEvidence(sources,checks)};
    break;
   }
   if(mode==='baseline') break;
   if(action.action==='search') {
    send('step',`Search: ${action.query}`); const sources=await search(action.query); register(sources);
    messages.push({role:'user',text:JSON.stringify({untrustedEvidence:sources})});
   } else if(action.action==='read') {
    if(![...registry.values()].some(s=>s.documentId===action.documentId)) {messages.push({role:'user',text:'Read requires a document ID returned by search.'});continue;}
    const sources=readDocument(db,action.documentId,action.offset);register(sources);
    messages.push({role:'user',text:JSON.stringify({untrustedEvidence:sources,nextOffset:action.offset+sources.length})});
   } else {
    const cited=action.citations.map(id=>registry.get(id));
    const known=new Set(numbers(question+' '+cited.filter(Boolean).map(s=>s!.text).join(' ')));
    if(cited.some(s=>!s)||action.operands.some(n=>!known.has(String(n)))) {messages.push({role:'user',text:'Calculation requires cited sources and operands present in the question or cited evidence.'});continue;}
    const value=calculate(action.operation,action.operands);
    const base=cited[0]!;
    const evidence={...base,id:`calc-${randomUUID().slice(0,8)}`,text:`Calculated scenario: ${action.operation}(${action.operands.join(', ')}) = ${value}. Inputs from user scenario and sources: ${action.citations.join(', ')}.\n${cited.map(s=>s!.text).join('\n')}`,reason:'Deterministic source-backed calculation',metadata:{...base.metadata,calculation:{operation:action.operation,operands:action.operands,result:value,citations:action.citations}}};
    register([evidence]);messages.push({role:'user',text:JSON.stringify({calculation:evidence})});
   }
  }
  if(!answeredAction) throw new Error('Research exhausted its step limit without a valid final answer');
 } catch(error) {
  result={...result,status:'error',text:'The request could not complete. Check provider availability or the configured budget.',error:error instanceof Error?error.message:'Unknown provider error',trust:null};
  send('error','Request failed',{message:result.error});
 }
 deps.finish(runId,result.status); result.receipt=deps.receipt(runId);
 db.prepare('INSERT OR REPLACE INTO answers(run_id,result) VALUES(?,?)').run(runId,JSON.stringify(result));
 send('answer','Final result',result);send('done','Run finished',{status:result.status});return result;
}
