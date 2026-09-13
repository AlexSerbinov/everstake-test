import type { EvaluationQuestion } from "../../../src/contracts.js";
import { badge, button, el, getJson } from "../../shared/dom.js";
export function questionForm(
  ask: (question: string) => void,
  cancel: () => void,
) {
  const node = el("section", "question-area");
  const intro = el("div", "intro");
  intro.append(
    el("p", "eyebrow", "EVERSTAKE · KNOWLEDGE ASSISTANT"),
    el("h1", "", "Good answers start\nwith good sources."),
    el(
      "p",
      "lede",
      "Explore Everstake’s public knowledge. Follow the research, check the dates, and read the evidence behind each answer.",
    ),
  );
  const form = el("form", "question-form");
  const label = el("label", "sr-only", "Your question");
  label.htmlFor = "question";
  const input = el("textarea");
  input.id = "question";
  input.name = "question";
  input.rows = 2;
  input.maxLength = 2000;
  input.minLength = 2;
  input.required = true;
  input.placeholder = "What would you like to know about Everstake?";
  const bottom = el("div", "form-bottom");
  const hint = el(
    "span",
    "small muted",
    "Public sources. Visible dates. Honest limits.",
  );
  const actions = el("div", "form-actions");
  const stop = button("Stop", cancel);
  stop.hidden = true;
  const submit = el("button", "button primary", "Ask a question ↗");
  submit.type = "submit";
  actions.append(stop, submit);
  bottom.append(hint, actions);
  form.append(label, input, bottom);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (value) ask(value);
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey))
      form.requestSubmit();
  });
  node.append(intro, form);
  const examples = el("div", "question-examples");
  examples.append(el("p", "eyebrow", "A FEW PLACES TO START"));
  const options = el("div", "example-list");
  for (const example of [
    "Who is the CEO of Everstake?",
    "How has Everstake’s positioning changed over time?",
    "What can public sources tell us about staking risks?",
  ])
    options.append(
      button(
        example,
        () => {
          input.value = example;
          input.focus();
        },
        "example-question",
      ),
    );
  examples.append(options);
  node.append(examples);
  const library = el("div", "question-library");
  const toggle = button(
    "Explore the evaluation questions →",
    () => {
      library.hidden = !library.hidden;
      if (!library.hidden && !library.childElementCount) void loadLibrary();
    },
    "text-button",
  );
  library.hidden = true;
  node.append(toggle, library);
  async function loadLibrary() {
    try {
      const { questions } = await getJson<{ questions: EvaluationQuestion[] }>(
        "/api/questions",
      );
      for (const question of questions) {
        const row = el("article", "question-option");
        row.append(
          badge(question.difficulty),
          button(
            question.question,
            () => {
              input.value = question.question;
              input.focus();
            },
            "text-button",
          ),
          el("p", "muted small", question.whyHard),
        );
        library.append(row);
      }
      if (!questions.length)
        library.append(
          el("p", "muted", "No evaluation questions have been published yet."),
        );
    } catch (error) {
      library.append(el("p", "error-text", (error as Error).message));
    }
  }
  return {
    node,
    setBusy(busy: boolean) {
      stop.hidden = !busy;
      submit.textContent = busy ? "Ask a new question ↗" : "Ask a question ↗";
      if (busy) node.classList.add("has-run");
    },
    focus() {
      input.focus();
    },
  };
}
