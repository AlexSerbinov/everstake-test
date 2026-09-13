import { badge, button, el, empty } from "../../shared/dom.js";
import { localizedFindings, type FindingsLanguage } from "./catalog.js";
import { renderDocument } from "./document.js";

export function findingsPage(id?: string): HTMLElement {
  const root = el("div");
  let language: FindingsLanguage = "en";
  try {
    if (localStorage.getItem("findings-language") === "uk") language = "uk";
  } catch {
    /* Storage may be unavailable. */
  }
  function render(focusLanguage?: FindingsLanguage) {
    const controls = el("div", "answer-meta");
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Findings language / Мова розділу");
    for (const [value, label] of [
      ["en", "English"],
      ["uk", "Українська"],
    ] as const) {
      const control = button(label, () => {
        language = value;
        try {
          localStorage.setItem("findings-language", value);
        } catch {
          /* Keep the selection in memory. */
        }
        render(value);
      });
      control.lang = value;
      control.className = `button ${language === value ? "primary" : "secondary"}`;
      control.setAttribute("aria-pressed", String(language === value));
      controls.append(control);
    }
    const page = renderFindings(id, language);
    page.prepend(controls);
    root.replaceChildren(page);
    if (focusLanguage)
      controls
        .querySelector<HTMLButtonElement>(`[lang="${focusLanguage}"]`)
        ?.focus();
  }
  render();
  return root;
}

function renderFindings(
  id: string | undefined,
  language: FindingsLanguage,
): HTMLElement {
  const t = (en: string, uk: string) => (language === "en" ? en : uk);
  const findings = localizedFindings(language);
  const page = el("section", "explore-page findings-page");
  page.lang = language;
  if (id) {
    const back = el("a", "finding-back", t("← All findings", "← Усі знахідки"));
    back.href = "#findings";
    page.append(back);
    const finding = findings.find((finding) => finding.id === id);
    if (!finding) {
      page.append(
        empty(
          t("Document not found", "Документ не знайдено"),
          t(
            "Choose a document from the findings collection.",
            "Оберіть документ у розділі знахідок.",
          ),
        ),
      );
      return page;
    }
    const meta = el("div", "answer-meta");
    meta.append(badge(finding.category), badge(finding.status, "warning"));
    const download = el(
      "a",
      "button secondary",
      t("Download document ↓", "Завантажити документ ↓"),
    );
    const documentPath = `/findings/${language === "en" ? "en/" : ""}${finding.id}.md`;
    download.href = documentPath;
    download.download = `${finding.id}.${language}.md`;
    const content = el("div");
    content.setAttribute("aria-live", "polite");
    page.append(meta, content, download);
    async function load() {
      content.replaceChildren(
        el("p", "muted", t("Loading document…", "Завантажуємо документ…")),
      );
      try {
        const response = await fetch(documentPath);
        if (!response.ok)
          throw new Error(`Document request failed (${response.status}).`);
        content.replaceChildren(renderDocument(await response.text()));
      } catch (error) {
        content.replaceChildren(
          empty(
            t("Document unavailable", "Документ недоступний"),
            t(
              "Could not load the document. Please try again.",
              "Не вдалося завантажити документ. Спробуйте ще раз.",
            ),
          ),
          button(t("Try again", "Спробувати ще раз"), () => void load()),
        );
      }
    }
    void load();
    return page;
  }
  page.append(
    el(
      "p",
      "eyebrow",
      t("WHAT WE FOUND IN THE SOURCES", "ЩО МИ ЗНАЙШЛИ В ДЖЕРЕЛАХ"),
    ),
    el(
      "h1",
      "",
      t("Findings in the knowledge corpus.", "Знахідки в корпусі знань."),
    ),
    el(
      "p",
      "lede",
      t(
        "Issues not explicitly named in the assignment: conflicting wording, evidence gaps and their impact on client decisions.",
        "Проблеми, які не були прямо названі в тестовому завданні: суперечності у формулюваннях, прогалини в доказах та їхній вплив на рішення клієнтів.",
      ),
    ),
  );
  const intro = el("div", "findings-intro");
  intro.append(
    el(
      "strong",
      "",
      t(
        `${findings.length} documents · Reviewed September 13, 2026`,
        `${findings.length} документи · Перевірено 13 вересня 2026 року`,
      ),
    ),
    el(
      "p",
      "muted",
      t(
        "Each document covers the issue, sources, a practical example and a proposed response. Statuses describe the finding; source corrections and follow-up checks are still pending.",
        "У кожному документі — суть проблеми, джерела, практичний приклад і план виправлення. Статуси описують знахідку; виправлення джерел і повторні перевірки ще попереду.",
      ),
    ),
  );
  page.append(intro);
  const list = el("div", "findings-grid");
  for (const [index, finding] of findings.entries()) {
    const card = el("a", "document-card finding-card");
    card.href = `#findings/${finding.id}`;
    const meta = el("div", "answer-meta");
    meta.append(
      el(
        "span",
        "eyebrow",
        `${t("DOCUMENT", "ДОКУМЕНТ")} ${String(index + 1).padStart(2, "0")}`,
      ),
      badge(finding.status, "warning"),
    );
    card.append(
      meta,
      el("h2", "", finding.title),
      el("p", "muted", finding.summary),
      el("span", "finding-open", t("Read document →", "Читати документ →")),
    );
    list.append(card);
  }
  page.append(list);
  return page;
}
