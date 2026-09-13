import type {Database} from '../../storage/database.js';
import type {EmbeddingClient} from '../../providers/model-client.js';
import type {DocumentSnapshot,EvidencePassage} from '../../contracts.js';
import {passage,searchCorpus} from './search-corpus.js';
export function cosine(a:number[],b:number[]):number {
 if(a.length!==b.length||!a.length)return 0;let dot=0,aa=0,bb=0;
 for(let i=0;i<a.length;i++){dot+=a[i]!*b[i]!;aa+=a[i]!**2;bb+=b[i]!**2;}
 return aa&&bb?dot/Math.sqrt(aa*bb):0;
}
export async function embedCorpus(db:Database,client:EmbeddingClient,runId:string,model='text-embedding-3-small') {
 const rows=db.prepare(`SELECT c.id,c.text FROM chunks c JOIN documents d ON d.id=c.document_id
 LEFT JOIN embeddings e ON e.chunk_id=c.id AND e.model=? WHERE d.active=1 AND e.chunk_id IS NULL`).all(model) as {id:string;text:string}[];
 let indexed=0;
 for(let offset=0;offset<rows.length;offset+=64) {
  const batch=rows.slice(offset,offset+64);const result=await client.embed({runId,stage:'index',input:batch.map(r=>r.text),model});
  if(result.embeddings.length!==batch.length)throw new Error('Embedding count does not match batch');
  db.exec('BEGIN');try{for(let i=0;i<batch.length;i++)db.prepare('INSERT OR REPLACE INTO embeddings(chunk_id,model,vector) VALUES(?,?,?)').run(batch[i]!.id,result.model,JSON.stringify(result.embeddings[i]));db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  indexed+=batch.length;console.log(`Embedded ${indexed}/${rows.length} new chunks`);
 }
 return {indexed,cached:Number(db.prepare('SELECT count(*) AS n FROM embeddings WHERE model=?').get(model)!.n)-indexed,model};
}
export async function hybridSearch(db:Database,client:EmbeddingClient,runId:string,query:string,limit=12):Promise<EvidencePassage[]> {
 const lexical=searchCorpus(db,query,30);
 const rows=db.prepare(`SELECT c.id,c.text,e.vector,d.snapshot FROM embeddings e JOIN chunks c ON c.id=e.chunk_id
 JOIN documents d ON d.id=c.document_id WHERE d.active=1 AND e.model='text-embedding-3-small'`).all() as {id:string;text:string;vector:string;snapshot:string}[];
 if(!rows.length)return lexical.slice(0,limit);
 const embedded=await client.embed({runId,stage:'query-embedding',input:query});const vector=embedded.embeddings[0]!;
 const ranked=rows.map(r=>({...r,similarity:cosine(vector,JSON.parse(r.vector))})).sort((a,b)=>b.similarity-a.similarity).slice(0,60);
 const merged=new Map<string,{evidence:EvidencePassage;rank:number}>();
 lexical.forEach((e,i)=>merged.set(e.id,{evidence:e,rank:1/(60+i)}));
 ranked.forEach((r,i)=>{const existing=merged.get(r.id);const document=JSON.parse(r.snapshot) as DocumentSnapshot;merged.set(r.id,{evidence:existing?.evidence??passage(document,r.id,r.text,r.similarity),rank:(existing?.rank??0)+1/(60+i)});});
 const groups=new Map<string,number>();const results:EvidencePassage[]=[];
 for(const row of [...merged.values()].sort((a,b)=>b.rank-a.rank)) {
  const e=row.evidence;if((groups.get(e.duplicateGroup)??0)>=2)continue;
  groups.set(e.duplicateGroup,(groups.get(e.duplicateGroup)??0)+1);results.push({...e,score:row.rank,reason:'Lexical and semantic rank fusion; diversified by content group. Authority and temporal validity checked separately.'});if(results.length>=limit)break;
 }
 return results;
}
