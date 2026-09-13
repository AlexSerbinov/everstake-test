import type { TrustScore } from "../../../src/contracts.js";
import { details, el } from "../../shared/dom.js";
export function trustScore(trust: TrustScore | null): HTMLElement {
  if (!trust)
    return el(
      "p",
      "muted small",
      "An evidence score is not available for this answer.",
    );
  const rows = el("div", "trust-components");
  for (const component of trust.components) {
    const row = el("div", "trust-row");
    const heading = el("div", "section-heading");
    heading.append(
      el("strong", "", component.name.replaceAll("_", " ")),
      el("span", "", `${component.score} / ${component.maximum}`),
    );
    const meter = el("meter");
    meter.min = 0;
    meter.max = component.maximum || 1;
    meter.value = component.score;
    meter.setAttribute("aria-label", component.name);
    row.append(heading, meter, el("p", "muted small", component.reason));
    rows.append(row);
  }
  const limits = el("ul", "limits");
  trust.limitations.forEach((reason) => limits.append(el("li", "", reason)));
  const box = details(
    "Evidence score",
    el(
      "p",
      "muted",
      "A summary of evidence checks, not the probability that an answer is true. Read the sources and limitations below.",
    ),
    rows,
    el("h3", "eyebrow", "Limitations"),
    trust.limitations.length
      ? limits
      : el("p", "muted small", "No additional limitations were recorded."),
  );
  box.classList.add("trust-disclosure");
  const summary = box.querySelector("summary")!;
  summary.replaceChildren(el("span", "disclosure-heading", "Evidence score"));
  const score = el("meter", "trust-summary-meter");
  score.min = 0;
  score.max = 100;
  score.value = trust.score;
  score.setAttribute(
    "aria-label",
    "Evidence score, not a probability of truth",
  );
  summary.append(score, el("span", "disclosure-count", `${trust.score} / 100`));
  return box;
}
