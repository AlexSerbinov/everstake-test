import type { EvidencePassage, RunEvent } from "../../../src/contracts.js";
import { badge, details, el } from "../../shared/dom.js";
import { sourceCard } from "../answer-sources/source-cards.js";
import { ElapsedTimer } from "./elapsed-timer.js";
export class SearchTimeline {
  readonly node = el("details", "disclosure research");
  private rows = el("div", "timeline");
  private timer = new ElapsedTimer();
  private activeTimer = new ElapsedTimer();
  private active?: HTMLElement;
  private count = 0;
  private interacted = false;
  private sending = el("p", "muted small", "Sending your question…");
  private title = el("span", "", "Research in progress");
  constructor(private scope: string) {
    this.node.open = true;
    const summary = el("summary");
    const elapsed = el("span", "elapsed");
    summary.append(this.title, elapsed);
    this.node.append(
      summary,
      el(
        "p",
        "muted small",
        "Actual research activity. Elapsed time includes the connection to your browser.",
      ),
      this.rows,
    );
    this.rows.append(this.sending);
    this.timer.start(elapsed);
    this.node.addEventListener("pointerdown", () => {
      this.interacted = true;
    });
    this.node.addEventListener("keydown", () => {
      this.interacted = true;
    });
  }
  add(event: RunEvent) {
    this.sending.remove();
    if (event.type === "step" || event.type === "verification") {
      this.activeTimer.stop();
      this.active?.classList.remove("active");
      const row = el("div", "timeline-step active");
      const elapsed = el("span", "elapsed");
      const head = el("div", "section-heading");
      head.append(el("span", "", event.label), elapsed);
      row.append(head);
      const data = event.data as
        | { query?: string; title?: string; reason?: string }
        | undefined;
      if (data?.query || data?.title || data?.reason)
        row.append(
          el("p", "muted small", data.query || data.title || data.reason),
        );
      this.rows.append(row);
      this.active = row;
      this.activeTimer.start(elapsed);
      this.count++;
    }
    if (event.type === "sources") {
      const data = event.data as {
        sources?: EvidencePassage[];
        newCount?: number;
        repeated?: number;
      };
      const block = el("div", "search-results");
      block.append(
        badge(`${data.newCount ?? 0} new · ${data.repeated ?? 0} already seen`),
      );
      const list = el("div", "search-previews");
      for (const [index, source] of (data.sources ?? []).entries())
        list.append(
          sourceCard(
            [source],
            new Map(),
            `${this.scope}-search-${this.count}-${index}`,
          ),
        );
      const found = details(
        `${data.sources?.length ?? 0} passages found`,
        list,
      );
      found.open = true;
      block.append(
        el(
          "p",
          "muted small",
          "Read during research; these passages are not necessarily cited in the final answer.",
        ),
        found,
      );
      this.rows.append(block);
    }
  }
  finish(status: string) {
    this.timer.stop();
    this.activeTimer.stop();
    this.active?.classList.remove("active");
    this.title.textContent = `${status} · ${this.count} research steps`;
    if (!this.interacted) this.node.open = false;
  }
}
