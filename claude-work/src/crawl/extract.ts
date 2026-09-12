// Pipeline: crawl → **extract** → dedup → index → facts → retrieve → answer → eval.
// Turns a fetched page into the row the rest of the system reasons about: title, body text,
// canonical URL, meta description, and — the part that actually matters — a publication date.
//
// Two decisions here reach all the way to the answer:
//  1. WHICH DATE. `published_at` drives the recency multiplier in ranking (REPORT §2.2), so
//     picking the wrong signal silently re-orders every answer about a moving number. The chain
//     is article:published_time → JSON-LD datePublished → <time datetime> inside the article →
//     the Last-Modified header, most explicit first. Sitemap `lastmod` is deliberately NOT in
//     that chain: the everstake.com domain migration re-stamped 156 old posts as 2026, which
//     would have promoted a 2019 post above a genuine 2026 one.
//  2. WHAT COUNTS AS TEXT. `<meta name=description>` is captured into its own column and never
//     merged into `text`, because that is exactly where the corpus's corrupted "735,,,,
//     delegators" lives. Keeping it out of `text` is what stops it reaching a chunk, an
//     embedding, and then an answer as a real figure.
//
// If this file is wrong the failure is quiet: the document still exists, still gets indexed, and
// simply carries a wrong date or a body full of navigation chrome.

import * as cheerio from "cheerio";
import { isoDateOnly } from "../util.js";

export interface Extracted {
  title: string;
  text: string;
  canonical: string | null;
  metaDescription: string | null;
  publishedAt: string | null;
  /** Which signal the date came from, stored so a suspicious date can be traced back. */
  dateSource: string | null;
  modifiedAt: string | null;
  lang: string | null;
}

/** A page shorter than this in <article>/<main> is a teaser or a shell, not the real content. */
const MIN_CONTENT_ROOT_CHARS = 300;

/**
 * Recurring legal/marketing blocks that appear on every page of a site and would otherwise be
 * indexed hundreds of times over, inflating the dedup similarity between unrelated pages and
 * wasting chunk budget. Each pattern is anchored on wording verified against the crawled corpus.
 */
const BOILERPLATE_PATTERNS: RegExp[] = [
  // The ~1000-char legal footer on every everstake.com page:
  //   "Everstake, Inc. … nothing in this material is guaranteed."
  // `[^]` is "any character including newlines" (`.` would stop at the first line break); the
  // lazy {0,1200} ceiling means a footer whose closing word never appears cannot eat the page.
  /Everstake, Inc\.?[^]{0,1200}?(guaranteed|advice|liab[a-z]+)[^.]*\./gi,
  // "Sign Up for Our Newsletter … you agree to our Privacy Notice."
  /Sign Up for Our Newsletter[^]{0,400}?Privacy Notice[^.]*\./gi,
  // "By submitting this form you consent to being contacted."
  /By submitting this form[^.]*\./gi,
  // "Cookie settings We use cookies to improve your experience." Greedy up to 200 chars, so it
  // runs to the last sentence end inside that window rather than the first.
  /Cookie[s]? (settings|policy|consent)[^.]{0,200}\./gi,
];

/** Chrome that is on the page but is not the page: navigation, banners, cookie and mail widgets. */
const NON_CONTENT_SELECTOR =
  "nav, header, footer, aside, [role='navigation'], [role='banner'], [role='contentinfo'], .cookie, .newsletter";

/** Elements that carry no readable prose, or whose text would be code rather than content. */
const NON_TEXT_SELECTOR =
  "script, style, noscript, svg, iframe, template, form, button, [aria-hidden='true'], [hidden]";

/** Block-level tags: a newline is appended so paragraphs do not fuse into one wall of text. */
const BLOCK_SELECTOR = "p, div, li, h1, h2, h3, h4, h5, h6, tr, br, section, blockquote, pre";

interface PublishedDate {
  publishedAt: string | null;
  dateSource: string | null;
}

/**
 * Parse an HTML page. `url` is part of the signature for symmetry with extractMarkdown (and for
 * callers that pass it positionally); nothing in the HTML path needs it today.
 *
 * Step order is load-bearing and is spelled out inline: the dates are read out of <head> before
 * the DOM is stripped, because JSON-LD lives in a <script> tag that the stripping removes.
 */
export function extractHtml(html: string, url: string, lastModifiedHeader: string | null): Extracted {
  const $ = cheerio.load(html);
  const metadata = readHeadMetadata($);
  const headDate = findDateInHead($);
  // KNOWN LIMITATION: `modifiedAt` prefers the article:modified_time tag while `publishedAt` can
  // fall back to the Last-Modified header below, so a page carrying only those two signals ends
  // up with a published date LATER than its modified date. Nothing downstream breaks (recency
  // reads published_at only), but the pair is inconsistent; extract.test.ts pins it as-is. The
  // fix would be to clamp published to modified when only the header supplied it.
  const modifiedAt =
    isoDateOnly($('meta[property="article:modified_time"]').attr("content")) ?? isoDateOnly(lastModifiedHeader);

  removeNonContentElements($);
  const root = chooseContentRoot($);

  // Only fall through to the in-page signals when <head> gave us nothing usable — including the
  // case where it gave us a date that isoDateOnly rejected (2013-era CMS template dates exist in
  // this corpus, and giving up on the date entirely would lose a perfectly good JSON-LD one).
  const published = headDate.publishedAt ? headDate : findDateInBody($, root, lastModifiedHeader);

  return {
    title: metadata.title,
    text: readableTextOf($, root),
    canonical: metadata.canonical,
    metaDescription: metadata.metaDescription,
    publishedAt: published.publishedAt,
    dateSource: published.dateSource,
    modifiedAt,
    lang: metadata.lang,
  };
}

/**
 * The <head> fields. og:title wins over <title> because it is the title the site chose for
 * sharing, without the "… | Everstake" suffix that <title> usually carries into every citation.
 */
function readHeadMetadata($: cheerio.CheerioAPI) {
  return {
    title: ($('meta[property="og:title"]').attr("content") || $("title").first().text() || "")
      .trim()
      .replace(/\s+/g, " "), // titles are often pretty-printed across lines in the source
    canonical: $('link[rel="canonical"]').attr("href")?.trim() || null,
    // Stored, never concatenated into `text` — this is where the corrupted "735,,,," lives.
    metaDescription: $('meta[name="description"]').attr("content")?.trim() || null,
    // "en-GB" → "en": the corpus only distinguishes languages, not regional variants.
    lang: $("html").attr("lang")?.slice(0, 2).toLowerCase() || null,
  };
}

/**
 * The two authoritative date signals, both of which live in <head> and both of which the page
 * author set deliberately: the Open Graph article tag first, then schema.org JSON-LD.
 *
 * MUST be called before removeNonContentElements — JSON-LD is a <script> tag and gets removed.
 */
function findDateInHead($: cheerio.CheerioAPI): PublishedDate {
  const articleTag = isoDateOnly($('meta[property="article:published_time"]').attr("content"));
  if (articleTag) return { publishedAt: articleTag, dateSource: "article:published_time" };

  for (const scriptTag of $('script[type="application/ld+json"]').toArray()) {
    try {
      const jsonLd = JSON.parse($(scriptTag).text());
      const published = isoDateOnly(findFirstStringByKey(jsonLd, "datePublished"));
      if (published) return { publishedAt: published, dateSource: "json-ld:datePublished" };
    } catch {
      // Hand-written JSON-LD is frequently invalid JSON (trailing commas, unescaped quotes).
      // One broken block must not cost us the valid block next to it, or the whole page.
    }
  }
  return { publishedAt: null, dateSource: null };
}

/**
 * The weaker signals, tried only when <head> had nothing.
 *
 * A `<time datetime>` inside the chosen content root is the byline date a human would read; it is
 * searched inside `root` rather than the whole document so a "latest posts" widget in the sidebar
 * cannot donate its date to this article. Last-Modified is last because it describes the file on
 * the server (a CSS change re-stamps it), not when the text was written — but for the undated
 * evergreen pages it is still better than nothing, and `dateSource` records how weak it is.
 */
function findDateInBody(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<any>,
  lastModifiedHeader: string | null,
): PublishedDate {
  const timeTag = isoDateOnly(root.find("time[datetime]").first().attr("datetime"));
  if (timeTag) return { publishedAt: timeTag, dateSource: "time[datetime]" };

  const headerDate = isoDateOnly(lastModifiedHeader);
  if (headerDate) return { publishedAt: headerDate, dateSource: "last-modified" };

  return { publishedAt: null, dateSource: null };
}

/** Strip everything that is on the page but is not the page, before any text is read. */
function removeNonContentElements($: cheerio.CheerioAPI) {
  $(NON_TEXT_SELECTOR).remove();
  // Blocks hidden with inline CSS: SEO copy, cookie banners and tab panels that a reader never
  // sees. Whitespace is squeezed out first so "display : none" is caught as well.
  $("[style]").each((_, element) => {
    const style = ($(element).attr("style") || "").replace(/\s/g, "");
    if (/display:none|visibility:hidden/.test(style)) $(element).remove();
  });
  $(NON_CONTENT_SELECTOR).remove();
}

/**
 * Narrow the page down to its content, preferring the most specific container that is actually
 * populated: <article> → <main> → <body>.
 *
 * The length check is what makes the fallback work. Listing pages ship an <article> per teaser,
 * so the first <article> can be a 40-character card; taking it would store the teaser instead of
 * the post. Anything under MIN_CONTENT_ROOT_CHARS is therefore treated as "not the content" and
 * we widen the search instead.
 */
function chooseContentRoot($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  const article = $("article").first();
  if (article.length && article.text().trim().length >= MIN_CONTENT_ROOT_CHARS) return article;
  const main = $("main").first();
  if (main.length && main.text().trim().length >= MIN_CONTENT_ROOT_CHARS) return main;
  return $("body");
}

/**
 * Flatten the chosen root to prose. Cheerio's `.text()` concatenates without any separator, so
 * "Heading" + "First paragraph" would arrive as "HeadingFirst paragraph" — which then becomes one
 * unsplittable sentence for the chunker and one nonsense token for BM25. Appending separators to
 * the block elements first is what preserves the paragraph and table structure.
 */
function readableTextOf($: cheerio.CheerioAPI, root: cheerio.Cheerio<any>): string {
  root.find(BLOCK_SELECTOR).each((_, element) => {
    $(element).append("\n");
  });
  // Table cells keep a visible column separator so a row still reads as a row: "a | b |".
  root.find("td, th").each((_, element) => {
    $(element).append(" | ");
  });

  let text = cleanText(root.text());
  for (const pattern of BOILERPLATE_PATTERNS) text = text.replace(pattern, " ");
  // Cleaned twice on purpose: cutting a boilerplate block leaves behind the spaces and blank
  // lines that surrounded it.
  return cleanText(text);
}

/**
 * Markdown needs almost none of the above: docs.everstake.com serves its pages as Markdown, so
 * there is no chrome to strip and no date to hunt for (the docs carry none — a null date is
 * correct, and ranking handles it with the `undated_recency` multiplier).
 */
export function extractMarkdown(md: string, url: string): Extracted {
  // "# Everstake Docs" → "Everstake Docs"; a file with no h1 is titled by its URL.
  const title = md.match(/^#\s+(.+)$/m)?.[1]?.trim() || url;
  const text = cleanText(
    md
      // Keep the code inside a fenced block but drop the fences, so a snippet stays searchable
      // without ``` turning up as a token.
      .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""))
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images: "![diagram](a.png)" → nothing to read
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links: "[the docs](https://…)" → "the docs"
      .replace(/^#+\s*/gm, ""), // heading markers: "## Sub" → "Sub"
  );
  return {
    title,
    text,
    canonical: null,
    metaDescription: null,
    publishedAt: null,
    dateSource: null,
    modifiedAt: null,
    lang: "en", // the Markdown sources in this corpus are English-only docs and READMEs
  };
}

/**
 * Normalise whitespace. Exported because the chunker and the fact extractor must see exactly the
 * same normalisation as the crawler did, or a quote will not match the text it was taken from.
 */
export function cleanText(text: string): string {
  return text
    .replace(/ /g, " ") // &nbsp; — invisible here, but it breaks word matching and search
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n") // trim each line without touching the line breaks themselves
    .replace(/\n{3,}/g, "\n\n") // at most one blank line, so paragraph breaks stay meaningful
    .trim();
}

/**
 * First string value stored under `key`, at any depth. JSON-LD has no fixed shape — the same
 * field turns up at the top level, inside an "@graph" array, or nested in a "mainEntity" — so a
 * depth-first search is more robust than pinning any one path. First match wins.
 */
function findFirstStringByKey(node: any, key: string): string | undefined {
  if (!node || typeof node !== "object") return undefined;
  if (typeof node[key] === "string") return node[key];
  for (const value of Object.values(node)) {
    const found = findFirstStringByKey(value, key);
    if (found) return found;
  }
  return undefined;
}

/**
 * Numbers whose thousands separators are corrupted, e.g. "735,,,," or "1,6,00". The corpus
 * contains a planted one ("735,,,, delegators") and the answer gate uses this to refuse to state
 * a figure it cannot parse — quoting "735" from "735,,,," would invent a number nobody published.
 *
 * The pattern is 1-3 leading digits followed by one of three broken separators:
 *   • `,{2,}`               doubled commas       — "735,,,,"
 *   • `,\d{1,2}(?![\d,])`   a short final group  — "12,34", and the "6,00" inside "1,6,00"
 *   • `,\d{3}(?:,{2,})`     a valid group then doubled commas — "1,234,,,"
 * The trailing `[\d,]*` swallows the rest of the run so the whole corrupted token is reported.
 * The negative lookahead is what keeps a well-formed "1,600,000" out of the results: its "600"
 * is followed by a comma, so the short-group alternative refuses to match.
 */
export function malformedNumbers(text: string): string[] {
  return [...text.matchAll(/\b\d{1,3}(?:,{2,}|,\d{1,2}(?![\d,])|,\d{3}(?:,{2,}))[\d,]*/g)].map((match) => match[0]);
}
