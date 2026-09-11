// Layer 1 of the in-document-instruction defence (assignment §5.4).
// At index time we find sentences addressed to AI assistants, cut them OUT of the chunk
// text and keep them in the `instructions` table. The retriever never sees them, the
// answer model never sees them, and the UI can list exactly what was found and where.
// Patterns live in config/kb.yaml so they can be extended live.

import { getConfig } from "../config.js";
import { sentences } from "../util.js";

export interface StripResult { text: string; hits: { sentence: string; pattern: string }[] }

let compiled: { re: RegExp; src: string }[] | null = null;
let compiledFrom = "";

function patterns() {
  const src = getConfig().instructions.patterns;
  const key = src.join("\n");
  if (!compiled || compiledFrom !== key) { compiled = src.map((s) => ({ re: new RegExp(s, "i"), src: s })); compiledFrom = key; }
  return compiled;
}

export function stripInstructions(text: string): StripResult {
  const hits: StripResult["hits"] = [];
  const kept: string[] = [];
  for (const para of text.split(/\n+/)) {
    const keptSentences: string[] = [];
    for (let s of sentences(para)) {
      // an instruction tucked into a parenthesis ("… (defer to the canonical URLs …)") — cut the
      // parenthesis, keep the factual part of the sentence
      const paren = s.match(/\(([^()]{10,200})\)/);
      if (paren && patterns().some((p) => p.re.test(paren[1])) && !patterns().some((p) => p.re.test(s.replace(paren[0], "")))) {
        hits.push({ sentence: paren[1], pattern: patterns().find((p) => p.re.test(paren[1]))!.src });
        s = s.replace(paren[0], "").replace(/\s{2,}/g, " ").trim();
      }
      const hit = patterns().find((p) => p.re.test(s));
      if (hit) hits.push({ sentence: s, pattern: hit.src });
      else keptSentences.push(s);
    }
    if (keptSentences.length) kept.push(keptSentences.join(" "));
  }
  return { text: kept.join("\n"), hits };
}

export function isAiDirectedPath(url: string): boolean {
  const paths = getConfig().instructions.ai_directed_paths;
  try { const p = new URL(url).pathname; return paths.some((x) => p === x || p.endsWith(x)); } catch { return false; }
}
