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
  return details(
    `Evidence score · ${trust.score} / 100`,
    el(
      "p",
      "muted",
      "A summary of evidence checks, not the probability that an answer is true. Read the sources and limitations below.",
    ),
    rows,
    limits,
  );
}
