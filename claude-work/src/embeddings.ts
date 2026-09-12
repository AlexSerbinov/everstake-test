// Text → vector, for the dense half of retrieval (crawl → dedup → INDEX → … → retrieve).
// `src/index/build.ts` embeds every chunk once at index time and stores the vector as a
// BLOB in `chunks.embedding`; `src/ask/retrieve.ts` embeds the question at query time and
// scores it against those BLOBs with `cosine()` in-process.
//
// Provider is chosen once from the environment: OpenAI `text-embedding-3-small` (1536 dims),
// Voyage `voyage-3-lite` (512 dims), or "none".
//
// What breaks if this is wrong: with "none" the system still answers, but retrieval degrades
// to BM25-only and the answer trace says `vector_used: false` — a silent wrong answer is not
// possible, a quieter recall is. Mixing providers is worse than either: dimensions differ, so
// vectors written by one provider are meaningless to the other. Changing EMBEDDINGS_PROVIDER
// therefore requires a full re-index (`npm run index -- --force`), not just a restart.

import { env } from "./config.js";
import { logCall, priceUsd } from "./llm.js";

/** Provider error bodies can be an HTML error page; keep enough to identify the failure
 *  without burying the stack trace in the index-build log. */
const ERROR_BODY_CHARS = 200;

/** Model id as written to `llm_calls.model`, and the key looked up in the config price
 *  table — the two must agree or the embedding spend silently reports as $0. */
export const EMBED_MODEL = embedModelForProvider();

function embedModelForProvider(): string {
  if (env.embeddingsProvider === "openai") return "text-embedding-3-small";
  if (env.embeddingsProvider === "voyage") return "voyage-3-lite";
  return "none";
}

export function embeddingsEnabled() {
  return env.embeddingsProvider !== "none";
}

/**
 * Embed a batch of texts, one vector out per text in, in the same order.
 *
 * Every call is logged to `llm_calls` (stage=embed) with the provider's own token count, so
 * the index-build cost in REPORT.md §3 is measured rather than estimated — same rule as the
 * LLM calls in `llm.ts`. Failures are logged too (ok=0): an index built during an outage must
 * be visibly incomplete in the cost report, not merely absent from it.
 *
 * With the provider disabled this returns zero-length vectors rather than throwing, so
 * `build.ts` and `retrieve.ts` can run the whole pipeline with no embedding key at all.
 *
 * @param purpose Voyage prices and encodes queries differently from documents; OpenAI has no
 *   such distinction and ignores it. It is passed through, not branched on, here.
 */
export async function embed(texts: string[], purpose: "document" | "query" = "document"): Promise<Float32Array[]> {
  if (!embeddingsEnabled() || texts.length === 0) return texts.map(() => new Float32Array(0));
  const startedAt = Date.now();
  try {
    const { vectors, tokens } = env.embeddingsProvider === "openai"
      ? await embedViaOpenAi(texts)
      : await embedViaVoyage(texts, purpose);
    logCall({
      stage: "embed",
      provider: env.embeddingsProvider,
      model: EMBED_MODEL,
      input: tokens,
      costUsd: priceUsd(EMBED_MODEL, { input: tokens, output: 0 }),
      latencyMs: Date.now() - startedAt,
      meta: { n: texts.length, purpose },
    });
    return vectors;
  } catch (error: any) {
    logCall({
      stage: "embed",
      provider: env.embeddingsProvider,
      model: EMBED_MODEL,
      latencyMs: Date.now() - startedAt,
      ok: false,
      error: String(error?.message ?? error),
    });
    throw error;
  }
}

// Both providers are plain `fetch` against a documented REST endpoint rather than their SDKs:
// one POST with a string array is the entire API surface used, and two more dependencies to
// audit would buy nothing.

async function embedViaOpenAi(texts: string[]) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  if (!response.ok) {
    throw new Error(`openai embeddings ${response.status}: ${(await response.text()).slice(0, ERROR_BODY_CHARS)}`);
  }
  const body: any = await response.json();
  return {
    vectors: body.data.map((item: any) => Float32Array.from(item.embedding)),
    tokens: body.usage?.total_tokens ?? 0,
  };
}

async function embedViaVoyage(texts: string[], purpose: "document" | "query") {
  const response = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.voyageKey}`, "Content-Type": "application/json" },
    // Voyage asks which side of the pair this is; it embeds queries and documents into the
    // same space but with different instructions prepended.
    body: JSON.stringify({ model: "voyage-3-lite", input: texts, input_type: purpose }),
  });
  if (!response.ok) {
    throw new Error(`voyage embeddings ${response.status}: ${(await response.text()).slice(0, ERROR_BODY_CHARS)}`);
  }
  const body: any = await response.json();
  return {
    vectors: body.data.map((item: any) => Float32Array.from(item.embedding)),
    tokens: body.usage?.total_tokens ?? 0,
  };
}

/**
 * Cosine similarity, computed here instead of in a vector database.
 * At ~2 100 chunks a brute-force scan is a few milliseconds, so sqlite-vec or pgvector would
 * be ceremony (REPORT.md §2.8); the ×50 corpus in §3 is where that stops being true.
 *
 * Norms are recomputed on every call rather than cached with the vector. That is O(n) extra
 * work per comparison and would be the first thing to fix at 100k chunks — at this size it
 * is not measurable, and storing a norm alongside each BLOB is a schema change.
 * Returns 0 when either vector is all-zero (the "none" provider case), because a zero vector
 * has no direction and any other answer would be a made-up similarity.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}
