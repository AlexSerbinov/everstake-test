"""Deterministic evidence-quality score computed after answer validation.

The score is intentionally not a truth probability. It summarizes observable evidence
properties and the server's grounding gates; the model supplies only the smallest,
separately labelled component. Configuration is read for every answer so a reviewer can
change weights without restarting the process or making another model call.
"""

from __future__ import annotations

import json
import math
import os
import re
import sqlite3
import tempfile
import threading
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from .config import TRUST_CONFIG_PATH

COMPONENTS = (
    "source_authority", "independent_agreement", "recency", "grounding",
    "extraction_confidence", "model_self_assessment",
)
DEFAULT_WEIGHTS = {
    "source_authority": 0.25,
    "independent_agreement": 0.25,
    "recency": 0.15,
    "grounding": 0.20,
    "extraction_confidence": 0.10,
    "model_self_assessment": 0.05,
}
DISPLAY_NAMES = {
    "source_authority": "Source authority",
    "independent_agreement": "Independent agreement",
    "recency": "Recency / currency",
    "grounding": "Grounding gates",
    "extraction_confidence": "Extraction confidence",
    "model_self_assessment": "Model self-assessment",
}
_CURRENT_QUESTION = re.compile(r"\b(current|currently|today|now|latest|live|present|as of)\b", re.I)
_HISTORICAL_QUESTION = re.compile(r"\b(histor|founded|when was|in 20\d{2}|since 20\d{2}|over time|evolv|changed)\b", re.I)
_CLAIM_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
_LOCK = threading.Lock()


def load_weights(path: Path | None = None) -> dict[str, float]:
    """Read and validate live weights; invalid on-disk state falls back safely."""
    path = path or TRUST_CONFIG_PATH
    try:
        return validate_weights(json.loads(path.read_text()).get("weights", {}))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return dict(DEFAULT_WEIGHTS)


def validate_weights(weights: dict) -> dict[str, float]:
    """Require a complete normalized vector and keep model opinion at or below 10%."""
    if set(weights) != set(COMPONENTS):
        raise ValueError("All six trust weights are required.")
    clean = {name: float(weights[name]) for name in COMPONENTS}
    if any(not math.isfinite(value) or value < 0 or value > 1 for value in clean.values()):
        raise ValueError("Trust weights must be finite values from 0 to 1.")
    if clean["model_self_assessment"] > 0.10:
        raise ValueError("Model self-assessment may not exceed 10%.")
    if not math.isclose(sum(clean.values()), 1.0, abs_tol=0.0001):
        raise ValueError("Trust weights must sum to 1.0.")
    return clean


def save_weights(weights: dict, path: Path | None = None) -> dict[str, float]:
    """Atomically replace the operator override used by subsequent answers."""
    path = path or TRUST_CONFIG_PATH
    clean = validate_weights(weights)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _LOCK:
        descriptor, temporary = tempfile.mkstemp(prefix=".trust-", dir=path.parent)
        try:
            with os.fdopen(descriptor, "w") as handle:
                json.dump({"weights": clean}, handle, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
    return clean


def score_answer(question: str, answer: str, as_of: str | None, cited: list,
                 considered: list | None = None, model_confidence: object = 0.5,
                 database: Path | str | None = None, weights: dict | None = None,
                 grounding_passed: bool = True) -> dict | None:
    """Return the public Trust Score object, or ``None`` for an abstention."""
    if not cited:
        return None
    weights = validate_weights(weights) if weights is not None else load_weights()
    considered = considered or cited
    cited_sources = _source_representatives(cited)
    groups = _independent_groups(cited, database)
    disagreements = _disagreements(cited, considered, database)
    values_and_reasons = {
        "source_authority": _authority_component(cited_sources),
        "independent_agreement": _agreement_component(groups, disagreements),
        "recency": _recency_component(question, as_of, cited),
        "grounding": _grounding_component(answer, cited, groups, grounding_passed),
        "extraction_confidence": _extraction_component(cited_sources),
        "model_self_assessment": _model_component(model_confidence),
    }
    components = []
    total = 0.0
    for key in COMPONENTS:
        value, reason = values_and_reasons[key]
        points = 100 * weights[key] * value
        total += points
        components.append({
            "name": key, "label": DISPLAY_NAMES[key], "weight": weights[key],
            "value": round(value, 3), "points": round(points, 1), "reason": reason,
        })
    score = max(0, min(100, round(total)))
    band, label = band_for(score)
    return {
        "score": score, "band": band, "label": label, "components": components,
        "independent_sources": len(groups), "disagreements": disagreements,
    }


def band_for(score: int) -> tuple[str, str]:
    if score >= 90:
        return "solid", "Solid: several independent first-party sources agree"
    if score >= 70:
        return "good", "Good: first-party, some caveats"
    if score >= 50:
        return "mixed", "Mixed: sources disagree or are third-party"
    return "weak", "Weak: treat as a lead, verify"


def source_authority_value(item) -> float:
    """Score one source from identity, provenance, live status and explicit penalties."""
    voice = getattr(item, "voice", "first_party_channel")
    base = {"first_party_channel": 0.96, "employee_on_third_party": 0.76,
            "third_party": 0.52}.get(voice, 0.50)
    provenance = getattr(item, "provenance", "")
    if provenance.startswith("everstake_mcp:") or provenance == "allowlisted_live_fetch":
        base = 1.0
    if getattr(item, "claim_provenance", "stated") == "reported":
        base *= 0.82
    if getattr(item, "unverified_claims", 0):
        base *= 0.55
    base *= float(getattr(item, "trust_penalty", 1.0) or 1.0)
    return max(0.0, min(1.0, base))


def _source_representatives(items: list) -> list:
    """Collapse several cited passages of one page before averaging source properties."""
    seen: set[tuple[str, str]] = set()
    representatives = []
    for item in items:
        provenance = str(getattr(item, "provenance", ""))
        origin = "corpus" if provenance in {"corpus_snapshot", "corpus_document"} else provenance
        key = (getattr(item, "url", ""), origin)
        if key not in seen:
            seen.add(key)
            representatives.append(item)
    return representatives


def _authority_component(cited: list) -> tuple[float, str]:
    values = [source_authority_value(item) for item in cited]
    value = (max(values) + sum(values) / len(values)) / 2
    first_party = sum(getattr(item, "voice", "") == "first_party_channel" for item in cited)
    live = sum(str(getattr(item, "provenance", "")).startswith("everstake_mcp:") or
               getattr(item, "provenance", "") == "allowlisted_live_fetch" for item in cited)
    caveats = sum(float(getattr(item, "trust_penalty", 1.0) or 1.0) < 1 or
                  bool(getattr(item, "unverified_claims", 0)) for item in cited)
    reason = f"{first_party} first-party source{'s' if first_party != 1 else ''}"
    if live:
        reason += f"; {live} live-verified"
    if caveats:
        reason += f"; {caveats} carries a trust caveat"
    return value, reason


def _independent_groups(items: list, database: Path | str | None) -> dict[str, list]:
    duplicate_groups = _duplicate_groups(items, database)
    groups: dict[str, list] = {}
    for item in items:
        document_id = getattr(item, "document_id", None)
        duplicate = duplicate_groups.get(document_id)
        content = getattr(item, "content", "")
        # Exact syndicated text and index dedup clusters collapse before domain. The
        # domain fallback enforces the assignment's explicit "same domain twice = one".
        if duplicate is not None:
            key = f"dedup:{duplicate}"
        elif content:
            import hashlib
            key = f"content:{hashlib.sha256(content.encode()).hexdigest()}"
        else:
            key = f"domain:{urlparse(getattr(item, 'url', '')).hostname or getattr(item, 'url', '')}"
        domain = urlparse(getattr(item, "url", "")).hostname or "unknown"
        domain_key = f"domain:{domain.lower().removeprefix('www.')}"
        # A domain that already appeared always wins over a different content hash.
        existing = next((name for name, members in groups.items()
                         if urlparse(getattr(members[0], "url", "")).hostname and
                         (urlparse(getattr(members[0], "url", "")).hostname or "").lower().removeprefix("www.")
                         == domain.lower().removeprefix("www.")), None)
        groups.setdefault(existing or key or domain_key, []).append(item)
    return groups


def _duplicate_groups(items: list, database: Path | str | None) -> dict[int, int]:
    ids = sorted({getattr(item, "document_id", None) for item in items
                  if getattr(item, "document_id", None) is not None})
    if not ids or database is None or not Path(database).exists():
        return {}
    try:
        connection = sqlite3.connect(database)
        placeholders = ",".join("?" for _ in ids)
        rows = connection.execute(
            f"SELECT id,duplicate_group FROM documents WHERE id IN ({placeholders})", ids
        ).fetchall()
        connection.close()
        return {row[0]: row[1] for row in rows}
    except sqlite3.Error:
        return {}


def _disagreements(cited: list, considered: list, database: Path | str | None) -> list[dict]:
    cited_ids = {id(item) for item in cited}
    candidates = [item for item in considered if id(item) not in cited_ids and (
        float(getattr(item, "trust_penalty", 1.0) or 1.0) < 1 or
        "contradict" in str(getattr(item, "trust_penalty_reason", "")).lower()
    )]
    rows = []
    for members in _independent_groups(candidates, database).values():
        item = members[0]
        authority = source_authority_value(item)
        rows.append({
            "source": getattr(item, "title", "Considered source"),
            "url": getattr(item, "url", ""), "authority": round(authority, 3),
            "level": "low" if authority < 0.6 else "material",
            "reason": getattr(item, "trust_penalty_reason", None) or "Conflicts with cited evidence.",
        })
    return rows


def _agreement_component(groups: dict[str, list], disagreements: list[dict]) -> tuple[float, str]:
    count = len(groups)
    value = {0: 0.0, 1: 0.66, 2: 0.86}.get(count, 1.0)
    penalty = sum(0.08 if row["level"] == "low" else 0.22 for row in disagreements)
    value = max(0.0, value - penalty)
    reason = f"{count} independent supporting source{'s' if count != 1 else ''}"
    if disagreements:
        low = sum(row["level"] == "low" for row in disagreements)
        material = len(disagreements) - low
        details = []
        if low:
            details.append(f"{low} low-trust source{'s' if low != 1 else ''} disagree")
        if material:
            details.append(f"{material} material source{'s' if material != 1 else ''} disagree")
        reason += "; " + ", ".join(details)
    else:
        reason += "; no detected disagreement"
    return value, reason


def _parse_date(value: object) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _recency_component(question: str, as_of: str | None, cited: list) -> tuple[float, str]:
    dates = [_parse_date(getattr(item, "date", None) or getattr(item, "evidence_date", None)) for item in cited]
    dates = [value for value in dates if value]
    if _HISTORICAL_QUESTION.search(question) and not _CURRENT_QUESTION.search(question):
        coverage = 1.0 if dates else 0.45
        return coverage, "Historical question uses dated evidence; present-day freshness is not required"
    today = datetime.now(timezone.utc).date()
    newest = max(dates) if dates else _parse_date(as_of)
    if newest is None:
        return 0.35, "No reliable evidence date was available"
    age = max(0, (today - newest).days)
    if any(str(getattr(item, "provenance", "")).startswith("everstake_mcp:") or
           getattr(item, "provenance", "") == "allowlisted_live_fetch" for item in cited):
        value = 1.0
    elif age <= 30:
        value = 0.98
    elif age <= 180:
        value = 0.90
    elif age <= 365:
        value = 0.80
    elif age <= 730:
        value = 0.65
    else:
        value = 0.40
    return value, f"Newest supporting evidence is {age} day{'s' if age != 1 else ''} old"


def _grounding_component(answer: str, cited: list, groups: dict[str, list],
                         grounding_passed: bool) -> tuple[float, str]:
    if not grounding_passed:
        return 0.0, "Grounding gates rejected this counterfactual answer"
    claims = [part for part in _CLAIM_SPLIT.split(answer) if part.strip()]
    ratio = min(1.0, len(groups) / max(1, len(claims)))
    value = 0.9 + 0.1 * ratio
    return value, (f"All citation and numeric gates passed; {len(claims)} claim"
                   f"{'s' if len(claims) != 1 else ''} backed by {len(groups)} independent source"
                   f"{'s' if len(groups) != 1 else ''}")


def _extraction_component(cited: list) -> tuple[float, str]:
    live = [item for item in cited if str(getattr(item, "provenance", "")).startswith("everstake_mcp:")]
    if live:
        return 1.0, "Structured live fields were read directly; no prose extraction"
    explicit_dates = sum(bool(_parse_date(getattr(item, "date", None) or
                                          getattr(item, "evidence_date", None))) for item in cited)
    penalized = sum(bool(getattr(item, "unverified_claims", 0)) for item in cited)
    value = max(0.45, 0.88 + 0.04 * (explicit_dates / len(cited)) - 0.18 * penalized)
    return value, (f"Deterministic extraction used document metadata dates for {explicit_dates}/{len(cited)} cited sources; "
                   "the claim text supplied no separate as-of confidence"
                   + (f"; {penalized} unverified extraction" if penalized else ""))


def _model_component(confidence: object) -> tuple[float, str]:
    try:
        value = float(confidence)
    except (TypeError, ValueError):
        value = 0.5
    value = max(0.0, min(1.0, value))
    return value, f"Model reported {value:.0%} confidence; this opinion has a capped minor weight"
