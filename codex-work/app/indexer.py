from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sqlite3
import struct
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .api_clients import embed
from .config import load_dotenv
from .security import sanitize_untrusted_text


def normalized_words(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def content_fingerprint(text: str) -> str:
    return hashlib.sha256(" ".join(normalized_words(text)).encode()).hexdigest()


def simhash(text: str) -> int:
    words = normalized_words(text)
    features = Counter(" ".join(words[i:i + 5]) for i in range(max(1, len(words) - 4)))
    vector = [0] * 64
    for feature, weight in features.items():
        bits = int.from_bytes(hashlib.blake2b(feature.encode(), digest_size=8).digest(), "big")
        for bit in range(64):
            vector[bit] += weight if bits & (1 << bit) else -weight
    return sum(1 << bit for bit, value in enumerate(vector) if value >= 0)


def title_similarity(a: str, b: str) -> float:
    left, right = set(normalized_words(a)), set(normalized_words(b))
    return len(left & right) / max(1, len(left | right))


def duplicate_groups(docs: list[dict]) -> tuple[list[int], dict]:
    parent = list(range(len(docs)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    fingerprints = [content_fingerprint(doc["text"]) for doc in docs]
    hashes = [simhash(doc["text"]) for doc in docs]
    lengths = [len(normalized_words(doc["text"])) for doc in docs]
    exact = near = 0
    for i in range(len(docs)):
        for j in range(i):
            if fingerprints[i] == fingerprints[j]:
                union(i, j)
                exact += 1
                continue
            ratio = min(lengths[i], lengths[j]) / max(1, max(lengths[i], lengths[j]))
            distance = (hashes[i] ^ hashes[j]).bit_count()
            if ratio >= 0.72 and (distance <= 5 or (distance <= 12 and title_similarity(docs[i]["title"], docs[j]["title"]) >= 0.70)):
                union(i, j)
                near += 1
    roots: dict[int, int] = {}
    groups: list[int] = []
    for i in range(len(docs)):
        root = find(i)
        roots.setdefault(root, len(roots) + 1)
        groups.append(roots[root])
    return groups, {"exact_pairs": exact, "near_duplicate_pairs": near, "unique_groups": len(set(groups)), "duplicate_documents": len(docs) - len(set(groups))}


def chunks(text: str, size: int = 620, overlap: int = 80) -> list[str]:
    words = text.split()
    return [" ".join(words[start:start + size]) for start in range(0, len(words), size - overlap) if len(words[start:start + size]) >= 30]


def line_signature(line: str) -> str:
    return re.sub(r"\s+", " ", line).strip().lower()


def repeated_boilerplate(docs: list[dict]) -> set[str]:
    """Find template lines repeated across many pages, counting once per document."""
    counts: Counter[str] = Counter()
    for doc in docs:
        counts.update({line_signature(line) for line in doc["text"].splitlines() if len(line_signature(line)) >= 80})
    threshold = max(8, math.ceil(len(docs) * 0.08))
    return {line for line, count in counts.items() if count >= threshold}


def pack(vector: list[float]) -> bytes:
    return struct.pack(f"<{len(vector)}f", *vector)


SCHEMA = """
CREATE TABLE documents(id INTEGER PRIMARY KEY, url TEXT UNIQUE, final_url TEXT, title TEXT, category TEXT,
 tier INTEGER, language TEXT, published_at TEXT, modified_at TEXT, fetched_at TEXT, duplicate_group INTEGER,
 is_canonical INTEGER, injection_hits INTEGER, removed_passages TEXT, word_count INTEGER);
CREATE TABLE chunks(id INTEGER PRIMARY KEY, document_id INTEGER, position INTEGER, text TEXT, embedding BLOB,
 FOREIGN KEY(document_id) REFERENCES documents(id));
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='porter unicode61');
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);
"""


def build(corpus: Path, database: Path) -> dict:
    docs = [json.loads(line) for line in corpus.read_text().splitlines() if line.strip()]
    groups, dedup_stats = duplicate_groups(docs)
    boilerplate = repeated_boilerplate(docs)
    if database.exists():
        database.unlink()
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database)
    connection.executescript(SCHEMA)
    all_chunks: list[tuple[int, int, str]] = []
    injection_docs = 0
    boilerplate_lines_removed = 0
    # Within a duplicate group, current canonical-domain, tier-1, recently modified documents win.
    winners: dict[int, int] = {}
    for group in set(groups):
        candidates = [i for i, value in enumerate(groups) if value == group]
        winners[group] = max(candidates, key=lambda i: (
            docs[i]["tier"] == 1,
            "everstake.com" in docs[i]["final_url"] and "everstake.one" not in docs[i]["final_url"],
            docs[i].get("modified_at") or docs[i].get("published_at") or "",
        ))
    for idx, doc in enumerate(docs):
        filtered_lines = [line for line in doc["text"].splitlines() if line_signature(line) not in boilerplate]
        boilerplate_lines_removed += len(doc["text"].splitlines()) - len(filtered_lines)
        sanitized = sanitize_untrusted_text("\n".join(filtered_lines))
        if sanitized.removed_passages:
            injection_docs += 1
        cursor = connection.execute(
            "INSERT INTO documents(url,final_url,title,category,tier,language,published_at,modified_at,fetched_at,duplicate_group,is_canonical,injection_hits,removed_passages,word_count) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (doc["url"], doc["final_url"], doc["title"], doc["category"], doc["tier"], doc["language"],
             doc.get("published_at"), doc.get("modified_at"), doc["fetched_at"], groups[idx], int(winners[groups[idx]] == idx),
             len(sanitized.removed_passages), json.dumps(sanitized.removed_passages), len(normalized_words(sanitized.text))),
        )
        for position, text in enumerate(chunks(sanitized.text)):
            all_chunks.append((cursor.lastrowid, position, text))
    embedding_tokens = 0
    embedding_cost = 0.0
    for start in range(0, len(all_chunks), 64):
        batch = all_chunks[start:start + 64]
        vectors, usage = embed([item[2] for item in batch], "index_embedding")
        embedding_tokens += usage["input_tokens"]
        embedding_cost += usage["cost_usd"]
        connection.executemany("INSERT INTO chunks(document_id,position,text,embedding) VALUES(?,?,?,?)", [
            (doc_id, position, text, pack(vector)) for (doc_id, position, text), vector in zip(batch, vectors)
        ])
        print(f"Embedded {min(start + len(batch), len(all_chunks))}/{len(all_chunks)}", flush=True)
    connection.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
    stats = {
        "built_at": datetime.now(timezone.utc).isoformat(), "documents": len(docs), "chunks": len(all_chunks),
        **dedup_stats, "documents_with_instruction_like_text": injection_docs,
        "boilerplate_signatures": len(boilerplate), "boilerplate_lines_removed": boilerplate_lines_removed,
        "embedding_model": "text-embedding-3-small", "embedding_dimensions": 512,
        "index_input_tokens": embedding_tokens, "index_cost_usd": round(embedding_cost, 8),
    }
    for key, value in stats.items():
        connection.execute("INSERT INTO metadata(key,value) VALUES(?,?)", (key, json.dumps(value)))
    connection.commit()
    connection.close()
    database.with_name("index-stats.json").write_text(json.dumps(stats, indent=2))
    return stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--database", type=Path, required=True)
    args = parser.parse_args()
    load_dotenv()
    print(json.dumps(build(args.corpus, args.database), indent=2))


if __name__ == "__main__":
    main()
