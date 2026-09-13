import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import type { Database } from './storage/database.js';
import { getSetting } from './storage/database.js';
import type { AnswerResult, Emit } from './contracts.js';
import { readQuestions } from './services/evaluation/run-evaluation.js';
export interface ApiDependencies {db:Database;ask:(question:string,emit:Emit)=>Promise<AnswerResult>;costs:()=>unknown;refresh:(sourceId?:string)=>Promise<unknown>;}
export function createApi({db,ask,costs,refresh}:ApiDependencies) {
 const app=new Hono();let busy=false;
 app.get('/health',c=>c.json({status:'ok',application:'Everstate Knowledge Base',corpusVersion:getSetting(db,'corpus_version','unbuilt')}));
 app.get('/api/questions',c=>c.json({questions:readQuestions()}));
 app.get('/api/costs',c=>c.json(costs()));
 app.get('/api/evaluations',c=>c.json({runs:db.prepare('SELECT result FROM evaluations ORDER BY created_at DESC').all().map(r=>JSON.parse(String(r.result)))}));
 app.get('/api/evaluations/:id',c=>{const row=db.prepare('SELECT result FROM evaluations WHERE id=?').get(c.req.param('id'));return row?c.json(JSON.parse(String(row.result))):c.json({error:'Run not found'},404);});
 app.get('/api/runs/:id',c=>{const row=db.prepare('SELECT result FROM answers WHERE run_id=?').get(c.req.param('id'));return row?c.json(JSON.parse(String(row.result))):c.json({error:'Run not found'},404);});
 app.get('/api/corpus',c=>{
  const page=Math.max(0,Math.min(Number(c.req.query('page')??0)||0,10000));
  const documents=db.prepare('SELECT snapshot FROM documents WHERE active=1 ORDER BY url LIMIT 50 OFFSET ?').all(page*50).map(r=>{const d=JSON.parse(String(r.snapshot));return {...d,text:d.text.slice(0,1200)};});
  const total=Number(db.prepare('SELECT count(*) AS n FROM documents WHERE active=1').get()!.n);
  return c.json({version:getSetting(db,'corpus_version','unbuilt'),total,pageSize:50,hasNext:(page+1)*50<total,documents,events:db.prepare('SELECT * FROM crawl_events ORDER BY id DESC LIMIT 30').all()});
 });
 app.post('/api/ask',async c=>{
  if(busy)return c.json({error:'Another request is running. Please try again shortly.'},429);
  const body=await c.req.text();if(body.length>8000)return c.json({error:'Question is too long'},413);
  let question:string;
  try{question=z.object({question:z.string().trim().min(2).max(2000)}).parse(JSON.parse(body)).question;}catch{return c.json({error:'Provide a question between 2 and 2000 characters'},400);}
  busy=true;c.header('X-Accel-Buffering','no');c.header('Cache-Control','no-cache');
  return streamSSE(c,async stream=>{
   let sequence=0;let pending=Promise.resolve();
   const emit:Emit=event=>{pending=pending.then(()=>stream.writeSSE({id:String(++sequence),event:event.type,data:JSON.stringify(event)})).then(()=>{}).catch(()=>{});};
   try {await ask(question,emit);await pending;} catch{await stream.writeSSE({event:'error',data:JSON.stringify({type:'error',label:'Request failed',at:new Date().toISOString()})}).catch(()=>{});}finally{busy=false;}
  });
 });
 app.post('/api/refresh',async c=>{
  const token=process.env.ADMIN_TOKEN;
  if(!token||c.req.header('Authorization')!==`Bearer ${token}`)return c.json({error:'Operator authorization required'},401);
  if(busy)return c.json({error:'Another operation is active'},409);
  let sourceId:string|undefined;
  try{const b=z.object({sourceId:z.string().max(100).optional()}).parse(await c.req.json());sourceId=b.sourceId;}catch{return c.json({error:'Invalid refresh request'},400);}
  busy=true;try{return c.json(await refresh(sourceId));}catch{return c.json({error:'Refresh failed; previous corpus retained'},500);}finally{busy=false;}
 });
 app.use('/*',serveStatic({root:'public'}));
 return app;
}
