"""Policy-driven corpus refresh with cheap HTTP and GitHub change detection.

Each due source type follows the cheapest useful chain: sitemap ``lastmod`` first,
then conditional GET, then a hash of extracted content. GitHub is checked through the
organisation repositories API and only commits since the preceding check are read.
The append-only run log is the UI's human-readable freshness receipt.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .accounting import RunRecorder
from .config import CORPUS_PATH, DB_PATH, FRESHNESS_LOG_PATH, FRESHNESS_STATE_PATH, load_dotenv
from .crawler import (
    HTML_TYPES, MAX_RESPONSE_BYTES, USER_AGENT, PoliteFetcher, canonicalize, extract_html,
)
from .freshness import INTERVAL_HOURS, load_policy, source_type
from .indexer import _embed_and_insert_chunks, build, chunks, normalized_words
from .security import sanitize_untrusted_text

TITLE_MAX_CHARS = 300
GITHUB_API = "https://api.github.com"
GITHUB_ORG = "everstake"
SITEMAPS = ("https://everstake.com/sitemap.xml", "https://everstake.one/sitemap.xml")
FACT_PATTERN = re.compile(
    r"[^\n.!?]*(?:\$|\b\d[\d,.]*\s*(?:%|billion|million|bps|apy|apr)?\b)[^\n.!?]*", re.I
)


class ConditionalFetcher(PoliteFetcher):
    """PoliteFetcher variant that exposes validators and a 304 result."""

    def get_with_validators(self, url: str, validators: dict[str, str] | None = None) -> dict | None:
        if not self._robots(url).can_fetch(USER_AGENT, url):
            return None
        host = urllib.parse.urlparse(url).netloc
        self._wait_for_host(host)
        headers = {"User-Agent": USER_AGENT, "Accept": "text/html,application/xml;q=0.9,*/*;q=0.5"}
        if validators:
            if validators.get("etag"):
                headers["If-None-Match"] = validators["etag"]
            if validators.get("last_modified"):
                headers["If-Modified-Since"] = validators["last_modified"]
        request = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                body = response.read(MAX_RESPONSE_BYTES)
                self.bytes_downloaded += len(body)
                return {
                    "status": response.status,
                    "content_type": response.headers.get("Content-Type", ""),
                    "body": body,
                    "url": response.url,
                    "etag": response.headers.get("ETag"),
                    "last_modified": response.headers.get("Last-Modified"),
                }
        except urllib.error.HTTPError as error:
            if error.code == 304:
                return {"status": 304, "etag": error.headers.get("ETag"),
                        "last_modified": error.headers.get("Last-Modified")}
            return None
        except (urllib.error.URLError, TimeoutError, ValueError):
            return None
        finally:
            self.last_request[host] = time.monotonic()


def refresh(corpus: Path, database: Path, apply: bool = False, limit: int = 0,
            force: bool = False, policy_path: Path | None = None,
            state_path: Path | None = None, log_path: Path | None = None) -> dict:
    """Run every due policy, append a change receipt, and atomically rebuild if needed."""
    policy = load_policy(policy_path) if policy_path else load_policy()
    state_path = state_path or FRESHNESS_STATE_PATH
    log_path = log_path or FRESHNESS_LOG_PATH
    state = _read_json(state_path, {"sources": {}, "http": {}, "github": {}})
    docs = _load_corpus(corpus)
    started = datetime.now(timezone.utc)
    due = [
        name for name, choice in policy["sources"].items()
        if force or _is_due(state.get("sources", {}).get(name, {}).get("last_checked"),
                            choice["interval"], started)
    ]
    fetcher = ConditionalFetcher()
    sitemap = _sitemap_lastmods(fetcher) if any(
        name in due for name in ("live_pages", "blog", "docs", "reports_events")
    ) else {}
    changes: list[dict] = []
    checks: list[dict] = []
    replacements: dict[str, dict] = {}
    checked = 0

    for doc in docs:
        kind = source_type(doc)
        if kind not in due or kind == "github" or (limit and checked >= limit):
            continue
        checked += 1
        outcome = _check_page(fetcher, doc, state, sitemap)
        checks.append({"source_type": kind, "url": doc["url"], "method": outcome["method"]})
        if outcome.get("document"):
            delta = _describe_page_change(doc, outcome["document"], policy["sources"][kind]["depth"])
            changes.append(delta)
            if policy["sources"][kind]["depth"] != "cheap":
                replacements[doc["url"]] = outcome["document"]

    if "github" in due:
        github_changes, github_checks = _check_github(state, started)
        changes.extend(github_changes)
        checks.extend(github_checks)

    if not limit or checked < limit:
        known = {doc["url"] for doc in docs}
        for url, lastmod in sitemap.items():
            if url in known or (limit and checked >= limit):
                continue
            kind = source_type({"url": url, "category": _category_for_url(url)})
            if kind not in due:
                continue
            checked += 1
            fresh = _fetch_new_page(fetcher, url, kind, lastmod)
            if fresh:
                depth = policy["sources"][kind]["depth"]
                changes.append({"kind": "new_page", "source_type": kind, "url": url,
                                "title": fresh["title"], "depth": depth})
                if depth != "cheap":
                    replacements[url] = fresh

    applied = bool(apply and replacements)
    index_stats = None
    if applied:
        changed_urls = set(replacements)
        full_rebuild = any(change.get("depth") == "full" and change.get("url") in changed_urls
                           for change in changes)
        for index, doc in enumerate(docs):
            if doc["url"] in replacements:
                _snapshot_previous_version(corpus, doc)
                docs[index] = replacements.pop(doc["url"])
        docs.extend(replacements.values())
        index_stats = _apply_changes(corpus, database, docs, changed_urls, full_rebuild)

    finished = datetime.now(timezone.utc)
    totals = Counter(source_type(doc) for doc in docs if source_type(doc) != "github")
    completed = {kind for kind in due if kind == "github"}
    checked_by_type = Counter(item["source_type"] for item in checks if item["source_type"] != "github")
    completed.update(kind for kind, count in checked_by_type.items() if count >= totals[kind])
    for kind in completed:
        state.setdefault("sources", {}).setdefault(kind, {})["last_checked"] = finished.isoformat()
    state["last_run"] = finished.isoformat()
    state["last_changed"] = finished.isoformat() if changes else state.get("last_changed")
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state, indent=2))
    report = {
        "started_at": started.isoformat(), "finished_at": finished.isoformat(),
        "policy": policy.get("preset", "custom"), "due_source_types": due,
        "completed_source_types": sorted(completed),
        "checked": checked, "checks": checks, "changed": len(changes), "changes": changes,
        "applied": applied, "bytes_downloaded": fetcher.bytes_downloaded, "index": index_stats,
    }
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a") as handle:
        handle.write(json.dumps(report, ensure_ascii=False) + "\n")
    corpus.with_name("refresh-report.json").write_text(json.dumps(report, indent=2))
    return report


def _is_due(last_checked: str | None, interval: str, now: datetime) -> bool:
    hours = INTERVAL_HOURS[interval]
    if hours is None:
        return False
    if not last_checked:
        return True
    then = datetime.fromisoformat(last_checked.replace("Z", "+00:00"))
    return (now - then).total_seconds() >= hours * 3600


def _sitemap_lastmods(fetcher: ConditionalFetcher) -> dict[str, str | None]:
    result: dict[str, str | None] = {}
    pending = list(SITEMAPS)
    seen = set()
    while pending and len(seen) < 20:
        url = pending.pop()
        if url in seen:
            continue
        seen.add(url)
        response = fetcher.get_with_validators(url)
        if not response or response["status"] != 200:
            continue
        try:
            root = ET.fromstring(response["body"])
        except ET.ParseError:
            continue
        for entry in root:
            values = {node.tag.rsplit("}", 1)[-1]: (node.text or "").strip() for node in entry}
            location = values.get("loc")
            if not location:
                continue
            canonical = canonicalize(location)
            if canonical.endswith(".xml"):
                pending.append(canonical)
            else:
                result[canonical] = values.get("lastmod") or None
    return result


def _check_page(fetcher: ConditionalFetcher, doc: dict, state: dict,
                sitemap: dict[str, str | None]) -> dict:
    url = doc["url"]
    http = state.setdefault("http", {}).setdefault(url, {})
    current_lastmod = sitemap.get(url)
    if current_lastmod and current_lastmod == http.get("sitemap_lastmod"):
        return {"method": "sitemap_lastmod"}
    response = fetcher.get_with_validators(url, http)
    http["sitemap_lastmod"] = current_lastmod
    if not response:
        return {"method": "fetch_failed"}
    http.update({key: response.get(key) for key in ("etag", "last_modified") if response.get(key)})
    if response["status"] == 304:
        return {"method": "conditional_304"}
    if not any(kind in response["content_type"] for kind in HTML_TYPES):
        return {"method": "unsupported_content_type"}
    title, text, published, modified, _ = extract_html(response["body"])
    digest = hashlib.sha256(text.encode()).hexdigest()
    if digest == doc.get("sha256"):
        return {"method": "content_hash"}
    updated = {
        **doc, "final_url": canonicalize(response["url"]), "title": title[:TITLE_MAX_CHARS],
        "text": text, "published_at": published or doc.get("published_at"),
        "modified_at": modified or doc.get("modified_at"),
        "fetched_at": datetime.now(timezone.utc).isoformat(), "status": response["status"],
        "content_type": response["content_type"], "sha256": digest,
    }
    return {"method": "content_hash_changed", "document": updated}


def _describe_page_change(old: dict, new: dict, depth: str) -> dict:
    old_facts = set(FACT_PATTERN.findall(old.get("text", "")))
    new_facts = set(FACT_PATTERN.findall(new["text"]))
    return {
        "kind": "changed_page", "source_type": source_type(old), "url": old["url"],
        "title": new["title"], "depth": depth, "old_sha256": old.get("sha256"),
        "new_sha256": new["sha256"], "facts_added": sorted(new_facts - old_facts)[:5],
        "facts_removed": sorted(old_facts - new_facts)[:5],
    }


def _check_github(state: dict, now: datetime) -> tuple[list[dict], list[dict]]:
    previous = state.setdefault("github", {})
    repos = _github_json(f"/orgs/{GITHUB_ORG}/repos?per_page=100&type=public") or []
    changes, checks = [], []
    since = previous.get("checked_at")
    for repo in repos:
        name, pushed = repo["name"], repo.get("pushed_at")
        checks.append({"source_type": "github", "url": repo["html_url"], "method": "repos_pushed_at"})
        if previous.get("repos", {}).get(name) == pushed:
            continue
        commits = _github_json(
            f"/repos/{GITHUB_ORG}/{name}/commits?per_page=20"
            + (f"&since={urllib.parse.quote(since)}" if since else "")
        ) or []
        if since and commits:
            changes.append({
                "kind": "github_diff", "source_type": "github", "url": repo["html_url"],
                "title": name, "pushed_at": pushed, "commits": len(commits),
                "summary": [item.get("commit", {}).get("message", "").splitlines()[0][:140]
                            for item in commits[:5]],
            })
    previous["repos"] = {repo["name"]: repo.get("pushed_at") for repo in repos}
    previous["checked_at"] = now.isoformat()
    return changes, checks


def _github_json(path: str) -> Any:
    request = urllib.request.Request(GITHUB_API + path, headers={
        "User-Agent": USER_AGENT, "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    token = os.getenv("GITHUB_TOKEN")
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
        return None


def _fetch_new_page(fetcher: ConditionalFetcher, url: str, kind: str,
                    lastmod: str | None) -> dict | None:
    response = fetcher.get_with_validators(url)
    if not response or response["status"] != 200 or not any(
            value in response["content_type"] for value in HTML_TYPES):
        return None
    title, text, published, modified, _ = extract_html(response["body"])
    if len(text) < 120:
        return None
    return {
        "url": url, "final_url": canonicalize(response["url"]), "title": title, "text": text,
        "category": _category_for_url(url), "tier": 1, "language": "en", "seed": False,
        "discovered_from": "sitemap refresh", "published_at": published,
        "modified_at": modified or lastmod, "fetched_at": datetime.now(timezone.utc).isoformat(),
        "status": 200, "content_type": response["content_type"],
        "sha256": hashlib.sha256(text.encode()).hexdigest(),
    }


def _category_for_url(url: str) -> str:
    if "/blog/" in url:
        return "blog"
    if urllib.parse.urlparse(url).hostname == "docs.everstake.com":
        return "docs"
    return "site"


def _snapshot_previous_version(corpus: Path, doc: dict) -> None:
    snapshot_dir = corpus.parent / "snapshots"
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    payload = {"captured_at": datetime.now(timezone.utc).isoformat(),
               "previous_sha256": doc.get("sha256"), "document": doc}
    (snapshot_dir / f"{doc.get('sha256') or 'unknown'}.json").write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    )


def _apply_changes(corpus: Path, database: Path, docs: list[dict], changed_urls: set[str],
                   full_rebuild: bool) -> dict:
    temporary = corpus.with_suffix(".next.jsonl")
    temporary.write_text("".join(json.dumps(doc, ensure_ascii=False) + "\n" for doc in docs))
    next_database = database.with_suffix(".next.sqlite3")
    if full_rebuild:
        stats = build(temporary, next_database)
    else:
        stats = _incremental_index(database, next_database, docs, changed_urls)
    os.replace(temporary, corpus)
    os.replace(next_database, database)
    return stats


def _incremental_index(database: Path, target: Path, docs: list[dict],
                       changed_urls: set[str]) -> dict:
    """Replace only changed documents and embeddings in a copy of the live index."""
    shutil.copy2(database, target)
    connection = sqlite3.connect(target)
    pending: list[tuple[int, int, str]] = []
    next_group = int(connection.execute(
        "SELECT COALESCE(MAX(duplicate_group), 0) FROM documents"
    ).fetchone()[0])
    for doc in (item for item in docs if item["url"] in changed_urls):
        existing = connection.execute(
            "SELECT id,duplicate_group,is_canonical FROM documents WHERE url=?", (doc["url"],)
        ).fetchone()
        sanitized = sanitize_untrusted_text(doc["text"])
        if existing:
            document_id, group, canonical = existing
            connection.execute("DELETE FROM chunks WHERE document_id=?", (document_id,))
            connection.execute(
                "UPDATE documents SET final_url=?,title=?,category=?,tier=?,language=?,published_at=?,"
                "modified_at=?,fetched_at=?,injection_hits=?,removed_passages=?,word_count=? WHERE id=?",
                (doc["final_url"], doc["title"], doc["category"], doc["tier"], doc["language"],
                 doc.get("published_at"), doc.get("modified_at"), doc["fetched_at"],
                 len(sanitized.removed_passages), json.dumps(sanitized.removed_passages),
                 len(normalized_words(sanitized.text)), document_id),
            )
        else:
            next_group += 1
            cursor = connection.execute(
                "INSERT INTO documents(url,final_url,title,category,tier,language,published_at,modified_at,"
                "fetched_at,duplicate_group,is_canonical,injection_hits,removed_passages,word_count) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (doc["url"], doc["final_url"], doc["title"], doc["category"], doc["tier"],
                 doc["language"], doc.get("published_at"), doc.get("modified_at"), doc["fetched_at"],
                 next_group, 1, len(sanitized.removed_passages),
                 json.dumps(sanitized.removed_passages), len(normalized_words(sanitized.text))),
            )
            document_id = cursor.lastrowid
        pending.extend((document_id, position, text)
                       for position, text in enumerate(chunks(sanitized.text)))
    input_tokens, cost = _embed_and_insert_chunks(connection, pending)
    connection.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
    connection.commit()
    document_count = connection.execute("SELECT COUNT(*) FROM documents").fetchone()[0]
    chunk_count = connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    connection.close()
    stats = {"mode": "changed_documents", "documents": document_count, "chunks": chunk_count,
             "changed_documents": len(changed_urls), "embedded_chunks": len(pending),
             "index_input_tokens": input_tokens, "index_cost_usd": round(cost, 8)}
    database.with_name("index-stats.json").write_text(json.dumps(stats, indent=2))
    return stats


def _load_corpus(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def _read_json(path: Path, default: dict) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def freshness_status(state_path: Path = FRESHNESS_STATE_PATH,
                     log_path: Path = FRESHNESS_LOG_PATH) -> dict:
    state = _read_json(state_path, {})
    runs = []
    if log_path.exists():
        runs = [json.loads(line) for line in log_path.read_text().splitlines() if line.strip()]
    recent = [{key: value for key, value in run.items() if key != "checks"}
              for run in runs[-10:][::-1]]
    return {
        "last_refreshed": state.get("last_run"), "last_changed": state.get("last_changed"),
        "sources": state.get("sources", {}), "runs": recent,
        "recent_changes": [change for run in recent for change in run.get("changes", [])][:20],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, default=CORPUS_PATH)
    parser.add_argument("--database", type=Path, default=DB_PATH)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    load_dotenv()
    recorder = RunRecorder("stage", "freshness_refresh", {"code_or_model": "code"}).activate()
    try:
        report = refresh(args.corpus, args.database, args.apply, args.limit, args.force)
        recorder.finish(items={"checked": report["checked"], "changed": report["changed"]},
                        bytes_downloaded=report["bytes_downloaded"])
    except Exception:
        recorder.finish(status="failed")
        raise
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
