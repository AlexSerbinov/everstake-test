// Pipeline: crawl. Every HTTP request the crawler makes goes through here — seed URLs, sitemaps,
// llms.txt, and the agent's live-page tool (src/ask/tools.ts). It is the politeness layer: robots
// is consulted first, requests to one host are spaced out, redirects are followed by hand so the
// chain is recorded, and transient failures are retried.
//
// Why our own user agent (`crawl.user_agent` in config/kb.yaml) instead of impersonating
// ClaudeBot or GPTBot: everstake.com/robots.txt carries two contradictory rule sets for those
// well-known bots — a Cloudflare-managed block that disallows them and the site's own block that
// allows them — while the `*` rules are unambiguous (REPORT §2.1). Borrowing another crawler's
// name would mean picking whichever of two contradictory permissions suited us, under a name
// that is not ours. We identify as ourselves, with a contact URL, and take the `*` rules.
//
// What breaks if this file is wrong: robots skipped → a politeness incident; the delay dropped →
// we look like a scraper and get 403'd; the redirect chain not recorded → the URL-level dedup
// loses the evidence that everstake.one and everstake.com are the same page.

import { getConfig } from "../config.js";
import { addStageBytes } from "../metrics.js";
import { sleep } from "../util.js";
import { isAllowed, robotsFor } from "./robots.js";

export interface FetchResult {
  ok: boolean;
  /** HTTP status of the final response, or 0 when no response was obtained at all. */
  status: number;
  /** The URL actually fetched after redirects — the key the document is stored under. */
  finalUrl: string;
  /** Every redirect hop, in order. Written to the `redirects` table as dedup evidence. */
  chain: { from: string; to: string; status: number }[];
  body: string;
  contentType: string;
  lastModified: string | null;
  bytes: number;
  error?: string;
  /** Present only when robots.txt refused this URL; the crawler records that as the drop reason. */
  disallowed?: boolean;
}

/** Host → timestamp of the last request we started, used to space out consecutive hits. */
const lastHitAt = new Map<string, number>();

/** Statuses that carry a Location header we should follow. 300 and 304 do not, so they fall
 *  through and are handled as ordinary final responses. */
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];

/** Cap on redirect hops per URL: without it a redirect loop never returns. Hand-tuned — the real
 *  chains here (the everstake.one → everstake.com migration) are far shorter. */
const MAX_REDIRECT_HOPS = 6;

/** Linear backoff base after the origin returned 5xx/429. Hand-tuned; no measurement backs it. */
const SERVER_ERROR_BACKOFF_MS = 1500;

/** Linear backoff base after the request itself threw (DNS, TLS, timeout). Hand-tuned likewise. */
const NETWORK_ERROR_BACKOFF_MS = 1000;

/**
 * Fetch one URL politely and return the outcome instead of throwing — the crawler stores a row
 * for a failed URL too, so "why is this page missing?" is always answerable from the database.
 *
 * `skipRobots` exists for the one case where robots was already checked by the caller
 * (src/ask/tools.ts checks it against its own allow-list first); it never means "ignore robots".
 */
export async function politeFetch(url: string, opts: { skipRobots?: boolean } = {}): Promise<FetchResult> {
  const config = getConfig().crawl;
  const chain: FetchResult["chain"] = [];
  let current = url;

  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const host = new URL(current).host;
    if (!opts.skipRobots) {
      // Re-checked at every hop: a redirect can land on a different host, or on a path the same
      // host disallows, and following it blindly would be a request we were told not to make.
      const rules = await robotsFor(current);
      if (!isAllowed(rules, current)) {
        const error = "disallowed by robots.txt";
        return failedFetch({ status: 0, finalUrl: current, chain, error, disallowed: true });
      }
      // The site's own Crawl-delay wins whenever it is slower than ours; never faster.
      await waitOutPolitenessDelay(host, Math.max(config.delay_ms, rules.crawlDelayMs ?? 0));
    }
    // Stamped before the request, not after, so the delay is measured start-to-start: a slow page
    // does not earn the next one an extra pause on top of its own latency.
    lastHitAt.set(host, Date.now());

    const { response, error } = await requestWithRetries(current, config);
    if (!response) return failedFetch({ status: 0, finalUrl: current, chain, error });

    if (REDIRECT_STATUSES.includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) {
        // A 3xx with no Location is a broken server; there is nowhere to go, so stop here.
        const error = "redirect without location";
        return failedFetch({ status: response.status, finalUrl: current, chain, error });
      }
      const next = new URL(location, current).toString(); // Location may be relative ("/en/about")
      chain.push({ from: current, to: next, status: response.status });
      current = next;
      continue;
    }

    const body = await response.text();
    // Counted here rather than in the crawler so that every HTTP byte the process pulls down —
    // pages, sitemaps, robots.txt, the agent's live-page fetches — lands in the stage's
    // `bytes_in`, not just the ones that became documents. No-op outside a measured stage.
    addStageBytes(Buffer.byteLength(body));
    return {
      ok: response.ok,
      status: response.status,
      finalUrl: current,
      chain,
      body,
      contentType: response.headers.get("content-type") ?? "",
      lastModified: response.headers.get("last-modified"),
      bytes: Buffer.byteLength(body), // byte length, not string length: the report counts bytes
      error: response.ok ? undefined : `http ${response.status}`,
    };
  }
  return failedFetch({ status: 0, finalUrl: current, chain, error: "too many redirects" });
}

/** Wait until this host's quiet period has elapsed. Nothing to wait for on the first hit. */
async function waitOutPolitenessDelay(host: string, delayMs: number) {
  const waitMs = (lastHitAt.get(host) ?? 0) + delayMs - Date.now();
  if (waitMs > 0) await sleep(waitMs);
}

/**
 * One request, plus up to `config.retries` further attempts. Only the two failures that are usually
 * temporary are retried: a 5xx/429 from the origin (overloaded or rate-limiting us) and a thrown
 * request (DNS, TLS, timeout). Any other 4xx is the server's final answer and is handed back
 * as-is, for the crawler to record as a drop reason.
 *
 * Backoff is linear rather than exponential because the attempt count is tiny — with the default
 * two retries the whole difference is a few seconds — and a linear series is easier to recognise
 * in the crawl log.
 *
 * Returns `{ response: null, error }` when every attempt failed; `error` then holds the last one.
 */
async function requestWithRetries(
  url: string,
  config: ReturnType<typeof getConfig>["crawl"],
): Promise<{ response: Response | null; error: string }> {
  let error = "";
  for (let attempt = 0; attempt <= config.retries; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "manual", // we follow redirects ourselves so the chain can be recorded
        headers: {
          "User-Agent": config.user_agent,
          // text/markdown is listed because docs.everstake.com serves its pages as Markdown.
          Accept: "text/html,application/xhtml+xml,text/plain,text/markdown,application/xml;q=0.9,*/*;q=0.5",
          "Accept-Encoding": "gzip, br",
          "Accept-Language": "en", // ask for the English variant of any localised page
        },
        signal: AbortSignal.timeout(config.timeout_ms),
      });
      if (response.status >= 500 || response.status === 429) {
        error = `http ${response.status}`;
        await sleep(SERVER_ERROR_BACKOFF_MS * (attempt + 1));
        continue;
      }
      return { response, error };
    } catch (thrown: any) {
      error = String(thrown?.message ?? thrown);
      await sleep(NETWORK_ERROR_BACKOFF_MS * (attempt + 1));
    }
  }
  return { response: null, error };
}

/**
 * The empty shell every failure path returns, so a caller only ever has to check `ok` before
 * reading `body`. `disallowed` is added only when true — its absence is what tells the crawler
 * the failure was technical rather than a permission refusal.
 */
function failedFetch(args: {
  status: number;
  finalUrl: string;
  chain: FetchResult["chain"];
  error: string;
  disallowed?: boolean;
}): FetchResult {
  const result: FetchResult = {
    ok: false,
    status: args.status,
    finalUrl: args.finalUrl,
    chain: args.chain,
    body: "",
    contentType: "",
    lastModified: null,
    bytes: 0,
    error: args.error,
  };
  if (args.disallowed) result.disallowed = true;
  return result;
}
