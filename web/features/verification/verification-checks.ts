import type { CheckResult } from "../../../src/contracts.js";
import { badge, details, el } from "../../shared/dom.js";
export function verificationChecks(checks: CheckResult[]): HTMLElement {
  const list = el("div", "checks");
  for (const check of checks) {
    const row = el("div", "check");
    row.append(
      badge(
        check.status === "passed"
          ? "Passed"
          : check.status === "failed"
            ? "Failed"
            : "Not applicable",
        check.status === "failed" ? "danger" : "",
      ),
      el("strong", "", check.rule.replaceAll("_", " ")),
      el("p", "muted small", check.reason),
    );
    list.append(row);
  }
  return details(
    "Answer checks",
    el(
      "p",
      "muted small",
      "These checks test evidence rules. They do not independently establish that every conclusion is correct.",
    ),
    list,
  );
}
