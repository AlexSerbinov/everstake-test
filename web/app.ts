import type { AnswerResult, RunEvent } from "../src/contracts.js";
import { el } from "./shared/dom.js";
import { questionForm } from "./features/question/question-form.js";
import { SearchTimeline } from "./features/live-search/search-timeline.js";
import { answerView } from "./features/answer/answer-view.js";
import { requestError } from "./features/request-error/request-error.js";
import { corpusPage } from "./features/corpus/corpus-page.js";
import { costOverview } from "./features/costs/cost-overview.js";
import { evaluationPage } from "./features/evaluation/evaluation-page.js";
import { readRunStream } from "./transport/read-run-stream.js";
import { RunState } from "./run-state.js";

const root = document.getElementById("app")!;
const state = new RunState();
let timeline: SearchTimeline | undefined;
const questionPage = el("section", "question-page");
const output = el("section", "run-output");
output.setAttribute("aria-label", "Answer and research");
const status = el("p", "sr-only");
status.setAttribute("role", "status");
status.setAttribute("aria-live", "polite");
const form = questionForm(
  (question) => void ask(question),
  () => {
    state.cancel();
    timeline?.finish("Stopped");
    form.setBusy(false);
    status.textContent = "Request stopped";
    output.append(
      el(
        "p",
        "notice",
        "Stopped receiving this answer. Calls already started may still finish and incur charges.",
      ),
    );
  },
);
questionPage.append(form.node, status, output);

async function ask(question: string) {
  timeline?.finish("Replaced by a new question");
  const run = state.start();
  form.setBusy(true);
  status.textContent = "Your question has been sent.";
  const scope = run.scope;
  const heading = el("div", "question-heading");
  heading.append(el("p", "eyebrow", "YOUR QUESTION"), el("h2", "", question));
  const result = el("div");
  timeline = new SearchTimeline(scope);
  const currentTimeline = timeline;
  output.replaceChildren(heading, currentTimeline.node, result);
  let receivedAnswer = false;
  let failed = false;
  const handle = (event: RunEvent) => {
    if (!run.current()) return;
    if (event.type === "answer") {
      const answer = event.data as AnswerResult;
      receivedAnswer = true;
      failed = answer.status === "error";
      result.replaceChildren(answerView(answer, scope));
      status.textContent = failed
        ? "The request failed."
        : "Your answer is ready.";
    } else if (event.type === "error") {
      failed = true;
      currentTimeline.finish("Request failed");
      const data = event.data as
        { message?: string; error?: string } | undefined;
      result.replaceChildren(
        requestError(
          data?.error ||
            data?.message ||
            event.label ||
            "The request failed. Please try again.",
        ),
      );
      status.textContent = "The request failed.";
    } else if (event.type !== "done") currentTimeline.add(event);
  };
  try {
    const response = await fetch("/api/ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ question }),
      signal: run.signal,
    });
    await readRunStream(response, handle, run.signal);
    if (run.current()) {
      if (!receivedAnswer && !failed)
        throw new Error(
          "The request ended without an answer. Please try again.",
        );
      currentTimeline.finish(failed ? "Request failed" : "Research complete");
    }
  } catch (error) {
    if (!run.current()) return;
    currentTimeline.finish("Request failed");
    result.replaceChildren(requestError((error as Error).message));
    status.textContent = "The request failed.";
  } finally {
    if (run.current()) form.setBusy(false);
  }
}
function navigate() {
  const route = location.hash.slice(1) || "ask";
  const selected = ["ask", "corpus", "costs", "evaluation"].includes(route)
    ? route
    : "ask";
  document
    .querySelectorAll<HTMLAnchorElement>("[data-page]")
    .forEach((link) => {
      if (link.dataset.page === selected)
        link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  root.replaceChildren(
    selected === "corpus"
      ? corpusPage()
      : selected === "costs"
        ? costOverview()
        : selected === "evaluation"
          ? evaluationPage()
          : questionPage,
  );
  window.scrollTo({ top: 0, behavior: "instant" });
  document.title = `${selected === "ask" ? "Ask" : selected[0].toUpperCase() + selected.slice(1)} · Everstake Knowledge`;
}
// The accessibility skip target is a document anchor, not an application route.
document
  .querySelector<HTMLAnchorElement>(".skip-link")
  ?.addEventListener("click", (event) => {
    event.preventDefault();
    const main = document.getElementById("main")!;
    main.focus({ preventScroll: true });
    main.scrollIntoView({ behavior: "instant" });
  });
window.addEventListener("hashchange", navigate);
window.addEventListener("pagehide", () => {
  state.cancel();
  timeline?.finish("Stopped");
});
navigate();
