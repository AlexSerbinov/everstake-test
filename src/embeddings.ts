// Text → vector. Providers: OpenAI text-embedding-3-small (1536), Voyage voyage-3-lite (512),
// or "none" (retrieval degrades to BM25-only and the trace says so).
// Token usage is logged to llm_calls (stage=embed) so index cost is measured, not guessed.

import { env } from "./config.js";
import { logCall, priceUsd } from "./llm.js";

export const EMBED_MODEL = env.embeddingsProvider === "openai" ? "text-embedding-3-small" : env.embeddingsProvider === "voyage" ? "voyage-3-lite" : "none";

export function embeddingsEnabled() {
  return env.embeddingsProvider !== "none";
}

/** Embed up to ~100 texts per call. Returns one Float32Array per input. */
export async function embed(texts: string[], purpose: "document" | "query" = "document"): Promise<Float32Array[]> {
  if (!embeddingsEnabled() || texts.length === 0) return texts.map(() => new Float32Array(0));
  const t0 = Date.now();
  try {
    const { vectors, tokens } = env.embeddingsProvider === "openai" ? await openai(texts) : await voyage(texts, purpose);
    logCall({ stage: "embed", provider: env.embeddingsProvider, model: EMBED_MODEL, input: tokens, costUsd: priceUsd(EMBED_MODEL, { input: tokens, output: 0 }), latencyMs: Date.now() - t0, meta: { n: texts.length, purpose } });
    return vectors;
  } catch (e: any) {
    logCall({ stage: "embed", provider: env.embeddingsProvider, model: EMBED_MODEL, latencyMs: Date.now() - t0, ok: false, error: String(e?.message ?? e) });
    throw e;
  }
}

async function openai(texts: string[]) {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  if (!res.ok) throw new Error(`openai embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  return { vectors: j.data.map((d: any) => Float32Array.from(d.embedding)), tokens: j.usage?.total_tokens ?? 0 };
}

async function voyage(texts: string[], purpose: "document" | "query") {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.voyageKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "voyage-3-lite", input: texts, input_type: purpose }),
  });
  if (!res.ok) throw new Error(`voyage embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j: any = await res.json();
  return { vectors: j.data.map((d: any) => Float32Array.from(d.embedding)), tokens: j.usage?.total_tokens ?? 0 };
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
