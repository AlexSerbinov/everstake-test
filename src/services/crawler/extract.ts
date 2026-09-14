import { createHash } from "node:crypto";
import { load, type CheerioAPI, type Cheerio } from "cheerio";
import type { Element } from "domhandler";
import type { DocumentSnapshot, SourceConfig } from "../../contracts.js";
import type { SafeFetchResult } from "./fetch.js";

export const EXTRACTION_VERSION = "html-markdown-v1";

export interface ExtractedDocument extends DocumentSnapshot {
  links: string[];
}

interface ExtractedContent {
  title: string;
  canonicalUrl: string;
  text: string;
  links: string[];
  publishedAt: string | null;
  updatedAt: string | null;
  dateEvidence: string | null;
  metadata: Record<string, unknown>;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

function parseDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function firstValidDate(values: Array<{ value: unknown; evidence: string }>): {
  date: string | null;
  evidence: string | null;
} {
  for (const item of values) {
    const parsed = parseDate(item.value);
    if (parsed) return { date: parsed, evidence: item.evidence };
  }
  return { date: null, evidence: null };
}

function readStructuredDates(jsonValues: string[]): {
  published: unknown[];
  updated: unknown[];
} {
  const published: unknown[] = [];
  const updated: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    published.push(record.datePublished, record.uploadDate);
    updated.push(record.dateModified);
    if (record["@graph"]) visit(record["@graph"]);
  };
  for (const raw of jsonValues) {
    try {
      visit(JSON.parse(raw));
    } catch {
      /* Malformed page metadata is ignored. */
    }
  }
  return { published, updated };
}

function cleanLines(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter(
      (line, index, lines) => line.length > 0 && line !== lines[index - 1],
    )
    .join("\n")
    .trim();
}

function readPageDates(
  $: CheerioAPI,
  jsonDates: ReturnType<typeof readStructuredDates>,
) {
  // Prefer explicit article metadata, then structured data. Fetch time is not a page date.
  const publishedCandidates: Array<{ value: unknown; evidence: string }> = [
    {
      value: $('meta[property="article:published_time"]').attr("content"),
      evidence: "meta:article:published_time",
    },
    { value: $('meta[name="date"]').attr("content"), evidence: "meta:date" },
    {
      value: $('[itemprop="datePublished"]').first().attr("datetime"),
      evidence: "itemprop:datePublished",
    },
    ...jsonDates.published.map((value) => ({
      value,
      evidence: "jsonld:datePublished",
    })),
  ];
  const updatedCandidates: Array<{ value: unknown; evidence: string }> = [
    {
      value: $('meta[property="article:modified_time"]').attr("content"),
      evidence: "meta:article:modified_time",
    },
    {
      value: $('meta[name="last-modified"]').attr("content"),
      evidence: "meta:last-modified",
    },
    {
      value: $('[itemprop="dateModified"]').first().attr("datetime"),
      evidence: "itemprop:dateModified",
    },
    ...jsonDates.updated.map((value) => ({
      value,
      evidence: "jsonld:dateModified",
    })),
  ];
  const published = firstValidDate(publishedCandidates);
  const updated = firstValidDate(updatedCandidates);
  return { published, updated };
}

function preserveTextStructure(
  $: CheerioAPI,
  root: Cheerio<Element>,
  pageUrl: string,
): void {
  // Plain text loses HTML layout. Keep link targets, table columns and section boundaries readable.
  root.find("a[href]").each((_, node) => {
    const element = $(node);
    const label = element.text().trim();
    const href = element.attr("href");
    if (
      label &&
      href &&
      !href.startsWith("#") &&
      !href.toLowerCase().startsWith("javascript:")
    ) {
      try {
        element.text(`${label} (${new URL(href, pageUrl).href})`);
      } catch {
        /* Leave invalid links as visible text. */
      }
    }
  });
  root.find("table").each((_, node) => {
    const rows = $(node)
      .find("tr")
      .map((_rowIndex, row) =>
        $(row)
          .find("th,td")
          .map((_cellIndex, cell) => $(cell).text().replace(/\s+/g, " ").trim())
          .get()
          .join(" | "),
      )
      .get();
    $(node).replaceWith(`\n${rows.join("\n")}\n`);
  });
  root.find("h1,h2,h3,h4,h5,h6").each((_, node) => {
    const level = Number((node as Element).tagName.slice(1));
    $(node)
      .prepend(`\n${"#".repeat(level)} `)
      .append("\n");
  });
  root.find("li").each((_, node) => {
    $(node).prepend("\n- ").append("\n");
  });
  root.find("p,blockquote,pre,dt,dd").each((_, node) => {
    $(node).append("\n");
  });
  root.find("br").replaceWith("\n");
}

function extractHtml(response: SafeFetchResult): ExtractedContent {
  const $ = load(response.body.toString("utf8"));
  $(
    'script:not([type="application/ld+json"]),style,noscript,template,svg,nav,footer,form,[aria-hidden="true"],.cookie,.cookies,.newsletter,.advertisement',
  ).remove();
  // Text a visitor cannot see is a classic carrier for planted directives. Inline styles and
  // the common screen-reader-only classes are removed; a stylesheet rule cannot be resolved
  // here, so hidden text declared only in external CSS still reaches the sanitizer.
  $(
    '[hidden],.sr-only,.visually-hidden,.screen-reader-text,.screen-reader-only,[style*="display:none"],[style*="display: none"],[style*="visibility:hidden"],[style*="visibility: hidden"],[style*="font-size:0"],[style*="font-size: 0"],[style*="opacity:0"],[style*="opacity: 0"]',
  ).remove();
  const jsonDates = readStructuredDates(
    $('script[type="application/ld+json"]')
      .map((_, node) => $(node).text())
      .get(),
  );
  $("script").remove();
  const canonicalHref = $('link[rel="canonical"]').first().attr("href");
  let canonicalUrl = normalizeUrl(response.url);
  try {
    const candidate = new URL(canonicalHref ?? response.url, response.url);
    if (["http:", "https:"].includes(candidate.protocol))
      canonicalUrl = normalizeUrl(candidate.href);
  } catch {
    /* Keep the fetched URL when page metadata is malformed. */
  }
  const { published, updated } = readPageDates($, jsonDates);
  const publishedAt = published.date;
  const updatedAt = updated.date;
  const dateEvidence = published.evidence ?? updated.evidence;

  const root = $("article").first().length
    ? $("article").first()
    : $("main").first().length
      ? $("main").first()
      : $("body").first();
  const coverageWarnings: string[] = [];
  const headingTitle = root.find("h1").first().text();
  root.find("img").each((_, node) => {
    const element = $(node);
    const src = element.attr("src");
    const alt = element.attr("alt")?.trim();
    if (src && !alt)
      coverageWarnings.push(
        `Image content not extracted: ${new URL(src, response.url).href}`,
      );
  });
  preserveTextStructure($, root, response.url);
  const links = [
    ...new Set(
      root
        .find("a[href]")
        .map((_, node) => {
          try {
            const url = new URL($(node).attr("href")!, response.url);
            return ["http:", "https:"].includes(url.protocol)
              ? normalizeUrl(url.href)
              : "";
          } catch {
            return "";
          }
        })
        .get()
        .filter(Boolean),
    ),
  ];
  const title = (
    $('meta[property="og:title"]').attr("content") ||
    $("title").first().text() ||
    headingTitle ||
    canonicalUrl
  )
    .replace(/\s+/g, " ")
    .trim();
  return {
    title,
    canonicalUrl,
    text: cleanLines(root.text()),
    links,
    publishedAt,
    updatedAt,
    dateEvidence,
    metadata: {
      coverageWarnings,
      dateProvenance: {
        publishedAt: published.evidence,
        updatedAt: updated.evidence,
      },
    },
  };
}

function extractMarkdown(response: SafeFetchResult): ExtractedContent {
  const raw = response.body.toString("utf8").replace(/\r/g, "");
  const frontmatter = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const date = frontmatter?.[1].match(
    /^(?:date|published|datePublished):\s*["']?([^\n"']+)/im,
  )?.[1];
  const updated = frontmatter?.[1].match(
    /^(?:updated|modified|dateModified):\s*["']?([^\n"']+)/im,
  )?.[1];
  const publishedAt = parseDate(date);
  const updatedAt = parseDate(updated);
  const text = cleanLines(frontmatter ? raw.slice(frontmatter[0].length) : raw);
  const title =
    text.match(/^#\s+(.+)$/m)?.[1]?.trim() ??
    new URL(response.url).pathname.split("/").pop() ??
    response.url;
  const links = [
    ...new Set(
      [...raw.matchAll(/\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g)].map((match) =>
        normalizeUrl(match[1]!),
      ),
    ),
  ];
  return {
    title,
    canonicalUrl: normalizeUrl(response.url),
    text,
    links,
    publishedAt,
    updatedAt,
    dateEvidence: publishedAt
      ? "frontmatter:published"
      : updatedAt
        ? "frontmatter:modified"
        : null,
    metadata: { coverageWarnings: [] },
  };
}

export function extractDocument(
  response: SafeFetchResult,
  source: SourceConfig,
): ExtractedDocument {
  const contentType =
    response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
  const markdown =
    contentType.includes("markdown") ||
    /\.(md|mdx)$/i.test(new URL(response.url).pathname);
  if (
    !markdown &&
    !contentType.includes("html") &&
    contentType !== "text/plain" &&
    contentType !== ""
  ) {
    throw new Error(`unsupported_format:${contentType}`);
  }
  const extracted = markdown
    ? extractMarkdown(response)
    : extractHtml(response);
  // This snapshot describes extraction. The crawler sanitizes its text and recomputes these IDs.
  const contentHash = sha256(extracted.text);
  const id = sha256(`${extracted.canonicalUrl}\n${contentHash}`).slice(0, 32);
  return {
    id,
    url: normalizeUrl(response.initialUrl),
    canonicalUrl: extracted.canonicalUrl,
    title: extracted.title,
    publisher: source.publisher,
    authority: source.authority,
    kind: source.kind,
    text: extracted.text,
    contentHash,
    fetchedAt: response.fetchedAt,
    publishedAt: plausibleDate(extracted.publishedAt, response.fetchedAt),
    updatedAt: plausibleDate(extracted.updatedAt, response.fetchedAt),
    dateEvidence: extracted.dateEvidence,
    duplicateOf: null,
    revision: contentHash.slice(0, 12),
    metadata: {
      ...extracted.metadata,
      sourceId: source.id,
      initialUrl: response.initialUrl,
      finalUrl: response.url,
      redirectChain: response.redirectChain,
      status: response.status,
      contentType,
      etag: response.headers.etag ?? null,
      lastModified: response.headers["last-modified"] ?? null,
      bytes: response.bytes,
      rawHash: sha256(response.body),
      extractionVersion: EXTRACTION_VERSION,
    },
    links: extracted.links,
  };
}

export function plausibleDate(
  value: string | null,
  fetchedAt: string,
): string | null {
  if (!value) return null;
  // Allow one day for timezone differences; farther-future metadata cannot date our evidence.
  return Date.parse(value) <= Date.parse(fetchedAt) + 86400000 ? value : null;
}
