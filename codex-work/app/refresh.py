"""Freshness job: recrawl the known corpus URLs and rebuild the index only if something changed.

Pipeline position: a scheduled loop back to the start of the pipeline — refresh → crawl →
extract → hash-compare → (only on change) reindex. REPORT.md describes it running weekly
from a systemd timer. It is the answer to "your corpus is a frozen snapshot, so how does
it stay true?": mutable facts are read live through MCP at question time, and the durable
snapshot is re-verified on a schedule.

Two properties make it safe to run unattended:

* **Change is detected by content hash, not by fetch.** A page served again with a new
  banner ad but the same extracted text produces the same SHA-256 and is skipped, so a
  weekly run normally costs nothing in embeddings.
* **Nothing is replaced in place.** Both the corpus and the index are written to a `.next`
  file and moved over the live one with `os.replace`, which is atomic on POSIX. A crash
  mid-rebuild therefore leaves the old, working index serving traffic rather than a
  half-written one.

Default is a dry run: without `--apply` it reports what changed and writes nothing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from .config import CORPUS_PATH, DB_PATH, load_dotenv
from .crawler import ALLOWED_HOSTS, PoliteFetcher, canonicalize, extract_html
from .indexer import build

# Titles are stored truncated so one pathological <title> cannot dominate a corpus row.
# Hand-tuned; matches nothing else in the codebase, no measurement backs it.
TITLE_MAX_CHARS = 300


def refresh(corpus: Path, database: Path, apply: bool = False, limit: int = 0) -> dict:
    """Recrawl known URLs, snapshot what changed, and rebuild the index if asked.

    Returns the report it also writes to `refresh-report.json`, so a caller (a timer, a
    test, the CLI) can act on the outcome without re-reading the file.
    """
    docs = _load_corpus(corpus)
    fetcher = PoliteFetcher()
    changed: list[dict] = []
    checked = 0
    started = datetime.now(timezone.utc)
    for index, doc in enumerate(docs):
        if limit and checked >= limit:
            break
        if not _is_refreshable(doc["url"]):
            continue
        checked += 1
        refreshed = _refetch_document(fetcher, doc)
        if refreshed is None:
            continue
        updated_doc, new_hash = refreshed
        _snapshot_previous_version(corpus, doc)
        changed.append({"url": doc["url"], "old_sha256": doc.get("sha256"), "new_sha256": new_hash})
        docs[index] = updated_doc

    report = _build_report(started, checked, changed, apply)
    if apply and changed:
        _apply_changes(corpus, database, docs, report)
    corpus.with_name("refresh-report.json").write_text(json.dumps(report, indent=2))
    return report


def _load_corpus(corpus: Path) -> list[dict]:
    """Read the JSONL corpus, ignoring blank lines.

    Blank lines are tolerated because the corpus is written by appending and a truncated
    final newline is normal; a blank line is not a corrupt document.
    """
    return [json.loads(line) for line in corpus.read_text().splitlines() if line.strip()]


def _is_refreshable(url: str) -> bool:
    """Whether this corpus URL may be recrawled.

    Two independent checks, both required. `ALLOWED_HOSTS` is the crawler's own allowlist
    — the refresher must not widen it. The `"everstake" in host` test then narrows it
    further to first-party pages: third-party coverage in the corpus is a dated snapshot
    of what someone said at the time, and silently rewriting it with today's version of
    that page would change the historical record the synthesis answers rely on.
    """
    host = urllib.parse.urlparse(url).hostname
    return bool(host) and host in ALLOWED_HOSTS and "everstake" in host


def _refetch_document(fetcher: PoliteFetcher, doc: dict) -> tuple[dict, str] | None:
    """Fetch one URL and return (updated document, new hash), or None if nothing to do.

    None covers three different "skip" cases that all mean the same thing to the caller:
    the fetch failed or robots refused it, the response was not HTML, or the extracted
    text hashes to exactly what is already stored.
    """
    result = fetcher.get(doc["url"])
    if not result:
        return None
    status, content_type, body, final_url = result
    if "html" not in content_type:
        return None
    title, text, published, modified, _ = extract_html(body)
    # Hash the *extracted* text, not the raw HTML: markup, ad slots and CSRF tokens
    # change on nearly every request, so hashing the response body would report every
    # page as changed every week and rebuild the index for nothing.
    new_hash = hashlib.sha256(text.encode()).hexdigest()
    if new_hash == doc.get("sha256"):
        return None
    updated = {
        **doc,
        "final_url": canonicalize(final_url),
        "title": title[:TITLE_MAX_CHARS],
        "text": text,
        # Keep the stored date when the refreshed page no longer exposes one: a page that
        # drops its metadata has not become undated, and losing the date would break the
        # year-straddle contract in agent.py for anything citing it.
        "published_at": published or doc.get("published_at"),
        "modified_at": modified or doc.get("modified_at"),
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "content_type": content_type,
        "sha256": new_hash,
    }
    return updated, new_hash


def _snapshot_previous_version(corpus: Path, doc: dict) -> None:
    """Archive the version being replaced, keyed by its content hash.

    Written before the replacement so a page's history is recoverable: an audit record
    from last month cites a `content_sha256`, and without this the text behind that hash
    would be gone the moment the page was updated. Keying the file by the old hash makes
    it directly addressable from that citation.
    """
    old_hash = doc.get("sha256")
    snapshot_dir = corpus.parent / "snapshots"
    snapshot_dir.mkdir(parents=True, exist_ok=True)
    snapshot = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "previous_sha256": old_hash,
        "document": doc,
    }
    # 'unknown' for a document that never had a hash (a pre-hash corpus entry). Such a
    # write can overwrite a previous 'unknown' snapshot; acceptable, because the case
    # only arises for legacy rows that the first refresh then gives a real hash.
    (snapshot_dir / f"{old_hash or 'unknown'}.json").write_text(
        json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))
    )


def _build_report(started: datetime, checked: int, changed: list[dict], apply: bool) -> dict:
    """The run summary, written to disk and returned.

    `applied` is `apply and changed` rather than just `apply`: a run asked to apply that
    found nothing changed did not apply anything, and reporting otherwise would suggest
    the index was rebuilt when it was not.
    """
    return {
        "started_at": started.isoformat(),
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "checked": checked,
        "changed": len(changed),
        "changes": changed,
        "applied": bool(apply and changed),
    }


def _apply_changes(corpus: Path, database: Path, docs: list[dict], report: dict) -> None:
    """Swap in the new corpus and the index rebuilt from it, atomically.

    Order matters: the corpus is replaced first, then the index is built *from the file
    just written*, then the index is swapped. Building from the in-memory list instead
    would let the two artefacts disagree if the write failed. `os.replace` is used rather
    than `write_text` over the live file so a reader mid-request never sees a partial file.
    Adds the indexer's own statistics to the report under `index`.
    """
    temporary = corpus.with_suffix(".next.jsonl")
    temporary.write_text("".join(json.dumps(doc, ensure_ascii=False) + "\n" for doc in docs))
    os.replace(temporary, corpus)
    next_database = database.with_suffix(".next.sqlite3")
    report["index"] = build(corpus, next_database)
    os.replace(next_database, database)


def main() -> None:
    """CLI entry point: `python -m app.refresh [--apply] [--limit N]`.

    `--limit` caps how many documents are *checked* (not how many changed), which is what
    makes a quick smoke test on a live corpus possible without a full crawl.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, default=CORPUS_PATH)
    parser.add_argument("--database", type=Path, default=DB_PATH)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    # Needed before any rebuild: `build` embeds new chunks and that requires the API key.
    load_dotenv()
    print(json.dumps(refresh(args.corpus, args.database, args.apply, args.limit), indent=2))


if __name__ == "__main__":
    main()
