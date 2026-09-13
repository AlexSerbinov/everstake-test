import {readConfig} from '../../config.js';
import type { CheckResult, EvidencePassage, TrustScore } from '../../contracts.js';
export function scoreEvidence(sources: EvidencePassage[], checks: CheckResult[]): TrustScore | null {
 if (!sources.length || checks.some(c=>c.status==='failed')) return null;
 const weights=readConfig<{trust:{authority:number;temporal:number;grounding:number;agreement:number}}>('policy').trust;
 const authority = Math.round(weights.authority*sources.reduce((n,s)=>n+({1:1,2:0.7,3:0.35}[s.authority]),0)/sources.length);
 const dated = sources.filter(s=>s.publishedAt || s.updatedAt).length;
 const temporal = Math.round(weights.temporal*dated/sources.length);
 const groups = new Set(sources.map(s=>s.duplicateGroup)).size;
 const components = [
  {name:'Authority',score:authority,maximum:weights.authority,reason:'Publisher provenance; platform alone is not authority'},
  {name:'Temporal evidence',score:temporal,maximum:weights.temporal,reason:'Known publication/update dates; fetched dates do not establish fact validity'},
  {name:'Grounding checks',score:weights.grounding,maximum:weights.grounding,reason:'Structural gates and model-based support review passed; review can still be wrong'},
  {name:'Independent evidence',score:Math.min(weights.agreement,groups*weights.agreement/4),maximum:weights.agreement,reason:`${groups} distinct content groups; not a majority vote or proof of agreement`}
 ];
 return {score:components.reduce((n,c)=>n+c.score,0),components,limitations:['Heuristic evidence score, not a probability of truth.','Lexical and numeric checks cannot establish semantic entailment.','Independent pages can still repeat an unsupported claim.']};
}
