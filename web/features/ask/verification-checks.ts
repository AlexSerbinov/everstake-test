import type { CheckResult } from "../../../src/contracts.js";
import { badge, details, el } from "../../shared/dom.js";
export function verificationChecks(checks: CheckResult[]): HTMLElement {
  const list = el("div", "checks");
  for (const check of checks) {
    const row = el("div", `check check-${check.status}`);
    row.append(
      badge(
        check.status === "passed"
          ? "Passed"
          : check.status === "failed"
            ? "Failed"
            : "Not applicable",
        check.status === "failed"
          ? "danger"
          : check.status === "passed"
            ? "success"
            : "",
      ),
      el("strong", "", check.rule.replaceAll("_", " ")),
      el("p", "muted small", check.reason),
    );
    list.append(row);
  }
  if (!checks.length)
    list.append(el("p", "muted small", "No answer checks were recorded."));
  const box = details(
    "Answer checks",
    el(
      "p",
      "muted small",
      "These checks test evidence rules. They do not independently establish that every conclusion is correct.",
    ),
    list,
  );
  box.classList.add("checks-disclosure");
  const summary = box.querySelector("summary")!;
  summary.replaceChildren(el("span", "disclosure-heading", "Answer checks"));
  const failed = checks.filter((check) => check.status === "failed").length;
  const passed = checks.filter((check) => check.status === "passed").length;
  const skipped = checks.filter(
    (check) => check.status === "not_applicable",
  ).length;
  summary.append(
    el(
      "span",
      "disclosure-count",
      checks.length
        ? `${passed} passed${failed ? ` · ${failed} failed` : ""}${skipped ? ` · ${skipped} not applicable` : ""}`
        : "Not recorded",
    ),
  );
  return box;
}
