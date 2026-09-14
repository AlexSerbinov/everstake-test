import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

// Exercise the real command boundary with no disk database or provider credentials.
function runCli(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      DB_PATH: ":memory:",
      GEMINI_API_KEY: "",
      OPENAI_API_KEY: "",
      SONIOX_API_KEY: "",
    },
  });
}

test("CLI stats reads an empty database without provider access", () => {
  const result = runCli("stats");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    documents: { count: 0 },
    chunks: { count: 0 },
  });
});

test("CLI missing resume ID reports the validation error with a failed exit status", () => {
  const result = runCli("refresh-resume");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refresh-resume requires a job ID/);
  assert.equal(result.stdout, "");
});

test("CLI without a command lists the supported operations without doing paid work", () => {
  const result = runCli();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Commands: ask <question>/);
  assert.match(result.stdout, /refresh-resume <job ID>/);
});
