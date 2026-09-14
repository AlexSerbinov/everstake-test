/** Offline packaging check: moved files must still be reachable from code and reviewer docs. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { readPolicy, readResearcher, readSources } from "../src/config.js";
import { loadModelsConfig } from "../src/providers/provider-config.js";

const failures: string[] = [];
const requirePath = (path: string) => {
  if (!existsSync(path)) failures.push(`Missing file: ${path}`);
};
for (const path of [
  "README.md",
  "submission_ukr/README.md",
  "REPORT.md",
  "submission_ukr/REPORT.md",
  "PROCESS.md",
  "submission_ukr/PROCESS.md",
  "COST.md",
  "submission_ukr/COST.md",
  "EVAL.md",
  "submission_ukr/EVAL.md",
  "TIMELOG.md",
  "submission_ukr/TIMELOG.md",
  ".env.example",
  "docs/TIME.md",
  "docs/TEST_ASSIGNMENT_EN.md",
  "docs/corpus_sources.csv",
  "deploy/Dockerfile",
  "deploy/compose.yaml",
])
  requirePath(path);

// Keep GitHub's repository landing page pointed at the root README.
for (const name of readdirSync(".github"))
  if (/^readme(?:\.|$)/i.test(name))
    failures.push(`.github/${name} would override the root README on GitHub; use OVERVIEW.md`);

// Validate real settings and every researcher input without making provider calls.
readPolicy();
readSources();
loadModelsConfig();
const researcher = readResearcher();
for (const path of [researcher.prompt, ...researcher.skills]) requirePath(path);

function markdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    // Historical design references may point to retired prototypes or the author's old files.
    if (
      ["node_modules", ".git", "data", "output"].includes(entry.name) ||
      path === "./docs/history" ||
      path === "./docs/plan" ||
      path === "./docs/evaluation/general-quality"
    )
      return [];
    return entry.isDirectory()
      ? markdownFiles(path)
      : path.endsWith(".md")
        ? [path]
        : [];
  });
}

// New folders need an entry point too. Presence is mechanical; clarity still needs review.
let folderGuides = 0;
function checkFolderGuides(directory: string): void {
  const entries = readdirSync(directory, { withFileTypes: true });
  if (!entries.length) return;
  // A README in .github takes precedence over the submission README on GitHub.
  const guide = directory === ".github" ? ".github/OVERVIEW.md" : `${directory}/README.md`;
  if (!existsSync(guide) || !readFileSync(guide, "utf8").trim())
    failures.push(`Missing or empty folder guide: ${guide}`);
  else folderGuides++;
  for (const entry of entries)
    if (entry.isDirectory()) checkFolderGuides(`${directory}/${entry.name}`);
}
for (const directory of [
  ".github",
  "assistant",
  "src",
  "web",
  "public",
  "scripts",
  "deploy",
  "eval",
  "artifacts",
  "docs",
  "submission_ukr",
])
  checkFolderGuides(directory);

let links = 0;
for (const file of markdownFiles(".")) {
  const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "");
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1]!.split("#")[0]!;
    if (!target || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) continue;
    links++;
    if (!existsSync(resolve(dirname(file), decodeURIComponent(target))))
      failures.push(`${file}: broken local link ${target}`);
  }
}

const composePath = "deploy/compose.yaml";
const compose = parse(readFileSync(composePath, "utf8"));
if (compose.name !== "everstate-knowledge-base")
  failures.push("Compose project name must retain the existing demo identity");
const service = compose.services.knowledge;
const context = resolve(dirname(composePath), service.build.context);
if (context !== process.cwd())
  failures.push("Docker build context must be the repository root");
requirePath(resolve(context, service.build.dockerfile));
if (service.env_file !== "../.env")
  failures.push("Compose must load the root .env");
// Mutable data need not exist in a clean clone, but mounts must retain their root locations.
for (const mount of ["../data:/app/data", "../artifacts:/app/artifacts"])
  if (!service.volumes.includes(mount))
    failures.push(`Missing persistent mount: ${mount}`);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Repository inputs, ${folderGuides} folder guides and ${links} local Markdown file links verified.`,
  );
  console.log(
    "Historical design references, external URLs, and heading anchors are not checked.",
  );
}
