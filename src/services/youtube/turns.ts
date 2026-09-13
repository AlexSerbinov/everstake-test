import { z } from 'zod';
export const tokenSchema=z.object({text:z.string(),start_ms:z.number().nonnegative().optional(),end_ms:z.number().nonnegative().optional(),speaker:z.union([z.string(),z.number()]).nullish(),translation_status:z.string().optional()});
export interface Turn {speaker:string|null;startMs:number|null;endMs:number|null;text:string;}
export function groupTurns(raw:unknown):Turn[] {
 const tokens=z.array(tokenSchema).parse(raw);const turns:Turn[]=[];
 for(const token of tokens) {
  if(token.translation_status==='translation'||token.text==='<end>')continue;
  const speaker=token.speaker==null?null:String(token.speaker);let last=turns.at(-1);
  if(!last||last.speaker!==speaker||last.text.length>1800) {last={speaker,startMs:token.start_ms??null,endMs:token.end_ms??null,text:''};turns.push(last);}
  last.text+=token.text;last.endMs=token.end_ms??last.endMs;
 }
 return turns.filter(t=>t.text.trim());
}
