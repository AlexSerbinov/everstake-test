import { resolve } from "node:path";
import { importYouTube } from "../src/services/youtube/import-youtube.js";

const flags = parseFlags(process.argv.slice(2));
if (!flags.source || !flags.target || !flags.documents) {
  throw new Error(
    "Usage: npx tsx scripts/import-youtube.ts --source=... --target=... --documents=... [--dry-run]",
  );
}

const report = importYouTube({
  sourceDatabasePath: resolve(flags.source),
  targetDatabasePath: resolve(flags.target),
  documentsPath: resolve(flags.documents),
  dryRun: flags["dry-run"] === "true",
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function parseFlags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [key, ...value] = arg.slice(2).split("=");
    result[key] = value.length ? value.join("=") : "true";
  }
  return result;
}
