import type { EvidencePassage, RunEvent } from "../../../src/contracts.js";
import { badge, el, link } from "../../shared/dom.js";
import { date } from "../../shared/source-date.js";
import { ElapsedTimer } from "./elapsed-timer.js";
export class SearchTimeline {
  readonly node = el("details", "disclosure research");
  private rows = el("div", "timeline");
  private timer = new ElapsedTimer();
  private activeTimer = new ElapsedTimer();
  private active?: HTMLElement;
  private count = 0;
  private sending = el("p", "muted small", "Sending your question…");
  private title = el("span", "", "Research in progress");
  constructor(_scope: string) {
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
        { query?: string; title?: string; reason?: string } | undefined;
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
      // One flat line per page: title, publisher and date. Full passages appear only in the
      // answer's source cards, so the log stays readable on a phone.
      const block = el("div", "search-results");
      block.append(
        badge(`${data.newCount ?? 0} new · ${data.repeated ?? 0} already seen`),
      );
      const list = el("ul", "found-list");
      const pages = new Map<string, EvidencePassage>();
      for (const source of data.sources ?? [])
        if (!pages.has(source.documentId || source.url))
          pages.set(source.documentId || source.url, source);
      for (const source of pages.values()) {
        const row = el("li", "found-row");
        const when = source.updatedAt ?? source.publishedAt;
        row.append(
          link(source.title || source.url, source.url),
          el(
            "span",
            "muted small",
            `${source.publisher}${when ? ` · ${date(when).slice(0, 10)}` : " · undated"}`,
          ),
        );
        list.append(row);
      }
      block.append(list);
      this.rows.append(block);
    }
  }
  finish(status: string) {
    this.timer.stop();
    this.activeTimer.stop();
    this.active?.classList.remove("active");
    this.title.textContent = `${status} · ${this.count} research steps`;
    this.node.open = false;
  }
}
