export type VideoDecision = 'accepted' | 'needs_review' | 'excluded';

export interface VideoCandidate {
  id: string;
  title: string;
  description?: string;
  channelId: string;
  channel?: string;
  url: string;
  publishedAt: string | null;
  durationSeconds: number | null;
  decision: VideoDecision;
  reason: string;
  provenance?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}

export interface ScreeningPolicy {
  officialChannelIds: string[];
  companyTerms: string[];
  topicTerms: string[];
  participationTerms: string[];
  lookalikeTerms: string[];
  minimumDurationSeconds: number;
}

const normalized = (value: string): string => value.normalize('NFKC').toLocaleLowerCase('en');
const containsAny = (text: string, terms: string[]): string | null =>
  terms.find(term => normalized(text).includes(normalized(term))) ?? null;

/** Metadata screening establishes relevance, never a person's identity or authority. */
export function screenVideo(
  candidate: Omit<VideoCandidate, 'decision' | 'reason'>,
  policyOrOfficialChannels: ScreeningPolicy | string[],
): VideoCandidate {
  const policy: ScreeningPolicy = Array.isArray(policyOrOfficialChannels)
    ? {
        officialChannelIds: policyOrOfficialChannels,
        companyTerms: ['everstake'],
        topicTerms: ['staking', 'validator', 'blockchain', 'ethereum', 'solana'],
        participationTerms: ['interview', 'podcast', 'talk', 'speaker', 'with everstake', 'everstake joins'],
        lookalikeTerms: ['everrise', 'everstake solution fintech'],
        minimumDurationSeconds: 30,
      }
    : policyOrOfficialChannels;
  const text = `${candidate.title} ${candidate.description ?? ''}`;
  const lookalike = containsAny(text, policy.lookalikeTerms);
  const company = containsAny(text, policy.companyTerms);
  const topic = containsAny(text, policy.topicTerms);
  const participation = containsAny(text, policy.participationTerms);

  if (lookalike) return { ...candidate, decision: 'excluded', reason: `Metadata matches configured look-alike term "${lookalike}"; name similarity is not company identity.` };
  if (candidate.durationSeconds === null || !Number.isFinite(candidate.durationSeconds) || candidate.durationSeconds <= 0) {
    return { ...candidate, decision: 'needs_review', reason: 'Duration is unknown or invalid; paid processing requires a fresh positive duration.' };
  }
  if (candidate.durationSeconds !== null && candidate.durationSeconds < policy.minimumDurationSeconds) {
    return { ...candidate, decision: 'needs_review', reason: `Duration is ${candidate.durationSeconds}s, below the ${policy.minimumDurationSeconds}s screening floor; inspect before paid transcription.` };
  }
  if (policy.officialChannelIds.includes(candidate.channelId)) {
    return {
      ...candidate,
      decision: topic || company ? 'accepted' : 'needs_review',
      reason: topic || company
        ? 'Publisher channel identity matches the configured official channel and metadata is topically relevant; individual speaker authority still requires attribution.'
        : 'Publisher is official, but metadata does not establish a relevant topic; inspect before transcription.',
    };
  }
  if (company && topic && participation) {
    return { ...candidate, decision: 'accepted', reason: `Third-party metadata names the company, topic "${topic}" and participation signal "${participation}"; transcript review must verify speakers and claims.` };
  }
  if (company && topic) return { ...candidate, decision: 'needs_review', reason: 'Company and topic match, but metadata does not establish direct participation; inspect captions or the recording.' };
  return { ...candidate, decision: 'excluded', reason: 'Metadata contains neither a configured company-and-topic match nor an official publisher identity.' };
}
