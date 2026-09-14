import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Turn } from "./turns.js";
export function reviewInputHash(turns: Turn[], metadata: unknown): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        turns,
        metadata,
        model: "gemini-3.8-flash",
        prompt: readFileSync("assistant/prompts/speaker-review.md", "utf8"),
      }),
    )
    .digest("hex");
}
