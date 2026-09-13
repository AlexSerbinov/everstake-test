/** Shared data shapes; no company facts or question-specific predicates. */
export interface SourceConfig {
  id: string;
  url: string;
  publisher: string;
  authority: 1 | 2 | 3;
  kind: "website" | "docs" | "news" | "github" | "youtube";
  reason: string;
  enabled: boolean;
}
export interface DocumentSnapshot {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string;
  publisher: string;
  authority: 1 | 2 | 3;
  kind: SourceConfig["kind"];
  text: string;
  contentHash: string;
  fetchedAt: string;
  publishedAt: string | null;
  updatedAt: string | null;
  dateEvidence: string | null;
  duplicateOf: string | null;
  revision: string;
  metadata: Record<string, unknown>;
}
export interface EvidencePassage {
  id: string;
  documentId: string;
  url: string;
  title: string;
  text: string;
  authority: 1 | 2 | 3;
  publisher: string;
  publishedAt: string | null;
  updatedAt: string | null;
  fetchedAt: string;
  duplicateGroup: string;
  score: number;
  reason: string;
  metadata: Record<string, unknown>;
}
export interface Claim {
  text: string;
  citations: string[];
  asOf: string | null;
}
export interface CheckResult {
  rule: string;
  status: "passed" | "failed" | "not_applicable";
  reason: string;
}
export interface TrustScore {
  score: number;
  components: {
    name: string;
    score: number;
    maximum: number;
    reason: string;
  }[];
  limitations: string[];
}
export interface Receipt {
  runId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  knownCostUsd: number;
  unknownCalls: number;
  elapsedMs: number;
}
export interface RunEvent {
  runId: string;
  type: "step" | "sources" | "verification" | "answer" | "error" | "done";
  at: string;
  label: string;
  data?: unknown;
}
export type Emit = (event: RunEvent) => void;
export interface AnswerResult {
  runId: string;
  status: "answered" | "partial" | "no_reliable_answer" | "error";
  question: string;
  text: string;
  asOf: string | null;
  claims: Claim[];
  sources: EvidencePassage[];
  checks: CheckResult[];
  trust: TrustScore | null;
  receipt: Receipt;
  corpusVersion: string;
  error?: string;
}
export interface ModelMessage {
  role: "user" | "model";
  text: string;
}
export interface ModelRequest {
  runId: string;
  stage: string;
  system: string;
  messages: ModelMessage[];
  model?: string;
  maxOutputTokens?: number;
  /** Cancels the in-flight provider call; a cancelled attempt is recorded, never retried. */
  signal?: AbortSignal;
}
export interface ModelResponse {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}
export interface ModelClient {
  generate(request: ModelRequest): Promise<ModelResponse>;
}
export interface EvaluationQuestion {
  id: string;
  question: string;
  difficulty: "basic" | "hard";
  category: string;
  whyHard: string;
  negative: boolean;
  reference: string;
  referenceUrls: string[];
  rubric: string[];
}
