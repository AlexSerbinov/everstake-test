export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function button(
  text: string,
  action: () => void,
  className = "button secondary",
): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}
export function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
export function link(text: string, value: string): HTMLElement {
  const url = safeUrl(value);
  if (!url) return el("span", "muted", text);
  const node = el("a", "", text);
  node.href = url;
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  return node;
}
export function details(
  title: string,
  ...children: Node[]
): HTMLDetailsElement {
  const node = el("details", "disclosure");
  node.append(el("summary", "", title), ...children);
  return node;
}
export function badge(text: string, kind = ""): HTMLElement {
  return el("span", `badge ${kind}`, text);
}
export function empty(title: string, message: string): HTMLElement {
  const box = el("div", "empty-state");
  box.append(el("h3", "", title), el("p", "muted", message));
  return box;
}
export async function getJson<T>(
  path: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok)
    throw new Error(
      `Could not load this view (${response.status}). Please try again.`,
    );
  return response.json() as Promise<T>;
}
export function money(value: number): string {
  return `$${value.toFixed(value > 1 ? 2 : 5)}`;
}
export function metric(
  label: string,
  value: string,
  note?: string,
): HTMLElement {
  const node = el("div", "metric");
  node.append(el("span", "eyebrow", label), el("strong", "", value));
  if (note) node.append(el("small", "muted", note));
  return node;
}
