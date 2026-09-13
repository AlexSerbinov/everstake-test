import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { isIP } from 'node:net';
import robotsParser from 'robots-parser';

const parseRobots = robotsParser as unknown as (url: string, text: string) => {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getSitemaps(): string[];
};

export const CRAWLER_USER_AGENT = 'EverstateKnowledgeCrawler/1.0 (+https://everstake.com)';

export interface FetchResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export interface FetchTransportOptions {
  timeoutMs: number;
  maxBytes: number;
  headers: Record<string, string>;
}

export type FetchTransport = (url: URL, options: FetchTransportOptions) => Promise<FetchResponse>;
export type ResolveHost = (hostname: string) => Promise<string[]>;
export interface RateLimitState { tails: Map<string, Promise<void>>; lastStartedAt: Map<string, number>; }

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  retryDelayMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  transport?: FetchTransport;
  resolveHost?: ResolveHost;
  robotsCache?: Map<string, RobotsResult>;
  minDelayMs?: number;
  rateLimitState?: RateLimitState;
}

export interface SafeFetchResult extends FetchResponse {
  initialUrl: string;
  redirectChain: string[];
  fetchedAt: string;
  bytes: number;
}

export class CrawlFetchError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'CrawlFetchError';
  }
}

interface RobotsResult {
  allowed(url: string, userAgent: string): boolean;
  sitemaps: string[];
}

const defaultResolveHost: ResolveHost = async hostname => {
  if (isIP(hostname)) return [hostname];
  return (await lookup(hostname, { all: true, verbatim: true })).map(item => item.address);
};

function isPublicIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
}

function ipv6Bytes(address: string): number[] | null {
  let value = address.toLowerCase().split('%')[0]!;
  if (value.includes('.')) {
    const boundary = value.lastIndexOf(':');
    const ipv4 = value.slice(boundary + 1).split('.').map(Number);
    if (ipv4.length !== 4 || ipv4.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    value = `${value.slice(0, boundary)}:${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${((ipv4[2]! << 8) | ipv4[3]!).toString(16)}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => '0'), ...right].map(part => Number.parseInt(part, 16));
  if (groups.length !== 8 || groups.some(group => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
  return groups.flatMap(group => [group >> 8, group & 0xff]);
}

function isPublicIp(address: string): boolean {
  if (!address.includes(':')) return isPublicIpv4(address);
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15]! <= 1) return false;
  if ((bytes[0]! & 0xfe) === 0xfc || (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) || bytes[0] === 0xff) return false;
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return isPublicIpv4(bytes.slice(12).join('.'));
  return true;
}

async function approvedAddress(url: URL, resolveHost: ResolveHost): Promise<{ address: string; family: 4 | 6 }> {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new CrawlFetchError('unsafe_url', `Unsupported or credentialed URL: ${url.href}`);
  }
  const addresses = await resolveHost(url.hostname);
  if (addresses.length === 0 || addresses.some(address => !isPublicIp(address))) {
    throw new CrawlFetchError('private_destination', `Destination does not resolve exclusively to public IPs: ${url.hostname}`);
  }
  const address = addresses[0]!;
  return { address, family: address.includes(':') ? 6 : 4 };
}

const defaultTransport: FetchTransport = async (url, options) => {
  const { address, family } = await approvedAddress(url, defaultResolveHost);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: address,
      family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      headers: { ...options.headers, host: url.host },
      timeout: options.timeoutMs,
    }, response => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          request.destroy(new CrawlFetchError('oversized_response', `Response exceeds ${options.maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const headers = Object.fromEntries(Object.entries(response.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value]]));
        let body = Buffer.concat(chunks);
        try {
          const encoding = headers['content-encoding']?.toLowerCase();
          if (encoding === 'gzip') body = gunzipSync(body, { maxOutputLength: options.maxBytes });
          else if (encoding === 'deflate') body = inflateSync(body, { maxOutputLength: options.maxBytes });
          else if (encoding === 'br') body = brotliDecompressSync(body, { maxOutputLength: options.maxBytes });
        } catch (error) {
          reject(new CrawlFetchError('decode_error', error instanceof Error ? error.message : String(error)));
          return;
        }
        if (body.length > options.maxBytes) {
          reject(new CrawlFetchError('oversized_response', `Decoded response exceeds ${options.maxBytes} bytes`));
          return;
        }
        resolve({ url: url.href, status: response.statusCode ?? 0, headers, body });
      });
    });
    request.on('timeout', () => request.destroy(new CrawlFetchError('timeout', `Timed out after ${options.timeoutMs}ms`)));
    request.on('error', reject);
    request.end();
  });
};

async function wait(ms: number): Promise<void> {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForHost(origin: string, minDelayMs: number, state: RateLimitState): Promise<void> {
  const previous = state.tails.get(origin) ?? Promise.resolve();
  let release = (): void => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  state.tails.set(origin, previous.then(() => gate));
  await previous;
  const remaining = (state.lastStartedAt.get(origin) ?? 0) + minDelayMs - Date.now();
  await wait(remaining);
  state.lastStartedAt.set(origin, Date.now());
  release();
}

async function requestWithRetries(url: URL, options: Required<Pick<SafeFetchOptions, 'timeoutMs' | 'maxBytes' | 'retries' | 'retryDelayMs' | 'userAgent' | 'minDelayMs'>> & { transport: FetchTransport; resolveHost: ResolveHost; rateLimitState: RateLimitState }): Promise<FetchResponse> {
  await approvedAddress(url, options.resolveHost);
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      await waitForHost(url.origin, options.minDelayMs, options.rateLimitState);
      const response = await options.transport(url, {
        timeoutMs: options.timeoutMs,
        maxBytes: options.maxBytes,
        headers: { 'user-agent': options.userAgent, accept: 'text/html,text/markdown,text/plain,application/xml,text/xml;q=0.9,*/*;q=0.1', 'accept-encoding': 'gzip, deflate, br' },
      });
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === options.retries) return response;
      lastError = new CrawlFetchError('http_error', `HTTP ${response.status} for ${url.href}`);
    } catch (error) {
      lastError = error;
      if (error instanceof CrawlFetchError && ['private_destination', 'unsafe_url', 'oversized_response'].includes(error.code)) throw error;
      if (attempt === options.retries) throw error;
    }
    await wait(options.retryDelayMs * (attempt + 1));
  }
  throw lastError;
}

async function loadRobots(origin: string, options: Required<Pick<SafeFetchOptions, 'timeoutMs' | 'maxBytes' | 'retries' | 'retryDelayMs' | 'maxRedirects' | 'userAgent' | 'minDelayMs'>> & { transport: FetchTransport; resolveHost: ResolveHost; robotsCache: Map<string, RobotsResult>; rateLimitState: RateLimitState }): Promise<RobotsResult> {
  const cached = options.robotsCache.get(origin);
  if (cached) return cached;
  let current = new URL('/robots.txt', origin);
  for (let redirects = 0; redirects <= options.maxRedirects; redirects += 1) {
    const response = await requestWithRetries(current, options);
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      const next = new URL(response.headers.location, current);
      if (next.origin !== current.origin) throw new CrawlFetchError('robots_unavailable', 'Cross-origin robots redirect refused');
      current = next;
      continue;
    }
    if (response.status === 404 || response.status === 410) {
      const result = { allowed: () => true, sitemaps: [] } satisfies RobotsResult;
      options.robotsCache.set(origin, result);
      return result;
    }
    if (response.status < 200 || response.status >= 300) throw new CrawlFetchError('robots_unavailable', `robots.txt returned HTTP ${response.status}`);
    const parsed = parseRobots(current.href, response.body.toString('utf8'));
    const result = { allowed: (url: string, userAgent: string) => parsed.isAllowed(url, userAgent) !== false, sitemaps: parsed.getSitemaps() } satisfies RobotsResult;
    options.robotsCache.set(origin, result);
    return result;
  }
  throw new CrawlFetchError('too_many_redirects', 'robots.txt exceeded redirect limit');
}

export async function discoverRobotsSitemaps(url: string, options: SafeFetchOptions = {}): Promise<string[]> {
  const normalized = withDefaults(options);
  return (await loadRobots(new URL(url).origin, normalized)).sitemaps;
}

function withDefaults(options: SafeFetchOptions) {
  return {
    timeoutMs: options.timeoutMs ?? 10_000,
    maxBytes: options.maxBytes ?? 3_000_000,
    retries: options.retries ?? 2,
    retryDelayMs: options.retryDelayMs ?? 200,
    maxRedirects: options.maxRedirects ?? 5,
    userAgent: options.userAgent ?? CRAWLER_USER_AGENT,
    transport: options.transport ?? defaultTransport,
    resolveHost: options.resolveHost ?? defaultResolveHost,
    robotsCache: options.robotsCache ?? new Map<string, RobotsResult>(),
    minDelayMs: options.minDelayMs ?? 0,
    rateLimitState: options.rateLimitState ?? { tails: new Map<string, Promise<void>>(), lastStartedAt: new Map<string, number>() },
  };
}

export async function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const config = withDefaults(options);
  const initial = new URL(url);
  let current = initial;
  const redirectChain: string[] = [];
  for (let redirects = 0; redirects <= config.maxRedirects; redirects += 1) {
    const robots = await loadRobots(current.origin, config);
    if (!robots.allowed(current.href, config.userAgent)) throw new CrawlFetchError('robots_disallowed', `robots.txt disallows ${current.href}`);
    const response = await requestWithRetries(current, config);
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      const next = new URL(response.headers.location, current);
      if (next.origin !== current.origin) throw new CrawlFetchError('cross_origin_redirect', `Redirect leaves allowed origin: ${next.href}`);
      redirectChain.push(next.href);
      current = next;
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new CrawlFetchError('http_error', `HTTP ${response.status} for ${current.href}`);
    return { ...response, url: current.href, initialUrl: initial.href, redirectChain, fetchedAt: new Date().toISOString(), bytes: response.body.length };
  }
  throw new CrawlFetchError('too_many_redirects', `Exceeded ${config.maxRedirects} redirects`);
}
