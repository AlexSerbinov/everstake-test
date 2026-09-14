import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Records reproducibility inputs without reading credentials or evaluation references. */
export function runtimeManifest() {
  const digest = createHash("sha256");
  for (const directory of [
    "assistant/config",
    "assistant/prompts",
    "assistant/agents",
    "assistant/skills",
  ]) {
    for (const filename of readdirSync(directory, { recursive: true })
      .map(String)
      .sort()) {
      if (!/\.(yaml|md|json)$/.test(filename)) continue;
      digest
        .update(directory + "/" + filename)
        .update(readFileSync(directory + "/" + filename));
    }
  }
  let codeVersion = process.env.CODE_VERSION ?? "unknown";
  if (codeVersion === "unknown")
    try {
      codeVersion = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}
  let dirtyDiffHash: string | null = null;
  try {
    const diff = execFileSync(
      "git",
      [
        "diff",
        "HEAD",
        "--",
        "src",
        "web",
        "scripts",
        "assistant/config",
        "assistant/prompts",
        "assistant/agents",
        "assistant/skills",
        "package.json",
        "package-lock.json",
      ],
      { maxBuffer: 20_000_000 },
    );
    // A review copy deliberately has no new commits. Git diff omits untracked
    // helpers, so include their paths and bytes in the same reproducibility hash.
    const untracked = execFileSync(
      "git",
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        "src",
        "web",
        "scripts",
        "assistant",
      ],
      { encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean)
      .sort();
    if (diff.length || untracked.length) {
      const changes = createHash("sha256").update(diff);
      for (const path of untracked)
        changes.update("\0" + path + "\0").update(readFileSync(path));
      dirtyDiffHash = changes.digest("hex");
    }
  } catch {}
  return {
    codeVersion,
    dirtyDiffHash,
    configHash: digest.digest("hex"),
    parserVersion: "typescript-extractor-v1",
    recordedAt: new Date().toISOString(),
  };
}
