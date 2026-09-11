// HTML → {title, text, canonical, metaDescription, publishedAt, dateSource, lang}.
// Rules learned from the corpus survey:
//   • prefer <article>/<main>, drop nav/header/footer/scripts and display:none blocks
//   • cut the ~1000-char "Everstake, Inc." legal footer that lives on every everstake.com page
//   • dates: article:published_time → JSON-LD datePublished → <time datetime> inside the article
//     → Last-Modified. Sitemap lastmod is NOT a publish date (domain migration re-stamped old posts).
//   • <meta name=description> is stored separately and never mixed into `text`
//     (that is where the corrupted "735,,,, delegators" lives).

import * as cheerio from "cheerio";
import { isoDateOnly } from "../util.js";

export interface Extracted {
  title: string;
  text: string;
  canonical: string | null;
  metaDescription: string | null;
  publishedAt: string | null;
  dateSource: string | null;
  modifiedAt: string | null;
  lang: string | null;
}

const BOILERPLATE_PATTERNS: RegExp[] = [
  /Everstake, Inc\.?[^]{0,1200}?(guaranteed|advice|liab[a-z]+)[^.]*\./gi,       // legal disclaimer block
  /Sign Up for Our Newsletter[^]{0,400}?Privacy Notice[^.]*\./gi,
  /By submitting this form[^.]*\./gi,
  /Cookie[s]? (settings|policy|consent)[^.]{0,200}\./gi,
];

export function extractHtml(html: string, url: string, lastModifiedHeader: string | null): Extracted {
  const $ = cheerio.load(html);

  const title = ($('meta[property="og:title"]').attr("content") || $("title").first().text() || "").trim().replace(/\s+/g, " ");
  const canonical = $('link[rel="canonical"]').attr("href")?.trim() || null;
  const metaDescription = $('meta[name="description"]').attr("content")?.trim() || null;
  const lang = $("html").attr("lang")?.slice(0, 2).toLowerCase() || null;

  // --- dates ---------------------------------------------------------------
  let publishedAt: string | null = null, dateSource: string | null = null;
  const pt = $('meta[property="article:published_time"]').attr("content");
  if (isoDateOnly(pt)) { publishedAt = isoDateOnly(pt); dateSource = "article:published_time"; }
  if (!publishedAt) {
    for (const el of $('script[type="application/ld+json"]').toArray()) {
      try {
        const j = JSON.parse($(el).text());
        const d = findKey(j, "datePublished");
        if (isoDateOnly(d)) { publishedAt = isoDateOnly(d); dateSource = "json-ld:datePublished"; break; }
      } catch { /* ignore broken JSON-LD */ }
    }
  }
  const modifiedAt = isoDateOnly($('meta[property="article:modified_time"]').attr("content")) ?? isoDateOnly(lastModifiedHeader);

  // --- main content --------------------------------------------------------
  $("script, style, noscript, svg, iframe, template, form, button, [aria-hidden='true'], [hidden]").remove();
  $("[style]").each((_, el) => { const s = ($(el).attr("style") || "").replace(/\s/g, ""); if (/display:none|visibility:hidden/.test(s)) $(el).remove(); });
  $("nav, header, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo'], .cookie, .newsletter").remove();

  let root = $("article").first();
  if (!root.length || root.text().trim().length < 300) root = $("main").first();
  if (!root.length || root.text().trim().length < 300) root = $("body");

  if (!publishedAt) {
    const t = root.find("time[datetime]").first().attr("datetime");
    if (isoDateOnly(t)) { publishedAt = isoDateOnly(t); dateSource = "time[datetime]"; }
  }
  if (!publishedAt && lastModifiedHeader && isoDateOnly(lastModifiedHeader)) { publishedAt = isoDateOnly(lastModifiedHeader); dateSource = "last-modified"; }

  // block-level elements → newlines so paragraphs survive
  root.find("p, div, li, h1, h2, h3, h4, h5, h6, tr, br, section, blockquote, pre").each((_, el) => { $(el).append("\n"); });
  root.find("td, th").each((_, el) => { $(el).append(" | "); });
  let text = root.text();
  text = cleanText(text);
  for (const re of BOILERPLATE_PATTERNS) text = text.replace(re, " ");
  text = cleanText(text);

  return { title, text, canonical, metaDescription, publishedAt, dateSource, modifiedAt, lang };
}

export function extractMarkdown(md: string, url: string): Extracted {
  const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim() || url;
  const text = cleanText(md.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "")).replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/^#+\s*/gm, ""));
  return { title, text, canonical: null, metaDescription: null, publishedAt: null, dateSource: null, modifiedAt: null, lang: "en" };
}

export function cleanText(t: string): string {
  return t
    .replace(/ /g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findKey(obj: any, key: string): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  if (typeof obj[key] === "string") return obj[key];
  for (const v of Object.values(obj)) { const r = findKey(v, key); if (r) return r; }
  return undefined;
}

/** Numbers like "735,,,," or "1,6,00" are malformed — the corpus contains one on purpose. */
export function malformedNumbers(text: string): string[] {
  return [...text.matchAll(/\b\d{1,3}(?:,{2,}|,\d{1,2}(?![\d,])|,\d{3}(?:,{2,}))[\d,]*/g)].map((m) => m[0]);
}
