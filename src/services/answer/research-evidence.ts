import { randomUUID } from "node:crypto";
import type { EvidencePassage } from "../../contracts.js";
import {
  calculate,
  calculateExpression,
  scenarioNumbers,
} from "./calculate.js";
import { numbers } from "./verify-answer.js";
import type { ResearchAction } from "./research-action.js";

/** Prioritize cited draft passages, then unseen results, then earlier evidence. */
export function updateEvidenceWindow(
  registry: Map<string, EvidencePassage>,
  sources: EvidencePassage[],
  limit: number,
  keep: string[] = [],
): { fresh: number; repeated: number } {
  const fresh = sources.filter((source) => !registry.has(source.id));
  const repeated = sources.length - fresh.length;
  // Repairs must retain their cited passages even when counterevidence fills the window.
  const kept = keep
    .map((id) => registry.get(id))
    .filter((source): source is EvidencePassage => !!source);
  const window = [...kept, ...fresh, ...registry.values()]
    .filter(
      (source, index, all) =>
        all.findIndex((other) => other.id === source.id) === index,
    )
    .slice(0, limit);
  registry.clear();
  for (const source of window) registry.set(source.id, source);
  return { fresh: fresh.length, repeated };
}

/**
 * Arithmetic runs locally. Every literal operand must come from the question or a
 * cited passage; the resulting passage retains those inputs for citation checks.
 * Null means unsupported inputs; malformed/unsafe arithmetic still throws.
 */
export function createCalculationEvidence(
  action: Extract<ResearchAction, { action: "calculate" }>,
  registry: Map<string, EvidencePassage>,
  question: string,
): EvidencePassage | null {
  const computation = action.expression
    ? calculateExpression(action.expression)
    : {
        value: calculate(action.operation ?? "", action.operands ?? []),
        operands: action.operands ?? [],
        steps: [],
      };
  const cited = action.citations.map((id) => registry.get(id));
  const known = new Set([
    ...scenarioNumbers(question).map(String),
    ...numbers(
      cited
        .filter(Boolean)
        .map((s) => s!.text)
        .join(" "),
    ),
  ]);
  if (
    cited.some((source) => !source) ||
    computation.operands.some((value) => !known.has(String(value)))
  )
    return null;
  const value = computation.value;
  const base = cited[0]!;
  return {
    ...base,
    id: `calc-${randomUUID().slice(0, 8)}`,
    text: `Calculated scenario: ${action.expression ?? `${action.operation}(${computation.operands.join(", ")})`} = ${value}; steps: ${computation.steps.join("; ")}. Inputs from user scenario and sources: ${action.citations.join(", ")}.\n${cited.map((s) => s!.text).join("\n")}`,
    reason: "Deterministic source-backed calculation",
    metadata: {
      ...base.metadata,
      calculation: {
        operation: action.operation,
        expression: action.expression,
        operands: computation.operands,
        result: value,
        citations: action.citations,
      },
    },
  };
}
