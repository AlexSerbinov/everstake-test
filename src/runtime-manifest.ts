import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

/** Records reproducibility inputs without reading credentials or evaluation references. */
export function runtimeManifest() {
  const digest = createHash("sha256");
  for (const directory of ["config", "prompts", "agents", "skills"]) {
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
        "config",
        "prompts",
        "agents",
        "skills",
        "package.json",
        "package-lock.json",
      ],
      { maxBuffer: 20_000_000 },
    );
    if (diff.length)
      dirtyDiffHash = createHash("sha256").update(diff).digest("hex");
  } catch {}
  return {
    codeVersion,
    dirtyDiffHash,
    configHash: digest.digest("hex"),
    parserVersion: "typescript-extractor-v1",
    recordedAt: new Date().toISOString(),
  };
}
