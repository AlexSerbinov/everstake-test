"""Stage 1 of the pipeline: crawl -> [dedup -> index -> retrieve -> answer -> eval].

Turns a hand-curated seed list (`docs/corpus_sources.csv`) plus publisher-declared
sitemaps into `data/corpus.jsonl`: one JSON snapshot per page, carrying the text, the
dates the publisher claims, the source tier, and a SHA-256 of the extracted text.
Everything downstream treats that file as the frozen, dated record of what the public
web said -- so a bug here is invisible later. A page fetched from a host we do not
control, or text that still contains navigation chrome, becomes evidence the answer
stage will happily cite.

Two properties this module is responsible for and nothing else re-checks:

* Politeness. robots.txt is honoured per origin, one request per host at a time, and
  we fail closed when the policy cannot be read (`PoliteFetcher`).
* Provenance. Only allow-listed hosts enter the corpus (`ALLOWED_HOSTS`), and every
  document records where it was discovered from and when it was fetched.

Alongside the corpus it writes `crawl-audit.json`, which lists every URL that was
visited but rejected and why. That file is the answer to "did you crawl anything you
should not have?" on the defence call.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
import xml.etree.ElementTree as ET
from collections import defaultdict, deque
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from bs4 import BeautifulSoup, Tag

from .accounting import RunRecorder

# Identifies the crawler to site operators and gives them something to block. A
# truthful UA is part of the politeness contract; it is also the token robots.txt
# rules are matched against in `PoliteFetcher`.
USER_AGENT = "EverstakeKnowledgeAssistant/1.0 (+public take-home research; contact: candidate)"

# Positive allow-list, not a deny-list: a sitemap or a seed typo can point anywhere,
# and this is the only thing standing between the corpus and the open web. Everstake's
# own hosts come first; the rest are third-party pages the seed list deliberately
# includes so the corpus contains outside coverage to disagree with.
ALLOWED_HOSTS = {
    "everstake.com", "www.everstake.com", "everstake.one", "www.everstake.one",
    "docs.everstake.com", "eth-docs.everstake.one", "blockspace.everstake.one",
    "security.everstake.com", "status.everstake.one", "stake.everstake.com",
    "medium.com", "github.com", "raw.githubusercontent.com", "smithery.ai",
    "www.stakingrewards.com", "www.wikidata.org", "chainwire.org", "cryptopotato.com",
    "www.investing.com", "blocktelegraph.io", "blockchainmagazine.com",
    "bitcoinethereumnews.com", "www.bitget.com", "t.signalplus.com", "www.dlnews.com",
    "polygon.technology", "atomicwallet.io", "www.youtube.com", "youtube.com",
}

# Only markup goes through BeautifulSoup. PDFs, JSON and images reaching the text
# extractor would produce binary noise that looks like prose to the chunker.
HTML_TYPES = ("text/html", "application/xhtml+xml")

# Politeness/robustness limits. All hand-chosen for a one-off research crawl of a few
# hundred pages; no measurement backs the exact values.
DEFAULT_REQUEST_DELAY_SECONDS = 0.65  # per host, so a small site never sees a burst
DEFAULT_TIMEOUT_SECONDS = 20  # long enough for a slow docs site, short enough to not stall the run
MAX_RESPONSE_BYTES = 3_000_000  # 3 MB ceiling so one huge page cannot exhaust memory
MAX_SITEMAPS_PER_SITE = 20  # sitemap indexes nest; this bounds the fan-out
MIN_DOCUMENT_CHARACTERS = 180  # below this a page is a redirect stub or a cookie wall, not content
MAX_TITLE_CHARACTERS = 300  # titles are display-only; a 400-char SEO title is spam, not a title
DEFAULT_DOCUMENT_LIMIT = 280  # hand-set budget cap; the shipped corpus stopped exactly here

# 32 characters is exactly the longest ISO-8601 form we expect from a publisher
# ("2026-01-02T03:04:05.123456+00:00"). Whether that motivated the original constant
# is not recorded, but the intent is clear: a date attribute comes from untrusted
# markup, and it is stored verbatim, so it gets a hard length cap.
MAX_DATE_CHARACTERS = 32

# Sitemaps are crawled from these two roots only. They are the hosts whose content is
# authoritative for the assignment; expanding this list expands the corpus silently.
SITEMAP_ROOTS = ("https://everstake.com", "https://docs.everstake.com")

# Meta tag keys that carry a publication / last-modified date, lowercased. Several
# spellings exist in the wild (Open Graph, Dublin-Core-ish, schema.org flattened into
# a meta name), and Everstake's own pages do not use a single one consistently.
PUBLISHED_META_KEYS = {"article:published_time", "date", "datepublished"}
MODIFIED_META_KEYS = {"article:modified_time", "last-modified", "datemodified"}

# Query parameters that identify a campaign or a referrer rather than content. Dropped
# so the same page arriving from a newsletter and from a sitemap canonicalises to one
# URL and dedupes into one document.
TRACKING_PARAMETER_PREFIX = "utm_"
TRACKING_PARAMETER_NAMES = {"ref", "source"}

# Elements that are chrome rather than content. `nav` and `footer` matter most: their
# text repeats on every page and would otherwise dominate the near-duplicate detector.
NON_CONTENT_TAGS = ["script", "style", "noscript", "svg", "nav", "footer"]

# Relative hrefs need an absolute base to resolve against. This placeholder host is
# deliberately unroutable: `crawl()` discards the link list and expands only through
# sitemaps, so a link that accidentally became fetchable would be a bug, not a feature.
LINK_RESOLUTION_BASE = "https://invalid/"


@dataclass
class Document:
    """One dated snapshot of one public page -- the unit of the frozen corpus.

    Field order is the JSON key order in `corpus.jsonl`, which the indexer and the
    refresher both read, so it is part of the on-disk contract.
    """

    url: str  # canonical URL we requested; the corpus's primary key
    final_url: str  # canonicalised URL after redirects; what gets cited to the user
    title: str
    text: str
    category: str  # seed-declared purpose (canonical / site / docs / blog / press / ...)
    tier: int  # 1 = first-party or authoritative, 2 = everything else; scales retrieval score
    language: str
    seed: bool  # True if hand-curated, False if discovered through a sitemap
    discovered_from: str  # provenance for the audit: "seed" or the sitemap URL
    published_at: str | None  # publisher's claim, not ours -- may be absent or wrong
    modified_at: str | None
    fetched_at: str  # ours, and always present; the last-resort date for ranking
    status: int
    content_type: str
    sha256: str  # over the extracted text, so the refresher can detect real changes


class PoliteFetcher:
    """The single door through which this system reads a page it does not own.

    Centralised so the politeness rules cannot be bypassed by accident: robots.txt per
    origin, a minimum gap between requests to the same host, a response size ceiling,
    and transport errors turned into `None` instead of exceptions. `app/tools.py`
    reuses it for the agent's live-fetch tool, which is why the delay is a parameter -
    a single on-demand fetch has no burst to throttle. (The other outbound calls in
    the repo go to APIs we are a paying client of: the model providers in
    `app/api_clients.py` and Everstake's own MCP server in `app/tools.py`.)
    """

    def __init__(self, delay: float = DEFAULT_REQUEST_DELAY_SECONDS,
                 timeout: int = DEFAULT_TIMEOUT_SECONDS):
        self.delay = delay
        self.timeout = timeout
        # Last request time per host, on the monotonic clock so a system clock jump
        # cannot make us think we already waited. defaultdict(float) means an unseen
        # host reads as 0.0 and is therefore never delayed on its first request.
        self.last_request: dict[str, float] = defaultdict(float)
        # One parsed robots.txt per origin, kept for the life of the crawl so a
        # 280-page run costs at most a handful of robots requests.
        self.robots: dict[str, urllib.robotparser.RobotFileParser] = {}
        self.bytes_downloaded = 0

    def _robots(self, url: str) -> urllib.robotparser.RobotFileParser:
        """Return the cached robots policy for this URL's origin, fetching it once.

        The cache key is scheme+host, not just host: http:// and https:// are
        different origins and may serve different policies.
        """
        parsed = urllib.parse.urlparse(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in self.robots:
            self.robots[origin] = self._download_robots(origin)
        return self.robots[origin]

    def _download_robots(self, origin: str) -> urllib.robotparser.RobotFileParser:
        """Fetch and parse one origin's robots.txt, defaulting to "crawl nothing"."""
        policy = urllib.robotparser.RobotFileParser(origin + "/robots.txt")
        try:
            request = urllib.request.Request(policy.url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read()
                self.bytes_downloaded += len(body)
                policy.parse(body.decode("utf-8", "replace").splitlines())
        except Exception:
            # Fail closed when robots policy cannot be established. A timeout or a 500
            # tells us nothing about the operator's wishes, and guessing "allowed"
            # would be exactly the behaviour a crawler gets blocked for. Bare `except`
            # because urllib raises several unrelated types here (URLError, socket
            # errors, UnicodeError from a malformed host) and all mean the same thing.
            policy.parse(["User-agent: *", "Disallow: /"])
        return policy

    def get(self, url: str) -> tuple[int, str, bytes, str] | None:
        """Fetch one URL politely, or return None if we may not or could not.

        `None` deliberately conflates "robots said no" with "the request failed": the
        caller's only correct response to either is to skip the URL and record an
        exclusion, and collapsing them keeps that decision in one place.

        Returns (status, content type, body, final URL after redirects).
        """
        if not self._robots(url).can_fetch(USER_AGENT, url):
            return None
        host = urllib.parse.urlparse(url).netloc
        self._wait_for_host(host)
        request = urllib.request.Request(url, headers={
            "User-Agent": USER_AGENT,
            # Signals we want markup; the q-values let a server that only has XML
            # (a sitemap) still answer rather than returning 406.
            "Accept": "text/html,application/xml;q=0.9,*/*;q=0.5",
        })
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read(MAX_RESPONSE_BYTES)
                self.bytes_downloaded += len(body)
                self.last_request[host] = time.monotonic()
                return response.status, response.headers.get("Content-Type", ""), body, response.url
        except (urllib.error.URLError, TimeoutError, ValueError):
            # Stamp the host even on failure: a server that is timing out is the last
            # one that should receive the next request without a pause. ValueError
            # covers urllib rejecting a malformed URL from a sitemap.
            self.last_request[host] = time.monotonic()
            return None

    def _wait_for_host(self, host: str) -> None:
        """Sleep just long enough that this host sees at most one request per delay."""
        remaining = self.delay - (time.monotonic() - self.last_request[host])
        if remaining > 0:
            time.sleep(remaining)


def canonicalize(url: str) -> str:
    """Collapse the many spellings of one page into a single corpus key.

    The crawl reaches the same page from a seed, a sitemap and a redirect target, and
    the deduplicator downstream only catches *content* duplicates -- URL duplicates
    have to die here or the corpus counts the page three times.

    Normalises: scheme and host to lower case (path left alone, because paths are
    case-sensitive on many servers), repeated slashes collapsed, trailing slash
    dropped, fragment dropped, campaign/referrer parameters dropped. Parameter *order*
    is deliberately preserved rather than sorted, so this stays a cheap textual
    normalisation and never changes the meaning of an ordered query string.
    """
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower() or "https"
    host = parsed.netloc.lower()
    # "//a//b" -> "/a/b", then "/blog/" -> "/blog"; a bare origin collapses to "/".
    path = re.sub(r"/{2,}", "/", parsed.path).rstrip("/") or "/"
    parameters = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    kept = [
        (name, value)
        for name, value in parameters
        if not name.lower().startswith(TRACKING_PARAMETER_PREFIX)
        and name.lower() not in TRACKING_PARAMETER_NAMES
    ]
    # KNOWN LIMITATION: `parsed.scheme.lower() or "https"` assumes that a URL without
    # a scheme also has no netloc. urlsplit("everstake.com/x") puts the whole thing in
    # `path`, so the result is "https:everstake.com/x" -- syntactically a URL, but
    # unusable. Pinned by test_a_schemeless_url_is_mangled_rather_than_defaulted_to_https_host.
    # Harmless today because every seed and sitemap entry is absolute; it would bite
    # the moment someone hand-edits the seed CSV.
    return urllib.parse.urlunsplit((scheme, host, path, urllib.parse.urlencode(kept), ""))


def date_from_page(soup: BeautifulSoup) -> tuple[str | None, str | None]:
    """Recover the publisher's own (published, modified) claim from page metadata.

    Ranking is date-driven, and most pages do not state a date in their prose, so
    metadata is the only date source that exists. Meta tags are checked before
    JSON-LD because a page carrying both usually keeps the meta tag current while the
    JSON-LD block is generated once and forgotten.

    Both values are returned verbatim (truncated) rather than parsed into a datetime:
    the formats are inconsistent, and `retrieval._year` only ever needs the year.
    """
    published, modified = _dates_from_meta_tags(soup)
    from_json_ld_published, from_json_ld_modified = _dates_from_json_ld(soup)
    return published or from_json_ld_published, modified or from_json_ld_modified


def _dates_from_meta_tags(soup: BeautifulSoup) -> tuple[str | None, str | None]:
    """Read dates from <meta property=...> / <meta name=...>; last tag on the page wins."""
    published: str | None = None
    modified: str | None = None
    for tag in soup.find_all("meta"):
        # `property` is the Open Graph spelling, `name` the HTML one; pages use both.
        key = (tag.get("property") or tag.get("name") or "").lower()
        value = tag.get("content")
        if not value:
            continue
        if key in PUBLISHED_META_KEYS:
            published = value[:MAX_DATE_CHARACTERS]
        if key in MODIFIED_META_KEYS:
            modified = value[:MAX_DATE_CHARACTERS]
    return published, modified


def _dates_from_json_ld(soup: BeautifulSoup) -> tuple[str | None, str | None]:
    """Read dates from schema.org JSON-LD blocks; the first block with a value wins.

    Deliberately regex, not `json.loads`: real pages ship JSON-LD with trailing
    commas, embedded newlines and duplicate keys, and a parse failure would throw away
    a date we can see in the raw text. The pattern matches the opening quote of the
    value, e.g. `"datePublished": "2026-06-15T10:55:02"` -> `2026-06-15T10:55:02`.
    """
    published: str | None = None
    modified: str | None = None
    for script in soup.find_all("script", type="application/ld+json"):
        raw = script.string or ""
        if not published:
            match = re.search(r'"datePublished"\s*:\s*"([^"]+)', raw)
            published = match.group(1)[:MAX_DATE_CHARACTERS] if match else None
        if not modified:
            match = re.search(r'"dateModified"\s*:\s*"([^"]+)', raw)
            modified = match.group(1)[:MAX_DATE_CHARACTERS] if match else None
    return published, modified


def extract_html(body: bytes) -> tuple[str, str, str | None, str | None, list[str]]:
    """Reduce a raw HTML response to (title, text, published, modified, links).

    This is where untrusted markup becomes the plain text that will later be chunked,
    embedded and shown to a language model, so the boundary matters: anything left in
    `text` is something the model may treat as evidence. Chrome and script tags are
    removed here; *instruction-like* prose is removed later by
    `app/security.sanitize_untrusted_text`, because that needs sentence context.

    Also used by `app/tools.py` for the agent's live-fetch tool, so it must stay pure
    and side-effect free.
    """
    soup = BeautifulSoup(body, "html.parser")
    # Structured dates live in scripts, so read them before removing scripts from
    # the untrusted body text. Reordering these two lines silently loses every
    # JSON-LD date in the corpus -- pinned by a test in both test_core and test_crawler.
    published, modified = date_from_page(soup)
    for node in soup(NON_CONTENT_TAGS):
        node.decompose()
    title = soup.title.get_text(" ", strip=True) if soup.title else "Untitled"
    text = _readable_text(_main_content_node(soup))
    links = [
        urllib.parse.urljoin(LINK_RESOLUTION_BASE, str(anchor.get("href")))
        for anchor in soup.find_all("a", href=True)
    ]
    return title[:MAX_TITLE_CHARACTERS], text, published, modified, links


def _main_content_node(soup: BeautifulSoup) -> Tag:
    """Pick the narrowest container that still holds the article.

    Ordered widest-value-first: `<main>` and `<article>` are explicit authorial
    signals, `<body>` is the fallback for pages with no semantic markup, and `soup`
    itself covers a fragment with no body at all (which `app/tools.py` can hand us
    when a live page returns a partial response).
    """
    return soup.find("main") or soup.find("article") or soup.body or soup


def _readable_text(node: Tag) -> str:
    """Flatten an element to newline-separated text with blank-line runs collapsed.

    One line per block element (rather than one space) preserves the line structure
    the boilerplate detector in `indexer.py` keys on. Runs of 3+ newlines collapse to
    one blank line so a layout-heavy page does not inflate its own line count.
    """
    return re.sub(r"\n{3,}", "\n\n", node.get_text("\n", strip=True))


def sitemap_urls(fetcher: PoliteFetcher, base: str) -> list[str]:
    """Expand one site into its publisher-declared URL list.

    Sitemaps rather than link-following: a spider that follows every anchor leaves the
    intended scope within two hops and needs depth limits, loop detection and a much
    larger allow-list. A sitemap is the operator's own statement of what is worth
    indexing, which is exactly the corpus we want.

    Handles sitemap indexes by treating any `<loc>` ending in `.xml` as another
    sitemap to visit. `pending` is a stack (`pop()` from the end), so nested indexes
    are followed depth-first; the ordering does not matter because the result is
    collected into one flat list, but the MAX_SITEMAPS_PER_SITE cap does - it is what
    stops a self-referencing or very deep index from looping the crawl.
    """
    pending = [urllib.parse.urljoin(base, "/sitemap.xml")]
    found: list[str] = []
    seen: set[str] = set()
    while pending and len(seen) < MAX_SITEMAPS_PER_SITE:
        sitemap = pending.pop()
        if sitemap in seen:
            continue
        seen.add(sitemap)
        result = fetcher.get(sitemap)
        if not result:
            continue
        _status, _content_type, body, _final_url = result
        locations = _locations_in_sitemap(body)
        for location in locations:
            # A nested sitemap goes back on the queue; anything else is a page.
            (pending if location.endswith(".xml") else found).append(location)
    return found


def _locations_in_sitemap(body: bytes) -> list[str]:
    """Pull every <loc> value out of a sitemap, or nothing if it will not parse.

    Matches on `tag.endswith("loc")` rather than an exact name because sitemap XML is
    namespaced: ElementTree reports the tag as
    `{http://www.sitemaps.org/schemas/sitemap/0.9}loc`. A ParseError yields an empty
    list because a server that returns an HTML error page with an XML content type is
    common and is not worth aborting the crawl for.
    """
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        return []
    return [node.text.strip() for node in root.iter() if node.tag.endswith("loc") and node.text]


def crawl(seed_path: Path, output: Path, limit: int = DEFAULT_DOCUMENT_LIMIT) -> dict:
    """Build the frozen corpus: fetch seeds plus sitemap expansions, write JSONL.

    A FIFO queue, seeded in two waves: every hand-curated seed first, then everything
    the sitemaps declared. That ordering is the point - `limit` cuts the run short,
    and the pages a human chose must never be the ones it cuts.

    Writes two files next to each other: `output` (the corpus) and `crawl-audit.json`
    (every URL visited and every rejection with its reason). Returns the audit dict.
    """
    seed_rows = _seed_rows_by_canonical_url(seed_path)
    fetcher = PoliteFetcher()
    queue = _initial_frontier(seed_rows, fetcher)

    visited: set[str] = set()
    documents: list[Document] = []
    exclusions: list[dict] = []
    while queue and len(documents) < limit:
        url, is_seed, discovered_from = queue.popleft()
        # Re-canonicalise: sitemap entries arrive raw, and the frontier may hold two
        # spellings of one page that only collapse after normalisation.
        url = canonicalize(url)
        if url in visited:
            continue
        visited.add(url)
        document, exclusion = _fetch_document(fetcher, url, is_seed, discovered_from, seed_rows)
        if exclusion is not None:
            exclusions.append(exclusion)
            continue
        documents.append(document)
        # Progress on stdout: the crawl takes minutes and is run by hand from the
        # Makefile. Format is load-bearing only for the operator watching it.
        print(f"[{len(documents):03d}/{limit}] {url}", flush=True)

    _write_corpus(output, documents)
    audit = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "documents": len(documents),
        "visited": len(visited),
        "excluded": exclusions,
        "bytes_downloaded": fetcher.bytes_downloaded,
    }
    output.with_name("crawl-audit.json").write_text(json.dumps(audit, indent=2))
    return audit


def _seed_rows_by_canonical_url(seed_path: Path) -> dict[str, dict]:
    """Read the seed CSV into {canonical URL: row}.

    Keyed by the canonical URL because that is the form the crawl loop will look the
    row up by; keying on the raw CSV value would silently lose the hand-assigned
    category and tier for any seed written with a trailing slash or a tracking
    parameter. Columns used downstream: url, category, tier, language.
    """
    with seed_path.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    return {canonicalize(row["url"]): row for row in rows}


def _initial_frontier(seed_rows: dict[str, dict],
                      fetcher: PoliteFetcher) -> deque[tuple[str, bool, str]]:
    """Build the crawl queue: every seed first, then sitemap discoveries.

    Each entry is (url, is_seed, discovered_from); `discovered_from` ends up in the
    corpus so the audit can show how a page entered it.
    """
    queue: deque[tuple[str, bool, str]] = deque((url, True, "seed") for url in seed_rows)
    # Sitemaps are the safest expansion mechanism: publisher-declared URLs, no link
    # spider explosion. Appended after the seeds so a `limit` cut-off never costs us
    # a curated page.
    for base in SITEMAP_ROOTS:
        sitemap_url = base + "/sitemap.xml"
        for url in sitemap_urls(fetcher, base):
            queue.append((canonicalize(url), False, sitemap_url))
    return queue


def _fetch_document(fetcher: PoliteFetcher, url: str, is_seed: bool, discovered_from: str,
                    seed_rows: dict[str, dict]) -> tuple[Document | None, dict | None]:
    """Fetch and parse one URL into a corpus Document, or explain why it was rejected.

    Returns exactly one of (document, None) or (None, exclusion record). Every
    rejection is recorded rather than dropped, because "why is page X missing from the
    corpus?" is the question this crawler most often has to answer.
    """
    host = urllib.parse.urlparse(url).netloc
    if host not in ALLOWED_HOSTS:
        return None, {"url": url, "reason": "host_not_allowlisted"}
    result = fetcher.get(url)
    if not result:
        # PoliteFetcher collapses "robots forbade it" and "the request failed" into
        # None, so the audit reason has to name both possibilities honestly.
        return None, {"url": url, "reason": "robots_or_fetch_failure"}
    status, content_type, body, final_url = result
    # Substring test, not equality: a real Content-Type is "text/html; charset=utf-8".
    if not any(html_type in content_type for html_type in HTML_TYPES):
        return None, {"url": url, "reason": "unsupported_content_type", "content_type": content_type}
    title, text, published, modified, _links = extract_html(body)
    if len(text) < MIN_DOCUMENT_CHARACTERS:
        return None, {"url": url, "reason": "insufficient_text", "characters": len(text)}

    category, tier, language = _classify(url, host, seed_rows)
    document = Document(
        url=url,
        final_url=canonicalize(final_url),
        title=title,
        text=text,
        category=category,
        tier=tier,
        language=language,
        seed=is_seed,
        discovered_from=discovered_from,
        published_at=published,
        modified_at=modified,
        fetched_at=datetime.now(timezone.utc).isoformat(),
        status=status,
        content_type=content_type,
        # Hash of the extracted text, not the raw bytes: `app/refresh.py` compares
        # this weekly, and hashing the bytes would flag every rotating build id and
        # CSRF token as a content change.
        sha256=hashlib.sha256(text.encode()).hexdigest(),
    )
    return document, None


def _classify(url: str, host: str, seed_rows: dict[str, dict]) -> tuple[str, int, str]:
    """Assign (category, tier, language) -- the labels retrieval ranks on.

    A hand-curated seed row always wins: the CSV is where a human decided that
    `/ai-info` is `canonical` and a press mirror is tier 2, and that judgement is not
    reconstructible from the URL.

    Sitemap discoveries get a URL-shape guess plus tier 1 / English. Tier 1 is safe
    here only because sitemaps are crawled from Everstake-owned roots only; if
    SITEMAP_ROOTS ever gains a third-party host, this default becomes wrong.
    """
    seed_row = seed_rows.get(url, {})
    if seed_row:
        return seed_row["category"], int(seed_row["tier"]), seed_row["language"]
    if "/blog/" in url:
        category = "blog"
    elif host == "docs.everstake.com":
        category = "docs"
    else:
        category = "site"
    return category, 1, "en"


def _write_corpus(output: Path, documents: list[Document]) -> None:
    """Write the corpus as JSONL: one self-contained document snapshot per line.

    `ensure_ascii=False` keeps non-Latin text readable in the file, which matters
    because this corpus gets inspected by hand during a defence.
    """
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w") as handle:
        for doc in documents:
            handle.write(json.dumps(asdict(doc), ensure_ascii=False) + "\n")


def main() -> None:
    """CLI entry point (`make crawl`). Prints the audit summary as JSON."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=DEFAULT_DOCUMENT_LIMIT)
    args = parser.parse_args()
    recorder = RunRecorder("stage", "crawl", {"code_or_model": "code"}).activate()
    try:
        audit = crawl(args.seeds, args.output, args.limit)
    except Exception:
        recorder.finish(status="failed")
        raise
    recorder.finish(
        items={"documents": audit["documents"], "visited_urls": audit["visited"]},
        bytes_downloaded=audit["bytes_downloaded"],
    )
    print(json.dumps(audit, indent=2))


if __name__ == "__main__":
    main()
