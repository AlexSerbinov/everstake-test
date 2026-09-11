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

from bs4 import BeautifulSoup

USER_AGENT = "EverstakeKnowledgeAssistant/1.0 (+public take-home research; contact: candidate)"
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
HTML_TYPES = ("text/html", "application/xhtml+xml")


@dataclass
class Document:
    url: str
    final_url: str
    title: str
    text: str
    category: str
    tier: int
    language: str
    seed: bool
    discovered_from: str
    published_at: str | None
    modified_at: str | None
    fetched_at: str
    status: int
    content_type: str
    sha256: str


class PoliteFetcher:
    def __init__(self, delay: float = 0.65, timeout: int = 20):
        self.delay = delay
        self.timeout = timeout
        self.last_request: dict[str, float] = defaultdict(float)
        self.robots: dict[str, urllib.robotparser.RobotFileParser] = {}

    def _robots(self, url: str) -> urllib.robotparser.RobotFileParser:
        parsed = urllib.parse.urlparse(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        if origin not in self.robots:
            rp = urllib.robotparser.RobotFileParser(origin + "/robots.txt")
            try:
                req = urllib.request.Request(rp.url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=self.timeout) as response:
                    rp.parse(response.read().decode("utf-8", "replace").splitlines())
            except Exception:
                # Fail closed when robots policy cannot be established.
                rp.parse(["User-agent: *", "Disallow: /"])
            self.robots[origin] = rp
        return self.robots[origin]

    def get(self, url: str) -> tuple[int, str, bytes, str] | None:
        if not self._robots(url).can_fetch(USER_AGENT, url):
            return None
        host = urllib.parse.urlparse(url).netloc
        wait = self.delay - (time.monotonic() - self.last_request[host])
        if wait > 0:
            time.sleep(wait)
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xml;q=0.9,*/*;q=0.5"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                body = response.read(3_000_000)
                self.last_request[host] = time.monotonic()
                return response.status, response.headers.get("Content-Type", ""), body, response.url
        except (urllib.error.URLError, TimeoutError, ValueError):
            self.last_request[host] = time.monotonic()
            return None


def canonicalize(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower() or "https"
    host = parsed.netloc.lower()
    path = re.sub(r"/{2,}", "/", parsed.path).rstrip("/") or "/"
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query = [(k, v) for k, v in query if not k.lower().startswith("utm_") and k.lower() not in {"ref", "source"}]
    return urllib.parse.urlunsplit((scheme, host, path, urllib.parse.urlencode(query), ""))


def date_from_page(soup: BeautifulSoup) -> tuple[str | None, str | None]:
    published = None
    modified = None
    for tag in soup.find_all("meta"):
        key = (tag.get("property") or tag.get("name") or "").lower()
        value = tag.get("content")
        if not value:
            continue
        if key in {"article:published_time", "date", "datepublished"}:
            published = value[:32]
        if key in {"article:modified_time", "last-modified", "datemodified"}:
            modified = value[:32]
    for script in soup.find_all("script", type="application/ld+json"):
        raw = script.string or ""
        if not published:
            match = re.search(r'"datePublished"\s*:\s*"([^"]+)', raw)
            published = match.group(1)[:32] if match else None
        if not modified:
            match = re.search(r'"dateModified"\s*:\s*"([^"]+)', raw)
            modified = match.group(1)[:32] if match else None
    return published, modified


def extract_html(body: bytes) -> tuple[str, str, str | None, str | None, list[str]]:
    soup = BeautifulSoup(body, "html.parser")
    # Structured dates live in scripts, so read them before removing scripts from
    # the untrusted body text.
    published, modified = date_from_page(soup)
    for node in soup(["script", "style", "noscript", "svg", "nav", "footer"]):
        node.decompose()
    title = soup.title.get_text(" ", strip=True) if soup.title else "Untitled"
    main = soup.find("main") or soup.find("article") or soup.body or soup
    text = re.sub(r"\n{3,}", "\n\n", main.get_text("\n", strip=True))
    links = [urllib.parse.urljoin("https://invalid/", str(a.get("href"))) for a in soup.find_all("a", href=True)]
    return title[:300], text, published, modified, links


def sitemap_urls(fetcher: PoliteFetcher, base: str) -> list[str]:
    pending = [urllib.parse.urljoin(base, "/sitemap.xml")]
    found: list[str] = []
    seen: set[str] = set()
    while pending and len(seen) < 20:
        sitemap = pending.pop()
        if sitemap in seen:
            continue
        seen.add(sitemap)
        result = fetcher.get(sitemap)
        if not result:
            continue
        _, _, body, _ = result
        try:
            locs = [node.text.strip() for node in ET.fromstring(body).iter() if node.tag.endswith("loc") and node.text]
        except ET.ParseError:
            continue
        for loc in locs:
            (pending if loc.endswith(".xml") else found).append(loc)
    return found


def crawl(seed_path: Path, output: Path, limit: int = 280) -> dict:
    with seed_path.open(newline="") as handle:
        seeds = list(csv.DictReader(handle))
    seed_map = {canonicalize(row["url"]): row for row in seeds}
    fetcher = PoliteFetcher()
    queue: deque[tuple[str, bool, str]] = deque((url, True, "seed") for url in seed_map)
    # Sitemaps are the safest expansion mechanism: publisher-declared URLs, no link spider explosion.
    for base in ("https://everstake.com", "https://docs.everstake.com"):
        for url in sitemap_urls(fetcher, base):
            queue.append((canonicalize(url), False, base + "/sitemap.xml"))
    seen: set[str] = set()
    documents: list[Document] = []
    exclusions: list[dict] = []
    while queue and len(documents) < limit:
        url, is_seed, source = queue.popleft()
        url = canonicalize(url)
        if url in seen:
            continue
        seen.add(url)
        host = urllib.parse.urlparse(url).netloc
        if host not in ALLOWED_HOSTS:
            exclusions.append({"url": url, "reason": "host_not_allowlisted"})
            continue
        result = fetcher.get(url)
        if not result:
            exclusions.append({"url": url, "reason": "robots_or_fetch_failure"})
            continue
        status, content_type, body, final_url = result
        if not any(t in content_type for t in HTML_TYPES):
            exclusions.append({"url": url, "reason": "unsupported_content_type", "content_type": content_type})
            continue
        title, text, published, modified, _ = extract_html(body)
        if len(text) < 180:
            exclusions.append({"url": url, "reason": "insufficient_text", "characters": len(text)})
            continue
        seed = seed_map.get(url, {})
        if seed:
            category, tier, language = seed["category"], int(seed["tier"]), seed["language"]
        else:
            category = "blog" if "/blog/" in url else "docs" if host == "docs.everstake.com" else "site"
            tier, language = 1, "en"
        documents.append(Document(
            url=url, final_url=canonicalize(final_url), title=title, text=text,
            category=category, tier=tier, language=language, seed=is_seed,
            discovered_from=source, published_at=published, modified_at=modified,
            fetched_at=datetime.now(timezone.utc).isoformat(), status=status,
            content_type=content_type, sha256=hashlib.sha256(text.encode()).hexdigest(),
        ))
        print(f"[{len(documents):03d}/{limit}] {url}", flush=True)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w") as handle:
        for doc in documents:
            handle.write(json.dumps(asdict(doc), ensure_ascii=False) + "\n")
    audit = {"generated_at": datetime.now(timezone.utc).isoformat(), "documents": len(documents), "visited": len(seen), "excluded": exclusions}
    output.with_name("crawl-audit.json").write_text(json.dumps(audit, indent=2))
    return audit


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seeds", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=280)
    args = parser.parse_args()
    print(json.dumps(crawl(args.seeds, args.output, args.limit), indent=2))


if __name__ == "__main__":
    main()
