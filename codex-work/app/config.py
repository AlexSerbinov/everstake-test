"""Filesystem layout and process configuration for the whole pipeline.

Sits before every stage (crawl -> dedup/index -> retrieve -> answer -> eval): each
stage imports its paths from here rather than hard-coding them, so a deployment can
relocate the data volume with environment variables and nothing else. If a path here
were wrong the crawler would write a corpus the indexer never reads, and the server
would answer from an index nobody rebuilds -- the failure is silent, not a crash.

Every path is overridable by an environment variable so the systemd unit on the
deployed host can point at a persistent volume while tests and local runs stay inside
the repository. `load_dotenv` below fills those variables from `.env` when present.
"""

from __future__ import annotations

import os
from pathlib import Path

# `parents[1]` = the codex-work package root (this file is <root>/app/config.py).
# Resolved from __file__ rather than the working directory because the Makefile,
# systemd and the test runner all invoke the package from different directories.
ROOT: Path = Path(__file__).resolve().parents[1]
DATA_DIR: Path = ROOT / "data"

# The SQLite index the retrieval stage queries: documents + chunks + FTS5 table.
DB_PATH: Path = Path(os.getenv("EVERSTAKE_DB", DATA_DIR / "index.sqlite3"))

# One JSON document per line, written by the crawler and read by the indexer. JSONL
# rather than a single JSON array so a partial crawl is still a readable file.
CORPUS_PATH: Path = Path(os.getenv("EVERSTAKE_CORPUS", DATA_DIR / "corpus.jsonl"))

# Append-only spend ledger: every embedding and generation call adds a line. This is
# what backs the cost figures in REPORT.md and the $5 assignment budget check.
COST_LOG: Path = Path(os.getenv("EVERSTAKE_COST_LOG", DATA_DIR / "run-costs.jsonl"))

# Unified resource-and-provider accounting. Unlike COST_LOG (the historical paid-call
# ledger), this contains complete stage and question runs: wall/CPU/RSS, work units,
# bytes, provider usage and the per-question receipt shown in the UI.
ACCOUNTING_LOG: Path = Path(os.getenv("EVERSTAKE_ACCOUNTING_LOG", DATA_DIR / "accounting.jsonl"))
COST_REPORT_PATH: Path = Path(os.getenv("EVERSTAKE_COST_REPORT", DATA_DIR / "cost-report.json"))

# Operator-owned freshness policy and runtime state. The policy is shipped with the
# application; state and the append-only change log live beside the mutable corpus.
FRESHNESS_POLICY_PATH: Path = Path(
    os.getenv("EVERSTAKE_FRESHNESS_POLICY", DATA_DIR / "freshness-policy.json")
)
FRESHNESS_STATE_PATH: Path = Path(
    os.getenv("EVERSTAKE_FRESHNESS_STATE", DB_PATH.parent / "freshness-state.json")
)
FRESHNESS_LOG_PATH: Path = Path(
    os.getenv("EVERSTAKE_FRESHNESS_LOG", DB_PATH.parent / "freshness-changes.jsonl")
)

# Prices copied on this date. A run stores the applicable row with its usage so later
# price changes cannot rewrite history. `cached_input` intentionally equals ordinary
# input: the supplied Gemini prices do not declare a separate cache rate.
PRICE_TABLE_COPIED_AT = "2026-09-12"
PRICE_TABLE: dict[str, dict[str, object]] = {
    "text-embedding-3-small": {
        "provider": "OpenAI", "input_per_million": 0.02,
        "cached_input_per_million": 0.02, "output_per_million": 0.0,
    },
    "gemini-3.8-flash": {
        "provider": "Google", "input_per_million": 0.75,
        "cached_input_per_million": 0.75, "output_per_million": 3.75,
        "note": "Introductory price through 2026-12-31",
    },
    "gemini-3.5-flash-lite": {
        "provider": "Google", "input_per_million": 0.30,
        "cached_input_per_million": 0.30, "output_per_million": 2.50,
    },
}

# Audit chain and its signing key live next to the database, not next to the source,
# because on the deployed host only the data volume is persistent and writable.
AUDIT_LOG: Path = Path(os.getenv("EVERSTAKE_AUDIT_LOG", DB_PATH.parent / "answer-audit.jsonl"))
AUDIT_KEY: Path = Path(os.getenv("EVERSTAKE_SIGNING_PATH", DB_PATH.parent / "audit-ed25519.key"))

# 4321 is an arbitrary high port picked to avoid colliding with anything common on
# the dev machine; the reverse proxy on the deployed host maps 443 onto it.
PORT: int = int(os.getenv("PORT", "4321"))


def load_dotenv(path: Path = ROOT / ".env") -> None:
    """Load a tiny KEY=VALUE env file without adding a dependency.

    The assignment caps dependencies at beautifulsoup4 + cryptography, so
    `python-dotenv` is not available. This parser is deliberately minimal: no
    interpolation, no `export` prefix, no multi-line values -- the only secrets it has
    to carry are two API keys.

    Uses `setdefault`, so a variable already exported in the shell or by systemd wins
    over the file. That ordering matters on the deployed host, where the real keys
    come from the unit file and `.env` may hold stale development values.
    """
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        # Skip blanks, comments, and anything without a separator rather than raising:
        # a malformed line should not stop the server from booting.
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        # split("=", 1) so a value containing "=" (base64 padding, query strings)
        # survives intact. Surrounding quotes are stripped because editors add them.
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
