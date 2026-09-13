import type { EvaluationQuestion } from "../../../src/contracts.js";
import { badge, button, el, getJson } from "../../shared/dom.js";

export function questionForm(
  ask: (question: string) => void,
  cancel: () => void,
) {
  const node = el("section", "question-area");
  const intro = el("div", "intro");
  intro.append(
    el("p", "eyebrow", "ASK THE KNOWLEDGE BASE"),
    el("h1", "", "Answers you can\ncheck line by line."),
    el(
      "p",
      "lede",
      "Explore Everstake through dated public sources. Follow the research, inspect the evidence and see the measured cost of each answer.",
    ),
  );
  const form = el("form", "question-form");
  const label = el("label", "sr-only", "Your question");
  label.htmlFor = "question";
  const input = el("textarea");
  input.id = "question";
  input.name = "question";
  input.rows = 3;
  input.maxLength = 2000;
  input.minLength = 2;
  input.required = true;
  input.placeholder = "Ask about Everstake products, networks, security…";
  const bottom = el("div", "form-bottom");
  const hint = el(
    "span",
    "small muted",
    "Public sources only · visible dates · honest limits",
  );
  const actions = el("div", "form-actions");
  const stop = button("Stop", cancel);
  stop.hidden = true;
  const submit = el("button", "button primary");
  submit.type = "submit";
  const submitLabel = el("span", "", "Ask a question");
  const arrow = el("span", "button-icon", "→");
  arrow.setAttribute("aria-hidden", "true");
  submit.append(submitLabel, arrow);
  actions.append(stop, submit);
  bottom.append(hint, actions);
  form.append(label, input, bottom);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (value.length >= 2) ask(value);
    else {
      input.setCustomValidity("Enter at least two non-space characters.");
      input.reportValidity();
    }
  });
  input.addEventListener("input", () => input.setCustomValidity(""));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  node.append(intro, form);

  const examples = el("div", "question-examples");
  const exampleHeading = el("div", "section-heading");
  const counts = el("span", "small muted");
  exampleHeading.append(el("p", "eyebrow", "TRY A HARD ONE"), counts);
  const options = el("div", "example-list");
  examples.append(exampleHeading, options);
  node.append(examples);
  const library = el("div", "question-library");
  library.id = "question-library";
  library.hidden = true;
  const toggle = button(
    "Explore all evaluation questions →",
    () => {
      library.hidden = !library.hidden;
      toggle.setAttribute("aria-expanded", String(!library.hidden));
      toggle.textContent = library.hidden
        ? "Explore all evaluation questions →"
        : "Hide evaluation questions ↑";
    },
    "text-button",
  );
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", library.id);
  toggle.hidden = true;
  node.append(toggle, library);

  function choose(question: string) {
    input.value = question;
    input.setCustomValidity("");
    input.focus();
  }
  function showExamples(
    questions: Array<{ question: string; difficulty: string }>,
  ) {
    options.replaceChildren();
    for (const question of questions) {
      const option = button(
        "",
        () => choose(question.question),
        "example-question",
      );
      option.append(
        el("span", "example-tag", question.difficulty.replaceAll("_", " ")),
        el("span", "example-text", question.question),
      );
      options.append(option);
    }
  }
  showExamples([
    { question: "Who is the CEO of Everstake?", difficulty: "Factual lookup" },
    {
      question: "How has Everstake’s positioning changed over time?",
      difficulty: "Synthesis",
    },
  ]);
  void getJson<{ questions: EvaluationQuestion[] }>("/api/questions")
    .then(({ questions }) => {
      if (!questions.length) return;
      const featured = [
        ...questions
          .filter((q) => !q.negative && q.difficulty === "basic")
          .slice(0, 2),
        ...questions
          .filter((q) => !q.negative && q.difficulty === "hard")
          .slice(0, 3),
        ...questions.filter((q) => q.negative).slice(0, 1),
      ];
      showExamples(
        featured.map((q) => ({
          question: q.question,
          difficulty: q.negative ? "Beyond the corpus" : q.category,
        })),
      );
      counts.textContent = `${questions.length} reference questions · ${questions.filter((q) => q.negative).length} negative cases`;
      for (const question of questions) {
        const row = el("article", "question-option");
        row.append(
          badge(question.difficulty),
          button(
            question.question,
            () => choose(question.question),
            "text-button",
          ),
          el("p", "muted small", question.whyHard),
        );
        library.append(row);
      }
      toggle.hidden = false;
    })
    .catch(() => {
      counts.textContent = "Example questions";
    });
  return {
    node,
    setBusy(busy: boolean) {
      stop.hidden = !busy;
      submitLabel.textContent = busy ? "Ask a new question" : "Ask a question";
      if (busy) node.classList.add("has-run");
    },
    reset() {
      node.classList.remove("has-run");
      input.value = "";
      input.setCustomValidity("");
      library.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
      toggle.textContent = "Explore all evaluation questions →";
    },
    focus() {
      input.focus();
    },
  };
}
