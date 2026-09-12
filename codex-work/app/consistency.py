"""Deterministic fact attribution, contradiction penalties, and claim flags."""

from __future__ import annotations

import re
from collections import defaultdict

NUMBER = re.compile(r"(?<!\w)(?:\$\s*)?\d[\d,.]*(?:\s*(?:%|billion|million|thousand|bps|B|M|K|APY|APR))?", re.I)
SENTENCE = re.compile(r"(?<=[.!?])\s+|\n+")
KEYS = {
    "networks": re.compile(r"\b(?:network|chain)s?\b", re.I),
    "assets_staked": re.compile(r"\b(?:staked|stake|TVL|assets under)\b", re.I),
    "rewards": re.compile(r"\brewards?\b", re.I),
    "uptime": re.compile(r"\buptime\b", re.I),
    "fee": re.compile(r"\b(?:fee|commission)\b", re.I),
    "apy": re.compile(r"\bAPY\b", re.I),
    "apr": re.compile(r"\bAPR\b", re.I),
    "employees": re.compile(r"\b(?:employees?|team members?)\b", re.I),
    "founded": re.compile(r"\b(?:founded|established)\b", re.I),
}


def _period(document: dict) -> str:
    date = document.get("modified_at") or document.get("published_at") or document.get("fetched_at", "")
    return str(date)[:4] if re.match(r"20\d{2}", str(date)) else "undated"


def extract_facts(document: dict) -> list[dict]:
    """Extract only explainable numeric facts whose semantic key is recognised."""
    facts = []
    provenance = document.get("provenance", "stated" if document.get("tier") == 1 else "reported")
    attribution = document.get("attribution") or (
        "Everstake" if provenance == "stated" else document.get("title", "Third-party source")
    )
    for sentence in SENTENCE.split(document.get("text", "")):
        key = next((name for name, pattern in KEYS.items() if pattern.search(sentence)), None)
        values = NUMBER.findall(sentence)
        if not key or not values:
            continue
        for value in values[:3]:
            facts.append({"key": key, "period": _period(document), "value": value.strip(),
                          "normalized_value": normalize_value(value), "statement": sentence.strip()[:800],
                          "provenance": provenance, "attribution": attribution,
                          "first_party": provenance == "stated", "unverified": False})
    return facts


def normalize_value(value: str) -> str:
    return re.sub(r"[\s,$]", "", value).casefold()


def consistency_pass(documents: list[dict]) -> tuple[list[dict], dict]:
    """Compare keyed period values; mutate docs with transparent penalties and flags."""
    all_facts: list[dict] = []
    by_key_period: dict[tuple[str, str], list[tuple[int, dict]]] = defaultdict(list)
    for index, document in enumerate(documents):
        document.setdefault("voice", "first_party_channel" if document.get("tier") == 1 else "third_party")
        document.setdefault("speakers", [])
        document.setdefault("provenance", "stated" if document.get("tier") == 1 else "reported")
        document.setdefault("attribution", "Everstake" if document["provenance"] == "stated" else document["title"])
        document.setdefault("trust_penalty", 1.0)
        document.setdefault("trust_penalty_reason", None)
        facts = extract_facts(document)
        for fact in facts:
            fact["document_index"] = index
            by_key_period[(fact["key"], fact["period"])].append((index, fact))
            all_facts.append(fact)

    contradictions: dict[int, set[str]] = defaultdict(set)
    unverified = 0
    for (key, _period_name), entries in by_key_period.items():
        official_values = {
            fact["normalized_value"] for index, fact in entries
            if documents[index]["voice"] == "first_party_channel" and fact["provenance"] == "stated"
        }
        for index, fact in entries:
            if documents[index]["voice"] == "first_party_channel":
                continue
            if official_values and fact["normalized_value"] not in official_values:
                fact["contradiction"] = True
                contradictions[index].add(key)
            elif fact["provenance"] == "reported" and not official_values:
                fact["unverified"] = True
                unverified += 1

    for index, document in enumerate(documents):
        count = len(contradictions[index])
        if count >= 2:
            document["trust_penalty"] = 0.5
            document["trust_penalty_reason"] = f"Contradicts first-party values for {', '.join(sorted(contradictions[index]))}."
        document["contradiction_count"] = count
        document["unverified_claims"] = sum(
            fact["unverified"] for fact in all_facts if fact["document_index"] == index
        )
    return all_facts, {
        "facts": len(all_facts), "contradictions": sum(len(value) for value in contradictions.values()),
        "penalized_documents": sum(doc.get("trust_penalty") == 0.5 for doc in documents),
        "unverified": unverified,
    }
