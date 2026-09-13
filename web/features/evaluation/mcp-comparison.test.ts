import { test } from "node:test";
import assert from "node:assert/strict";
import type { EvaluationRun } from "./evaluation-page.js";
import { matchingMcpRun } from "./mcp-comparison.js";
test("MCP comparison requires the same twenty questions and complete assessment", () => {
  const base = {
    mode: "agent",
    rows: Array.from({ length: 20 }, (_, i) => ({
      question: `Q${i}`,
      answer: null,
      verdict: "pass",
    })),
  } as EvaluationRun;
  const mcp = {
    ...base,
    id: "mcp",
    mode: "mcp",
    createdAt: "2026-09-13",
    status: "completed",
    summary: { assessed: 20 },
  } as EvaluationRun;
  assert.equal(matchingMcpRun(base, [mcp]), mcp);
  assert.equal(
    matchingMcpRun(base, [
      { ...mcp, rows: [...mcp.rows.slice(1), mcp.rows[1]!] },
    ]),
    undefined,
  );
  assert.equal(
    matchingMcpRun(base, [
      { ...mcp, summary: { ...mcp.summary, assessed: 0 } },
    ]),
    undefined,
  );
  assert.equal(
    matchingMcpRun(base, [
      {
        ...mcp,
        rows: mcp.rows.map((r, i) =>
          i ? r : { ...r, question: "Different question" },
        ),
      },
    ]),
    undefined,
  );
});
