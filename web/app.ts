import { findingsPage } from "./features/findings/findings-page.js";
import { collectionSummary } from "./features/collection-summary/collection-summary.js";
import { updatesPage } from "./features/updates/updates-page.js";
import type { AnswerResult, RunEvent } from "../src/contracts.js";
import { button, el, getJson } from "./shared/dom.js";
import { answerText } from "./features/answer-export/answer-export.js";
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
  const toolbar = el("div", "answer-toolbar");
  toolbar.append(button("← New question", newQuestion, "button secondary"));
  const exportActions = el("div", "answer-actions");
  toolbar.append(exportActions);
  heading.append(el("p", "eyebrow", "YOUR QUESTION"), el("h2", "", question));
  const copyNotice = el("p", "small muted export-notice");
  copyNotice.setAttribute("role", "status");
  toolbar.append(copyNotice);
  const result = el("div", "answer-slot");
  timeline = new SearchTimeline(scope);
  const currentTimeline = timeline;
  // The answer is rendered above the research log: readers see the result first and open
  // the log only when they want to audit how it was found.
  output.replaceChildren(toolbar, heading, result, currentTimeline.node);
  toolbar.scrollIntoView({ behavior: "instant", block: "start" });
  let receivedAnswer = false;
  let failed = false;
  const handle = (event: RunEvent) => {
    if (!run.current()) return;
    if (event.type === "answer") {
      const answer = event.data as AnswerResult;
      receivedAnswer = true;
      failed = answer.status === "error";
      result.replaceChildren(answerView(answer, scope));
      exportActions.replaceChildren(
        button("Copy answer", () => {
          void Promise.resolve()
            .then(() =>
              navigator.clipboard.writeText(answerText(question, answer)),
            )
            .then(() => {
              status.textContent = "Answer and sources copied.";
              copyNotice.textContent = "Answer and sources copied.";
            })
            .catch(() => {
              copyNotice.textContent =
                "Clipboard unavailable. Use Download evidence to save this answer.";
            });
        }),
        button("Download evidence ↓", () => {
          const payload = { ...answer, question };
          const url = URL.createObjectURL(
            new Blob([JSON.stringify(payload, null, 2)], {
              type: "application/json",
            }),
          );
          const download = document.createElement("a");
          download.href = url;
          download.download = "everstake-answer-evidence.json";
          download.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }),
      );
      status.textContent = failed
        ? "The request failed."
        : "Your answer is ready.";
      currentTimeline.finish(failed ? "Request failed" : "Research complete");
      toolbar.scrollIntoView({ behavior: "instant", block: "start" });
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
    // The server runs one question at a time and releases the slot right after a stop;
    // a brief retry hides that hand-over instead of showing a "still running" error.
    let response: Response;
    for (let attempt = 0; ; attempt++) {
      response = await fetch("/api/ask", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ question }),
        signal: run.signal,
      });
      if (response.status !== 429 || attempt >= 8) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (!run.current()) return;
    }
    await readRunStream(response, handle, run.signal);
    if (run.current()) {
      if (!receivedAnswer && !failed)
        throw new Error(
          "The request ended without an answer. Please try again.",
        );
      if (!receivedAnswer) currentTimeline.finish("Request failed");
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
let disposePage: (() => void) | undefined;
let focusQuestionAfterNavigation = false;
function newQuestion() {
  state.cancel();
  timeline?.finish("Stopped");
  form.setBusy(false);
  form.reset();
  output.replaceChildren();
  status.textContent = "Ready for a new question.";
  focusQuestionAfterNavigation = true;
  if (location.hash !== "#ask") location.hash = "ask";
  else navigate();
}

const menu = document.querySelector<HTMLButtonElement>(".menu-toggle")!;
const sidebar = document.getElementById("sidebar")!;
function closeMenu() {
  sidebar.classList.remove("is-open");
  menu.setAttribute("aria-expanded", "false");
  menu.setAttribute("aria-label", "Open navigation");
}
menu.addEventListener("click", () => {
  const expanded = menu.getAttribute("aria-expanded") !== "true";
  sidebar.classList.toggle("is-open", expanded);
  menu.setAttribute("aria-expanded", String(expanded));
  menu.setAttribute(
    "aria-label",
    expanded ? "Close navigation" : "Open navigation",
  );
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menu.getAttribute("aria-expanded") === "true") {
    closeMenu();
    menu.focus();
  }
});
document
  .querySelectorAll<HTMLAnchorElement>("[data-new-question]")
  .forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      newQuestion();
    });
  });
sidebar
  .querySelectorAll("a")
  .forEach((link) => link.addEventListener("click", () => closeMenu()));
function navigate() {
  closeMenu();
  disposePage?.();
  disposePage = undefined;
  const route = location.hash.slice(1) || "ask";
  const selected =
    route === "findings" || route.startsWith("findings/")
      ? "findings"
      : ["ask", "corpus", "updates", "costs", "evaluation"].includes(route)
        ? route
        : "ask";
  document.querySelector(".knowledge-rail")?.remove();
  if (selected === "ask")
    document.querySelector(".app-shell")!.append(collectionSummary());
  document
    .querySelectorAll<HTMLAnchorElement>("[data-page]")
    .forEach((link) => {
      if (link.dataset.page === selected)
        link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    });
  const updates = selected === "updates" ? updatesPage() : undefined;
  disposePage = updates?.destroy;
  root.replaceChildren(
    updates
      ? updates.node
      : selected === "corpus"
        ? corpusPage()
        : selected === "costs"
          ? costOverview()
          : selected === "evaluation"
            ? evaluationPage()
            : selected === "findings"
              ? findingsPage(
                  route.startsWith("findings/") ? route.slice(9) : undefined,
                )
              : questionPage,
  );
  window.scrollTo({ top: 0, behavior: "instant" });
  if (selected === "ask" && focusQuestionAfterNavigation) {
    focusQuestionAfterNavigation = false;
    form.focus();
  }
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
  disposePage?.();
  state.cancel();
  timeline?.finish("Stopped");
});
navigate();

void getJson<{ total: number; version: string }>("/api/corpus")
  .then((collection) => {
    document.getElementById("corpus-count")!.textContent =
      collection.total.toLocaleString();
    document.getElementById("collection-summary")!.textContent =
      `${collection.total.toLocaleString()} documents · ${collection.version}`;
  })
  .catch(() => {
    document.getElementById("collection-summary")!.textContent =
      "Collection status unavailable. Open Corpus to try again.";
  });
