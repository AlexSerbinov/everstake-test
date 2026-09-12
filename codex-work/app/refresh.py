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


def refresh(corpus: Path, database: Path, apply: bool = False, limit: int = 0) -> dict:
    """Recrawl known URLs, snapshot changes by hash, and rebuild only when changed."""
    docs = [json.loads(line) for line in corpus.read_text().splitlines() if line.strip()]
    fetcher = PoliteFetcher()
    changed: list[dict] = []
    checked = 0
    started = datetime.now(timezone.utc)
    for index, doc in enumerate(docs):
        if limit and checked >= limit:
            break
        host = urllib.parse.urlparse(doc["url"]).hostname
        if host not in ALLOWED_HOSTS or not host or "everstake" not in host:
            continue
        checked += 1
        result = fetcher.get(doc["url"])
        if not result:
            continue
        status, content_type, body, final_url = result
        if "html" not in content_type:
            continue
        title, text, published, modified, _ = extract_html(body)
        new_hash = hashlib.sha256(text.encode()).hexdigest()
        if new_hash == doc.get("sha256"):
            continue
        old_hash = doc.get("sha256")
        changed.append({"url": doc["url"], "old_sha256": old_hash, "new_sha256": new_hash})
        snapshot_dir = corpus.parent / "snapshots"
        snapshot_dir.mkdir(parents=True, exist_ok=True)
        snapshot = {"captured_at": datetime.now(timezone.utc).isoformat(), "previous_sha256": old_hash, "document": doc}
        (snapshot_dir / f"{old_hash or 'unknown'}.json").write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")))
        docs[index] = {**doc, "final_url": canonicalize(final_url), "title": title[:300], "text": text, "published_at": published or doc.get("published_at"), "modified_at": modified or doc.get("modified_at"), "fetched_at": datetime.now(timezone.utc).isoformat(), "status": status, "content_type": content_type, "sha256": new_hash}
    report = {
        "started_at": started.isoformat(),
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "checked": checked,
        "changed": len(changed),
        "changes": changed,
        "applied": bool(apply and changed),
    }
    if apply and changed:
        temporary = corpus.with_suffix(".next.jsonl")
        temporary.write_text("".join(json.dumps(doc, ensure_ascii=False) + "\n" for doc in docs))
        os.replace(temporary, corpus)
        report["index"] = build(corpus, database)
    corpus.with_name("refresh-report.json").write_text(json.dumps(report, indent=2))
    return report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, default=CORPUS_PATH)
    parser.add_argument("--database", type=Path, default=DB_PATH)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()
    load_dotenv()
    print(json.dumps(refresh(args.corpus, args.database, args.apply, args.limit), indent=2))


if __name__ == "__main__":
    main()
