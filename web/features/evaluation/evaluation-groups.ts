import type { ResultRow } from "./question-result-card.js";
export type ResultState = "passed" | "failed" | "ungraded" | "error";
export type QuestionGroup = "all" | "simple" | "hard" | "negative";
export function resultState(row: ResultRow): ResultState {
  if (
    row.answer &&
    typeof row.answer !== "string" &&
    row.answer.status === "error"
  )
    return "error";
  if (["correct", "correct_abstention", "pass"].includes(row.verdict))
    return "passed";
  if (
    ["wrong", "partial", "false_abstention", "fail", "incorrect"].includes(
      row.verdict,
    )
  )
    return "failed";
  return "ungraded";
}
export function inGroup(row: ResultRow, group: QuestionGroup): boolean {
  if (group === "all") return true;
  if (typeof row.question === "string") return false;
  return group === "negative"
    ? row.question.negative === true
    : row.question.difficulty === (group === "simple" ? "basic" : "hard");
}
export function groupMetrics(rows: ResultRow[], group: QuestionGroup) {
  const selected = rows.filter((row) => inGroup(row, group));
  const passed = selected.filter((row) => resultState(row) === "passed").length;
  const checked = selected.filter((row) =>
    [
      "correct",
      "correct_abstention",
      "pass",
      "wrong",
      "partial",
      "false_abstention",
      "fail",
      "incorrect",
    ].includes(row.verdict),
  ).length;
  return {
    total: selected.length,
    passed,
    checked,
    accuracy:
      selected.length > 0 && checked === selected.length
        ? passed / selected.length
        : null,
  };
}
export function selectResults(
  rows: ResultRow[],
  group: QuestionGroup,
  state: string,
): ResultRow[] {
  return rows.filter(
    (row) =>
      inGroup(row, group) && (state === "all" || resultState(row) === state),
  );
}
