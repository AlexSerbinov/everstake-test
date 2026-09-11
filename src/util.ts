import crypto from "node:crypto";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

/** Lower-case, collapse whitespace, strip punctuation — for hashing and shingling. */
export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

/** Cheap token estimate (chars / 4) — used only for chunk sizing, real usage comes from the API. */
export const estTokens = (s: string) => Math.ceil(s.length / 4);

export function isoDateOnly(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  if (y < 2015 || y > 2030) return null;
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

/** Split into sentences well enough for instruction detection. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z"“(\[])/).map((s) => s.trim()).filter(Boolean);
}

export function pick<T>(arr: T[], n: number): T[] {
  return arr.slice(0, n);
}

export function fmtUsd(x: number) {
  return x < 0.01 ? `$${x.toFixed(5)}` : `$${x.toFixed(3)}`;
}
