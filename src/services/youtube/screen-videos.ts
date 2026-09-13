export interface VideoCandidate {id:string;title:string;description?:string;channelId:string;url:string;publishedAt:string|null;durationSeconds:number|null;decision:'accepted'|'needs_review'|'excluded';reason:string;}
/** Origin match is configuration, not a speaker-name or role whitelist. */
export function screenVideo(candidate:Omit<VideoCandidate,'decision'|'reason'>,officialChannels:string[]):VideoCandidate {
 if(officialChannels.includes(candidate.channelId))return {...candidate,decision:'accepted',reason:'Publisher channel identity matches configured official channel; individual speaker authority still requires attribution.'};
 const relevant=/\beverstake\b/i.test(candidate.title+' '+(candidate.description??''))&&/stak|validat|blockchain|ethereum|solana/i.test(candidate.title+' '+(candidate.description??''));
 return {...candidate,decision:'needs_review',reason:relevant?'Company and topic match; review captions/description for actual participation.':'Insufficient metadata to establish company relevance. Do not assume name similarity is identity.'};
}
