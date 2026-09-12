"""Stage 2 of the pipeline: crawl -> [dedup -> index] -> retrieve -> answer -> eval.

Turns `data/corpus.jsonl` into `data/index.sqlite3`, the only thing the answer path
reads at query time. Four decisions happen here, in this order, and each one is a
place where a mistake becomes an answer nobody can defend:

1. **Deduplication.** The same announcement lives on everstake.com, everstake.one, a
   Medium mirror and three press sites. Without grouping them, retrieval would return
   five copies of one claim and the model would read that as five independent
   confirmations. `duplicate_groups` groups them; `build` elects one canonical winner
   per group and marks the rest `is_canonical = 0`, so retrieval never sees them.
2. **Boilerplate removal.** Cookie banners and legal footers repeat on every page and
   would otherwise be the highest-frequency "fact" in the corpus.
3. **Injection sanitation.** Page text is untrusted input that will be pasted into a
   prompt; `app/security.sanitize_untrusted_text` strips instruction-like sentences
   and the count of what it removed is stored per document for the audit.
4. **Chunking and embedding.** Overlapping word windows, one 512-dimension
   `text-embedding-3-small` vector each, plus an FTS5 mirror for lexical search.

The output schema (`SCHEMA` below) is a public contract: `app/retrieval.py`,
`app/tools.py`, `app/server.py` and the tests all query these exact column names.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sqlite3
import struct
from collections import Counter
from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

from .accounting import RunRecorder
from .api_clients import embed
from .config import load_dotenv
from .security import sanitize_untrusted_text
from .consistency import consistency_pass

# --- Near-duplicate detection -------------------------------------------------
# All four thresholds were tuned by hand against this 280-page corpus (10 exact
# pairs, 2 near pairs in the shipped index); no held-out measurement backs the exact
# values, and the tests in tests/test_indexer.py are what pins them.

SIMHASH_BITS = 64  # width of the fingerprint; 64 is the usual simhash size and fits an int
SHINGLE_WORDS = 5  # 5-word shingles: long enough that common phrases do not collide,
#                    short enough that a reworded sentence still shares most shingles
NEAR_DUPLICATE_DISTANCE = 5  # Hamming distance for "same page, trivial edit"
TITLED_DUPLICATE_DISTANCE = 12  # looser radius, only trusted when the titles also agree
TITLE_SIMILARITY_FOR_LOOSE_MATCH = 0.70  # Jaccard over title words
# A short teaser shares most of its shingles with the full article it links to. This
# guard says the two documents must be within ~28% of each other in length before
# their simhash distance is allowed to merge them.
MIN_LENGTH_RATIO = 0.72

# --- Chunking -----------------------------------------------------------------
# 620 words is roughly 800 tokens: comfortably inside the embedding model's window,
# and large enough that a fact and its qualifier ("as of July 2026") stay together.
CHUNK_WORDS = 620
# 80 words of overlap so a fact straddling a boundary is whole in one of the two
# chunks. Both numbers are hand-set for this corpus, not measured.
CHUNK_OVERLAP_WORDS = 80
# A trailing window shorter than this is a fragment - a heading, a nav remnant - and
# embeds to a vector that matches everything weakly. Dropping it costs a little
# recall at the end of long pages and removes a class of junk hits.
MIN_CHUNK_WORDS = 30

# --- Boilerplate --------------------------------------------------------------
# Only long lines are candidates: short repeated lines ("Home", "Learn more") are
# navigation the extractor already dropped, and flagging them risks eating real
# sentences.
MIN_BOILERPLATE_LINE_CHARACTERS = 80
# A line has to appear in at least 8% of documents to count as a site template.
BOILERPLATE_DOCUMENT_FRACTION = 0.08
# KNOWN LIMITATION: the floor of 8 means a corpus of fewer than 8 documents can never
# produce boilerplate, no matter how identical the pages are (7 identical templates
# yield nothing; 8 yield the line). Harmless for the 280-document production corpus,
# and pinned by test_a_small_corpus_can_never_produce_boilerplate_because_of_the_floor_of_eight.
MIN_BOILERPLATE_DOCUMENTS = 8

# --- Embedding ----------------------------------------------------------------
# Chunks per embedding request. Batching is what keeps the index build to ~$0.0155;
# 64 is a hand-picked compromise between request count and payload size.
EMBEDDING_BATCH_SIZE = 64
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIMENSIONS = 512


def normalized_words(text: str) -> list[str]:
    """Tokenise for comparison, not for display: lowercase alphanumeric runs only.

    Everything that compares two pieces of text in this module goes through here, so
    the same page served with different markup, casing or punctuation reduces to the
    same token list. `[a-z0-9]+` after lowercasing means "Ever-stake's 2026" becomes
    ["ever", "stake", "s", "2026"] - splitting on the apostrophe is a deliberate
    simplification, since we only ever compare these tokens with each other.
    """
    return re.findall(r"[a-z0-9]+", text.lower())


def content_fingerprint(text: str) -> str:
    """Exact-duplicate key: a hash of the normalised word sequence.

    Catches the cheap half of deduplication - the identical page on two domains -
    without the O(n^2) simhash comparison. Word *order* is part of the key, so two
    pages with the same vocabulary in a different order are correctly kept apart.
    """
    return hashlib.sha256(" ".join(normalized_words(text)).encode()).hexdigest()


def simhash(text: str) -> int:
    """Near-duplicate key: a 64-bit locality-sensitive hash of the page's shingles.

    Exists because most duplicates in this corpus are not byte-identical - a mirror
    adds a publisher footer, a syndicated post drops a paragraph. Simhash gives a
    fingerprint whose Hamming distance tracks content similarity, so
    `duplicate_groups` can compare every pair cheaply with an XOR and a popcount.

    Each 5-word shingle is hashed to 64 bits (blake2b: fast, and stdlib, so no
    dependency); every bit votes +weight or -weight by shingle frequency, and the
    sign of each column becomes the output bit. Frequent shingles therefore dominate,
    which is what makes a small edit move only a few bits.
    """
    words = normalized_words(text)
    # max(1, ...) so a document shorter than one shingle still produces one feature
    # rather than an empty Counter and an all-ones hash.
    shingle_count = max(1, len(words) - (SHINGLE_WORDS - 1))
    shingles = Counter(" ".join(words[start:start + SHINGLE_WORDS]) for start in range(shingle_count))

    column_votes = [0] * SIMHASH_BITS
    for shingle, occurrences in shingles.items():
        shingle_bits = int.from_bytes(hashlib.blake2b(shingle.encode(), digest_size=8).digest(), "big")
        for bit in range(SIMHASH_BITS):
            column_votes[bit] += occurrences if shingle_bits & (1 << bit) else -occurrences
    # `>= 0` rather than `> 0` so a tied column is deterministic instead of depending
    # on iteration order.
    return sum(1 << bit for bit, votes in enumerate(column_votes) if votes >= 0)


def title_similarity(first_title: str, second_title: str) -> float:
    """Jaccard overlap of two titles' word sets - the tie-breaker for loose matches.

    Used only to make the wider simhash radius safe: two pages 12 bits apart could be
    unrelated, but 12 bits apart *and* sharing a title is a mirror. Jaccard rather
    than containment, so a long title does not automatically "contain" a short one.
    `max(1, ...)` makes two empty titles score 0.0 instead of dividing by zero.
    """
    first_words = set(normalized_words(first_title))
    second_words = set(normalized_words(second_title))
    return len(first_words & second_words) / max(1, len(first_words | second_words))


def duplicate_groups(docs: list[dict]) -> tuple[list[int], dict]:
    """Partition the corpus into duplicate groups; return one group id per document.

    Why union-find and not "mark the second copy": duplication is transitive here. A
    is the original, B adds a footer, C adds another sentence to B. A~B and B~C are
    both within the simhash radius while A~C may not be, and all three must still end
    up as one group so exactly one of them is cited.

    Returns (group id per document in input order, statistics dict). Group ids are
    1-based and assigned in first-appearance order so the numbering is stable and
    readable when someone opens the SQLite file by hand.
    """
    group_of_document = list(range(len(docs)))

    def find(index: int) -> int:
        # Path halving: point each node at its grandparent as we walk up. Keeps the
        # trees flat without the recursion of full path compression.
        while group_of_document[index] != index:
            group_of_document[index] = group_of_document[group_of_document[index]]
            index = group_of_document[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            # Always attach to the left (earlier) root, which is what makes the final
            # group numbering follow document order.
            group_of_document[right_root] = left_root

    fingerprints = [content_fingerprint(doc["text"]) for doc in docs]
    hashes = [simhash(doc["text"]) for doc in docs]
    word_counts = [len(normalized_words(doc["text"])) for doc in docs]

    exact_pairs = 0
    near_pairs = 0
    # O(n^2) over 280 documents is ~39k comparisons of two integers - a fraction of a
    # second, and far simpler to defend than a banded LSH index.
    for later in range(len(docs)):
        for earlier in range(later):
            if fingerprints[later] == fingerprints[earlier]:
                union(later, earlier)
                exact_pairs += 1
                # Already merged; the simhash test below could only re-count the pair.
                continue
            if _is_near_duplicate(later, earlier, docs, hashes, word_counts):
                union(later, earlier)
                near_pairs += 1

    numbered = _numbered_groups(find, len(docs))
    unique_groups = len(set(numbered))
    return numbered, {
        "exact_pairs": exact_pairs,
        "near_duplicate_pairs": near_pairs,
        "unique_groups": unique_groups,
        # Not "pairs found": after transitive merging, a cluster of three copies is
        # two duplicate documents, however many pairwise hits produced it.
        "duplicate_documents": len(docs) - unique_groups,
    }


def _is_near_duplicate(later: int, earlier: int, docs: list[dict],
                       hashes: list[int], word_counts: list[int]) -> bool:
    """Decide whether two non-identical documents are the same content.

    Two admissible reasons to merge, both gated on the length guard first:

    * within NEAR_DUPLICATE_DISTANCE bits - a trivial edit, no further evidence needed;
    * within the looser TITLED_DUPLICATE_DISTANCE *and* the titles agree - a mirror
      that reworded a paragraph. The title check is what keeps the wider radius from
      merging two different posts on the same topic.

    The length guard runs first and unconditionally, because a teaser and the full
    article it excerpts are genuinely similar in content and must still stay apart:
    merging them would let a 3-sentence card be elected canonical over the real page.
    """
    shorter = min(word_counts[later], word_counts[earlier])
    longer = max(word_counts[later], word_counts[earlier])
    length_ratio = shorter / max(1, longer)  # max(1, ...) guards two empty documents
    if length_ratio < MIN_LENGTH_RATIO:
        return False
    distance = (hashes[later] ^ hashes[earlier]).bit_count()
    if distance <= NEAR_DUPLICATE_DISTANCE:
        return True
    return (distance <= TITLED_DUPLICATE_DISTANCE
            and title_similarity(docs[later]["title"], docs[earlier]["title"])
            >= TITLE_SIMILARITY_FOR_LOOSE_MATCH)


def _numbered_groups(find: Callable[[int], int], document_count: int) -> list[int]:
    """Relabel union-find roots as 1, 2, 3... in order of first appearance."""
    number_of_root: dict[int, int] = {}
    numbered: list[int] = []
    for index in range(document_count):
        root = find(index)
        number_of_root.setdefault(root, len(number_of_root) + 1)
        numbered.append(number_of_root[root])
    return numbered


def chunks(text: str, size: int = CHUNK_WORDS, overlap: int = CHUNK_OVERLAP_WORDS) -> list[str]:
    """Split a document into overlapping word windows - the unit that gets embedded.

    Whole documents are too coarse to embed (one vector cannot represent a 4,000-word
    page) and sentences are too fine (a bare number loses the fact it belongs to).
    Windows of `size` words advancing by `size - overlap` are the middle ground, and
    the overlap means a fact split across a boundary survives intact in one window.

    Splitting on whitespace rather than tokenising: it needs no dependency, and the
    downstream consumer only needs "roughly this much text", not exact token counts.
    Note this normalises internal whitespace, since the words are re-joined with " ".

    KNOWN LIMITATION: no argument validation. `size == overlap` makes the stride zero
    and surfaces as a bare `range()` ValueError rather than a message naming the two
    arguments. Pinned by test_overlap_equal_to_size_raises_instead_of_looping_forever.
    """
    words = text.split()
    stride = size - overlap
    windows: list[str] = []
    for start in range(0, len(words), stride):
        window = words[start:start + size]
        # Drops the short tail of a document, and also drops everything for a page
        # shorter than MIN_CHUNK_WORDS - such a page contributes no chunks at all.
        if len(window) >= MIN_CHUNK_WORDS:
            windows.append(" ".join(window))
    return windows


def line_signature(line: str) -> str:
    """Normalise a line for template matching: collapsed whitespace, lowercased.

    A footer rendered with different indentation on two pages is the same footer, so
    the comparison key has to ignore layout. Kept separate from `normalized_words`
    because boilerplate detection needs the punctuation preserved - it matches whole
    rendered lines, not bags of words.
    """
    return re.sub(r"\s+", " ", line).strip().lower()


def repeated_boilerplate(docs: list[dict]) -> set[str]:
    """Find template lines repeated across many pages, counting once per document.

    Cookie notices, legal disclaimers and CTA blocks are on every page. Left in, they
    become the corpus's most frequent text: they dominate the near-duplicate signal,
    waste embedding budget, and can be retrieved as an "answer".

    "Once per document" is the load-bearing part - hence the set comprehension per
    document. Counting raw occurrences would let a single page that repeats its own
    banner twenty times nominate that banner as site-wide boilerplate and delete it
    from the corpus.
    """
    documents_containing: Counter[str] = Counter()
    for doc in docs:
        documents_containing.update({
            line_signature(line)
            for line in doc["text"].splitlines()
            if len(line_signature(line)) >= MIN_BOILERPLATE_LINE_CHARACTERS
        })
    threshold = max(MIN_BOILERPLATE_DOCUMENTS,
                    math.ceil(len(docs) * BOILERPLATE_DOCUMENT_FRACTION))
    return {line for line, count in documents_containing.items() if count >= threshold}


def pack(vector: list[float]) -> bytes:
    """Serialise an embedding to a float32 BLOB for the `chunks.embedding` column.

    float32, not float64: it halves the index size at a precision loss well below the
    noise floor of a cosine comparison. SQLite has no vector type and the corpus is
    small enough that a linear scan in Python beats adding an ANN dependency, so the
    storage format only has to round-trip through `retrieval.unpack`.
    """
    return struct.pack(f"<{len(vector)}f", *vector)


# Read by app/retrieval.py, app/tools.py, app/server.py and the tests. Column names
# here are a public contract; renaming one is a breaking change across four modules.
SCHEMA = """
CREATE TABLE documents(id INTEGER PRIMARY KEY, url TEXT UNIQUE, final_url TEXT, title TEXT, category TEXT,
 tier INTEGER, language TEXT, published_at TEXT, modified_at TEXT, fetched_at TEXT, duplicate_group INTEGER,
 is_canonical INTEGER, injection_hits INTEGER, removed_passages TEXT, word_count INTEGER,
 voice TEXT, speakers TEXT, attribution TEXT, claim_provenance TEXT, authority REAL,
 trust_penalty REAL, trust_penalty_reason TEXT, contradiction_count INTEGER, unverified_claims INTEGER);
CREATE TABLE chunks(id INTEGER PRIMARY KEY, document_id INTEGER, position INTEGER, text TEXT, embedding BLOB,
 FOREIGN KEY(document_id) REFERENCES documents(id));
CREATE TABLE facts(id INTEGER PRIMARY KEY, document_id INTEGER, fact_key TEXT, period TEXT, value TEXT,
 normalized_value TEXT, statement TEXT, provenance TEXT, attribution TEXT, first_party INTEGER,
 contradiction INTEGER, unverified INTEGER, FOREIGN KEY(document_id) REFERENCES documents(id));
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='porter unicode61');
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT);
"""
# Notes on the schema, for the parts that are not obvious from the DDL:
# - documents.is_canonical: 0 for the losers of a duplicate group. retrieval.py filters
#   on it, which is how one claim stops being cited as several.
# - documents.injection_hits / removed_passages: what the sanitiser stripped, kept so
#   an audit can show what the model was NOT shown.
# - chunks_fts is an *external content* FTS5 table (content='chunks'): it stores only
#   the inverted index and reads the text back from `chunks` by rowid, so the corpus
#   text is not duplicated. It must be rebuilt after inserts - see the 'rebuild'
#   command in `build` - because external-content tables are not auto-synced.
# - tokenize='porter unicode61': stemming, so a query for "delegators" matches
#   "delegator", and unicode folding for non-ASCII pages.

_INSERT_DOCUMENT_SQL = """
INSERT INTO documents(url, final_url, title, category, tier, language, published_at, modified_at,
                      fetched_at, duplicate_group, is_canonical, injection_hits, removed_passages, word_count,
                      voice, speakers, attribution, claim_provenance, authority, trust_penalty,
                      trust_penalty_reason, contradiction_count, unverified_claims)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
"""

_INSERT_CHUNK_SQL = "INSERT INTO chunks(document_id,position,text,embedding) VALUES(?,?,?,?)"


def build(corpus: Path, database: Path, record_accounting: bool = False) -> dict:
    """Build the whole SQLite index from the corpus, from scratch, every time.

    Rebuild-not-update is deliberate: dedup groups and boilerplate thresholds are
    global properties of the corpus, so adding one document can legitimately change
    which of two older documents is canonical. An incremental path would have to
    recompute both anyway, and at 280 documents / ~$0.0155 the full rebuild is
    cheaper than the bug surface. `app/refresh.py` relies on this being idempotent.

    Returns the stats dict, which is also written to `index-stats.json` and stored
    row-by-row in the `metadata` table so a deployed index can describe itself.
    """
    docs = [json.loads(line) for line in corpus.read_text().splitlines() if line.strip()]
    dedup_run = _stage_recorder("dedup", record_accounting, "code")
    facts, consistency_stats = consistency_pass(docs)
    groups, dedup_stats = duplicate_groups(docs)
    if dedup_run:
        dedup_run.finish(items={"documents": len(docs), "unique_groups": dedup_stats["unique_groups"]})

    chunk_run = _stage_recorder("chunk_index", record_accounting, "code")
    boilerplate = repeated_boilerplate(docs)

    connection = _fresh_database(database)
    canonical_index = _canonical_document_per_group(docs, groups)
    pending_chunks, cleaning_stats = _insert_documents(
        connection, docs, groups, canonical_index, boilerplate
    )
    _insert_facts(connection, facts)
    if chunk_run:
        chunk_run.finish(items={"documents": len(docs), "chunks": len(pending_chunks)})

    fact_run = _stage_recorder("fact_extraction", record_accounting, "code")
    literal_fact_chunks = sum(bool(re.search(r"(?:\$|\b\d[\d,.]*\s*(?:%|billion|million|bps|apy|apr)?)",
                                             text, re.I)) for _doc, _position, text in pending_chunks)
    if fact_run:
        fact_run.finish(items={"chunks_scanned": len(pending_chunks),
                               "literal_fact_chunks": literal_fact_chunks})

    embedding_run = _stage_recorder("embeddings", record_accounting, "model")
    embedding_tokens, embedding_cost = _embed_and_insert_chunks(connection, pending_chunks)
    if embedding_run:
        embedding_run.finish(items={"chunks": len(pending_chunks), "requests": math.ceil(
            len(pending_chunks) / EMBEDDING_BATCH_SIZE)})
    # External-content FTS5 does not populate itself from the INSERTs above; without
    # this the lexical half of hybrid retrieval silently returns nothing.
    connection.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")

    # Key order here is the key order in index-stats.json, which REPORT.md quotes.
    stats = {
        "built_at": datetime.now(timezone.utc).isoformat(),
        "documents": len(docs),
        "chunks": len(pending_chunks),
        **dedup_stats,
        "documents_with_instruction_like_text": cleaning_stats["injection_documents"],
        "boilerplate_signatures": len(boilerplate),
        "boilerplate_lines_removed": cleaning_stats["boilerplate_lines_removed"],
        "literal_fact_chunks": literal_fact_chunks,
        **consistency_stats,
        "voices": {voice: sum(doc.get("voice") == voice for doc in docs) for voice in
                   ("first_party_channel", "employee_on_third_party", "third_party")},
        "embedding_model": EMBEDDING_MODEL,
        "embedding_dimensions": EMBEDDING_DIMENSIONS,
        "index_input_tokens": embedding_tokens,
        # 8 decimal places because a single index build costs ~$0.0155 and the
        # assignment has a $5 cap to account for.
        "index_cost_usd": round(embedding_cost, 8),
    }
    for key, value in stats.items():
        connection.execute("INSERT INTO metadata(key,value) VALUES(?,?)", (key, json.dumps(value)))
    connection.commit()
    connection.close()
    database.with_name("index-stats.json").write_text(json.dumps(stats, indent=2))
    return stats


def _stage_recorder(name: str, enabled: bool, code_or_model: str) -> RunRecorder | None:
    """Start one CLI-only stage recorder without polluting unit-test fixtures."""
    if not enabled:
        return None
    return RunRecorder("stage", name, {"code_or_model": code_or_model}).activate()


def _fresh_database(database: Path) -> sqlite3.Connection:
    """Delete any existing index and create an empty one with the current schema.

    Deleting rather than dropping tables: it guarantees the file on disk matches
    SCHEMA even after a schema change, and leaves no stale FTS5 shadow tables.
    """
    if database.exists():
        database.unlink()
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database)
    connection.executescript(SCHEMA)
    return connection


def _canonical_document_per_group(docs: list[dict], groups: list[int]) -> dict[int, int]:
    """Elect the one document per duplicate group that retrieval is allowed to see.

    Within a duplicate group, current canonical-domain, tier-1, recently modified
    documents win. Ordering of the sort key is the policy, most important first:

    1. tier 1 - a hand-curated authoritative source beats a mirror outright;
    2. the live domain - everstake.com and NOT everstake.one, because everstake.one is
       the legacy domain the company migrated away from and its copies are frozen;
    3. the newest date the publisher claims, falling back to published_at then "",
       so a document with no date at all loses to any document that has one.

    Ties resolve to `max`'s first-best-wins, i.e. the earliest document in corpus
    order, which keeps the election deterministic across rebuilds.
    """
    winners: dict[int, int] = {}
    for group in set(groups):
        members = [index for index, value in enumerate(groups) if value == group]
        winners[group] = max(members, key=lambda index: (
            docs[index]["tier"] == 1,
            "everstake.com" in docs[index]["final_url"]
            and "everstake.one" not in docs[index]["final_url"],
            docs[index].get("modified_at") or docs[index].get("published_at") or "",
        ))
    return winners


def _insert_documents(connection: sqlite3.Connection, docs: list[dict], groups: list[int],
                      canonical_index: dict[int, int],
                      boilerplate: set[str]) -> tuple[list[tuple[int, int, str]], dict[str, int]]:
    """Clean, sanitise and insert every document; return the chunks awaiting embedding.

    Chunks are collected rather than inserted here because embedding is a batched
    network call - see `_embed_and_insert_chunks`. Each entry is
    (document row id, position within the document, chunk text).

    Order of operations matters: boilerplate lines are removed *before* injection
    sanitation, so a template line does not fragment the sentence context the
    sanitiser needs, and both run before chunking so the removed text never reaches
    an embedding or a prompt.
    """
    pending_chunks: list[tuple[int, int, str]] = []
    injection_documents = 0
    boilerplate_lines_removed = 0
    for index, doc in enumerate(docs):
        lines = doc["text"].splitlines()
        kept_lines = [line for line in lines if line_signature(line) not in boilerplate]
        boilerplate_lines_removed += len(lines) - len(kept_lines)
        sanitized = sanitize_untrusted_text("\n".join(kept_lines))
        if sanitized.removed_passages:
            injection_documents += 1
        cursor = connection.execute(_INSERT_DOCUMENT_SQL, (
            doc["url"], doc["final_url"], doc["title"], doc["category"], doc["tier"], doc["language"],
            # .get() for the dates only: a page may legitimately declare neither, but
            # a corpus row missing url/title/tier is a crawler bug and should raise.
            doc.get("published_at"), doc.get("modified_at"), doc["fetched_at"],
            groups[index],
            int(canonical_index[groups[index]] == index),
            len(sanitized.removed_passages), json.dumps(sanitized.removed_passages),
            # Word count of the *sanitised* text, so the stored length matches what
            # is actually retrievable rather than what was crawled.
            len(normalized_words(sanitized.text)),
            doc.get("voice"), json.dumps(doc.get("speakers", [])), doc.get("attribution"),
            doc.get("provenance"), doc.get("authority", 1.0 if doc.get("tier") == 1 else 0.82),
            doc.get("trust_penalty", 1.0), doc.get("trust_penalty_reason"),
            doc.get("contradiction_count", 0), doc.get("unverified_claims", 0),
        ))
        for position, chunk_text in enumerate(chunks(sanitized.text)):
            pending_chunks.append((cursor.lastrowid, position, chunk_text))
    return pending_chunks, {
        "injection_documents": injection_documents,
        "boilerplate_lines_removed": boilerplate_lines_removed,
    }


def _insert_facts(connection: sqlite3.Connection, facts: list[dict]) -> None:
    """Persist attribution and consistency verdicts next to the searchable evidence."""
    for fact in facts:
        connection.execute(
            "INSERT INTO facts(document_id,fact_key,period,value,normalized_value,statement,provenance,"
            "attribution,first_party,contradiction,unverified) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (fact["document_index"] + 1, fact["key"], fact["period"], fact["value"],
             fact["normalized_value"], fact["statement"], fact["provenance"], fact["attribution"],
             int(fact["first_party"]), int(fact.get("contradiction", False)), int(fact["unverified"])),
        )


def _embed_and_insert_chunks(connection: sqlite3.Connection,
                             pending_chunks: list[tuple[int, int, str]]) -> tuple[int, float]:
    """Embed chunks in batches and store them; return (input tokens, cost in USD).

    Batched because the per-request overhead, not the token count, dominates the wall
    clock for ~1,075 short chunks. Usage is accumulated rather than read back from the
    index afterwards so the reported cost covers every call actually made, including
    a batch whose rows were later rolled back.
    """
    total_tokens = 0
    total_cost = 0.0
    for start in range(0, len(pending_chunks), EMBEDDING_BATCH_SIZE):
        batch = pending_chunks[start:start + EMBEDDING_BATCH_SIZE]
        vectors, usage = embed([chunk_text for _document_id, _position, chunk_text in batch],
                               "index_embedding")
        total_tokens += usage["input_tokens"]
        total_cost += usage["cost_usd"]
        connection.executemany(_INSERT_CHUNK_SQL, [
            (document_id, position, chunk_text, pack(vector))
            for (document_id, position, chunk_text), vector in zip(batch, vectors)
        ])
        # Progress line: the full build takes minutes and is run by hand.
        done = min(start + len(batch), len(pending_chunks))
        print(f"Embedded {done}/{len(pending_chunks)}", flush=True)
    return total_tokens, total_cost


def main() -> None:
    """CLI entry point (`make index`). Prints the build statistics as JSON."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--database", type=Path, required=True)
    args = parser.parse_args()
    # Needed before build(): embed() reads OPENAI_API_KEY from the environment.
    load_dotenv()
    print(json.dumps(build(args.corpus, args.database, record_accounting=True), indent=2))


if __name__ == "__main__":
    main()
