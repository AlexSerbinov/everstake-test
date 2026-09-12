from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DB_PATH = Path(os.getenv("EVERSTAKE_DB", DATA_DIR / "index.sqlite3"))
CORPUS_PATH = Path(os.getenv("EVERSTAKE_CORPUS", DATA_DIR / "corpus.jsonl"))
COST_LOG = Path(os.getenv("EVERSTAKE_COST_LOG", DATA_DIR / "run-costs.jsonl"))
AUDIT_LOG = Path(os.getenv("EVERSTAKE_AUDIT_LOG", DB_PATH.parent / "answer-audit.jsonl"))
AUDIT_KEY = Path(os.getenv("EVERSTAKE_AUDIT_KEY", DB_PATH.parent / "audit-ed25519.key"))
PORT = int(os.getenv("PORT", "4321"))


def load_dotenv(path: Path = ROOT / ".env") -> None:
    """Load a tiny KEY=VALUE env file without adding a dependency."""
    if not path.exists():
        return
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
