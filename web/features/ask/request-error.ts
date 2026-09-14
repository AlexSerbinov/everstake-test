import { el } from "../../shared/dom.js";
export function requestError(message: string): HTMLElement {
  const node = el("div", "error-panel");
  node.setAttribute("role", "alert");
  node.append(
    el("h3", "", "The request could not finish"),
    el("p", "", message),
    el(
      "p",
      "muted small",
      "This is a request failure. It does not mean the corpus has no reliable answer. Charges from calls already started may still apply.",
    ),
  );
  return node;
}
