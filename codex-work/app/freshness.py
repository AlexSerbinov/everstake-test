"""Freshness policy, measured-unit calculator, and source classification.

The calculator is intentionally deterministic and shared by the API and tests. Its
unit costs come from completed accounting rows; only workload inputs (how frequently
documents change) are explicit planning assumptions.
"""

from __future__ import annotations

import json
import math
from collections import Counter
from pathlib import Path
from typing import Any

from .config import (
    ACCOUNTING_LOG, CORPUS_PATH, COST_REPORT_PATH, FRESHNESS_POLICY_PATH,
    FRESHNESS_STATE_PATH, PRICE_TABLE_COPIED_AT,
)

SOURCE_TYPES = (
    "live_pages", "blog", "docs", "reports_events", "github", "video", "third_party",
)
SOURCE_LABELS = {
    "live_pages": "Live pages", "blog": "Blog", "docs": "Docs",
    "reports_events": "Reports & events", "github": "GitHub", "video": "Video",
    "third_party": "Third-party press",
}
INTERVAL_HOURS: dict[str, float | None] = {
    "hourly": 1, "six_hours": 6, "daily": 24, "weekly": 168,
    "monthly": 720, "never": None,
}
INTERVAL_LABELS = {
    "hourly": "Every hour", "six_hours": "Every 6 hours", "daily": "Daily",
    "weekly": "Weekly", "monthly": "Monthly", "never": "Never",
}
DEPTHS = ("cheap", "reextract", "full")
DEPTH_LABELS = {
    "cheap": "Cheap check only", "reextract": "Re-extract changed docs",
    "full": "Full re-index on change",
}

# These are planning inputs, not prices. They are stated in the UI so projections are
# reproducible. Unit time/token/cost below is always derived from measured runs.
CHANGE_RATE_PER_CHECK = {
    "live_pages": 0.03, "blog": 0.01, "docs": 0.01, "reports_events": 0.01,
    "github": 0.05, "video": 0.01, "third_party": 0.01,
}

PRESETS: dict[str, dict[str, dict[str, str]]] = {
    "economy": {
        "live_pages": {"interval": "weekly", "depth": "reextract"},
        "blog": {"interval": "weekly", "depth": "reextract"},
        "docs": {"interval": "weekly", "depth": "reextract"},
        "reports_events": {"interval": "monthly", "depth": "reextract"},
        "github": {"interval": "daily", "depth": "reextract"},
        "video": {"interval": "monthly", "depth": "cheap"},
        "third_party": {"interval": "never", "depth": "cheap"},
    },
    "balanced": {
        "live_pages": {"interval": "daily", "depth": "full"},
        "blog": {"interval": "daily", "depth": "reextract"},
        "docs": {"interval": "daily", "depth": "reextract"},
        "reports_events": {"interval": "weekly", "depth": "reextract"},
        "github": {"interval": "six_hours", "depth": "reextract"},
        "video": {"interval": "weekly", "depth": "cheap"},
        "third_party": {"interval": "weekly", "depth": "cheap"},
    },
    "real_time": {
        "live_pages": {"interval": "hourly", "depth": "full"},
        "blog": {"interval": "hourly", "depth": "reextract"},
        "docs": {"interval": "hourly", "depth": "reextract"},
        "reports_events": {"interval": "daily", "depth": "full"},
        "github": {"interval": "hourly", "depth": "reextract"},
        "video": {"interval": "daily", "depth": "reextract"},
        "third_party": {"interval": "daily", "depth": "reextract"},
    },
}


def source_type(doc: dict[str, Any]) -> str:
    """Map the corpus's historical categories and URLs to operator-facing types."""
    category, url = doc.get("category", ""), doc.get("url", "")
    if category == "code" or "github.com/" in url:
        return "github"
    if category == "video" or "youtube.com/" in url:
        return "video"
    if category in {"press", "third-party"}:
        return "third_party"
    if category == "docs" or "docs.everstake" in url:
        return "docs"
    if "/crypto-reports" in url or "/company/events" in url:
        return "reports_events"
    if category == "blog" or "/blog/" in url:
        return "blog"
    return "live_pages"


def load_policy(path: Path = FRESHNESS_POLICY_PATH) -> dict[str, Any]:
    if path.exists():
        policy = json.loads(path.read_text())
    else:
        policy = {"preset": "balanced", "sources": PRESETS["balanced"]}
    validate_policy(policy)
    return policy


def validate_policy(policy: dict[str, Any]) -> None:
    sources = policy.get("sources", {})
    if set(sources) != set(SOURCE_TYPES):
        raise ValueError("Freshness policy must configure every source type")
    for value in sources.values():
        if value.get("interval") not in INTERVAL_HOURS or value.get("depth") not in DEPTHS:
            raise ValueError("Unknown freshness interval or depth")


def measured_units(accounting_path: Path = ACCOUNTING_LOG) -> dict[str, float | str]:
    """Derive unit costs from the latest completed crawl/index measurements."""
    rows = []
    if accounting_path.exists():
        rows = [json.loads(line) for line in accounting_path.read_text().splitlines() if line.strip()]
    latest = {row.get("name"): row for row in rows if row.get("status") == "completed"}
    # Production's mutable accounting volume may contain only live questions. The
    # generated cost report is the immutable fallback containing the same completed
    # measurement rows used by the Cost view.
    fallback = {}
    if COST_REPORT_PATH.exists():
        fallback = {row["name"]: row for row in json.loads(COST_REPORT_PATH.read_text()).get("stages", [])}
    crawl = latest.get("crawl") or fallback.get("crawl", {})
    embedding = latest.get("embeddings") or fallback.get("embeddings", {})
    extract = latest.get("fact_extraction") or fallback.get("fact_extraction", {})
    dedup = latest.get("dedup") or fallback.get("dedup", {})
    crawl_units = max(1, int(crawl.get("items", {}).get("visited_urls", 0)))
    chunks = max(1, int(embedding.get("items", {}).get("chunks", 0)))
    extracted = max(1, int(extract.get("items", {}).get("chunks_scanned", 0)))
    return {
        "fetch_wall_ms": float(crawl.get("wall_ms", 0)) / crawl_units,
        "extract_wall_ms": float(extract.get("wall_ms", 0)) / extracted,
        "extract_cost_usd": float(extract.get("cost_usd", 0)) / extracted,
        "extract_tokens": sum(extract.get("tokens", {}).values()) / extracted,
        "embedding_wall_ms": float(embedding.get("wall_ms", 0)) / chunks,
        "embedding_cost_usd": float(embedding.get("cost_usd", 0)) / chunks,
        "embedding_tokens": float(embedding.get("tokens", {}).get("input", 0)) / chunks,
        "run_overhead_ms": float(dedup.get("wall_ms", 0)),
        "machine": str(crawl.get("machine", "No completed measurement")),
        "price_date": PRICE_TABLE_COPIED_AT,
    }


def corpus_profile(corpus_path: Path = CORPUS_PATH) -> dict[str, Any]:
    docs = []
    if corpus_path.exists():
        docs = [json.loads(line) for line in corpus_path.read_text().splitlines() if line.strip()]
    counts = Counter(source_type(doc) for doc in docs)
    if FRESHNESS_STATE_PATH.exists():
        try:
            repository_count = len(json.loads(FRESHNESS_STATE_PATH.read_text()).get("github", {}).get("repos", {}))
            if repository_count:
                counts["github"] = repository_count
        except json.JSONDecodeError:
            pass
    total_chunks = 0
    stats_path = corpus_path.with_name("index-stats.json")
    if stats_path.exists():
        total_chunks = int(json.loads(stats_path.read_text()).get("chunks", 0))
    return {
        "counts": {name: counts[name] for name in SOURCE_TYPES},
        "chunks_per_doc": total_chunks / max(1, len(docs)),
        "total_documents": len(docs), "total_chunks": total_chunks,
    }


def calculate_monthly(policy: dict[str, Any], profile: dict[str, Any],
                      units: dict[str, Any]) -> dict[str, Any]:
    """Project one month using measured units and declared change-rate assumptions."""
    validate_policy(policy)
    rows, totals = [], {"cost_usd": 0.0, "tokens": 0.0, "machine_ms": 0.0}
    worst_hours: float | None = 0
    total_chunks = float(profile["total_chunks"])
    chunks_per_doc = float(profile["chunks_per_doc"])
    for name in SOURCE_TYPES:
        choice = policy["sources"][name]
        interval = INTERVAL_HOURS[choice["interval"]]
        count = int(profile["counts"].get(name, 0))
        if interval is None:
            runs, changed, rebuilds = 0.0, 0.0, 0.0
            worst_hours = None
        else:
            runs = 720 / interval
            rate = CHANGE_RATE_PER_CHECK[name]
            changed = runs * count * rate
            rebuilds = runs * (1 - math.pow(1 - rate, count)) if count else 0
            if worst_hours is not None:
                worst_hours = max(worst_hours, interval)
        fetch_ms = runs * (float(units["run_overhead_ms"]) + count * float(units["fetch_wall_ms"]))
        extract_multiplier = changed if choice["depth"] in {"reextract", "full"} else 0
        embed_chunks = 0.0
        if choice["depth"] == "reextract":
            embed_chunks = changed * chunks_per_doc
        elif choice["depth"] == "full":
            embed_chunks = rebuilds * total_chunks
        cost = (extract_multiplier * float(units["extract_cost_usd"])
                + embed_chunks * float(units["embedding_cost_usd"]))
        tokens = (extract_multiplier * float(units["extract_tokens"])
                  + embed_chunks * float(units["embedding_tokens"]))
        machine_ms = (fetch_ms + extract_multiplier * float(units["extract_wall_ms"])
                      + embed_chunks * float(units["embedding_wall_ms"]))
        row = {
            "type": name, "label": SOURCE_LABELS[name], "documents": count,
            "runs": runs, "expected_changed_docs": changed, "cost_usd": cost,
            "tokens": tokens, "machine_minutes": machine_ms / 60000,
            "worst_staleness_hours": interval,
        }
        rows.append(row)
        for key, value in (("cost_usd", cost), ("tokens", tokens), ("machine_ms", machine_ms)):
            totals[key] += value
    return {
        "sources": rows,
        "totals": {
            "cost_usd": round(totals["cost_usd"], 6),
            "tokens": round(totals["tokens"]),
            "machine_minutes": round(totals["machine_ms"] / 60000, 2),
            "worst_staleness_hours": worst_hours,
        },
    }


def calculator_payload(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    selected = policy or load_policy()
    units, profile = measured_units(), corpus_profile()
    return {
        "selected": selected, "presets": PRESETS,
        "options": {"intervals": INTERVAL_LABELS, "depths": DEPTH_LABELS},
        "source_labels": SOURCE_LABELS, "profile": profile, "units": units,
        "change_rates": CHANGE_RATE_PER_CHECK,
        "projection": calculate_monthly(selected, profile, units),
    }
