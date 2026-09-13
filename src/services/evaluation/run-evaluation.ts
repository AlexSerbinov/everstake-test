import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AnswerResult, EvaluationQuestion } from '../../contracts.js';
import { getSetting, type Database } from '../../storage/database.js';
export interface EvaluationRow { question:EvaluationQuestion; answer:AnswerResult; verdict:'pass'|'fail'|'pending'; inventedFacts:boolean|null; explanation:string; }
export interface EvaluationRun { id:string;createdAt:string;corpusVersion:string;mode:'agent'|'baseline';status:'running'|'completed'|'incomplete';rows:EvaluationRow[];summary:ReturnType<typeof summarize>; }
export function summarize(rows:EvaluationRow[]) {
 const assessed=rows.filter(r=>r.verdict!=='pending');const passed=assessed.filter(r=>r.verdict==='pass').length;
 return {total:rows.length,assessed:assessed.length,passed,failed:assessed.length-passed,accuracy:assessed.length?passed/assessed.length:null,inventedFacts:rows.some(r=>r.inventedFacts===null)?null:rows.filter(r=>r.inventedFacts).length,knownCostUsd:rows.reduce((n,r)=>n+r.answer.receipt.knownCostUsd,0),unknownCalls:rows.reduce((n,r)=>n+r.answer.receipt.unknownCalls,0)};
}
export function readQuestions(): EvaluationQuestion[] { return JSON.parse(readFileSync('eval/questions.json','utf8')).questions; }
export function saveEvaluation(db:Database,run:EvaluationRun):void {
 run.summary=summarize(run.rows);
 db.prepare('INSERT OR REPLACE INTO evaluations(id,created_at,result) VALUES(?,?,?)').run(run.id,run.createdAt,JSON.stringify(run));
 mkdirSync('artifacts/evaluation',{recursive:true});writeFileSync(`artifacts/evaluation/${run.id}.json`,JSON.stringify(run,null,2));
}
export async function runEvaluation(db:Database,runner:(question:string,mode:'agent'|'baseline')=>Promise<AnswerResult>,mode:'agent'|'baseline'='agent',ids?:string[]):Promise<EvaluationRun> {
 const all=readQuestions();const questions=ids?all.filter(q=>ids.includes(q.id)):all;
 if(!ids && (questions.length!==20||questions.filter(q=>q.negative).length<5)) throw new Error('Evaluation requires twenty questions including five negatives');
 const run:EvaluationRun={id:`${mode}-${randomUUID().slice(0,8)}`,createdAt:new Date().toISOString(),corpusVersion:getSetting(db,'corpus_version'),mode,status:'running',rows:[],summary:summarize([])};
 saveEvaluation(db,run);
 for(const question of questions) {
  if(getSetting(db,'corpus_version')!==run.corpusVersion) throw new Error('Corpus changed during evaluation');
  const answer=await runner(question.question,mode);
  run.rows.push({question,answer,verdict:'pending',inventedFacts:null,explanation:'Awaiting independent rubric review against frozen corpus; successful API response is not a pass.'});
  saveEvaluation(db,run);console.log(`${run.id} ${question.id}: ${answer.status} $${answer.receipt.knownCostUsd.toFixed(5)}`);
  if(answer.status==='error' && /budget/i.test(answer.error??'')) {run.status='incomplete';saveEvaluation(db,run);return run;}
 }
 run.status=run.rows.length===20?'completed':'incomplete';saveEvaluation(db,run);return run;
}
