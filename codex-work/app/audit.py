"""Append-only, Ed25519-signed hash chain over every answer the system produces.

Pipeline position: question → guards → tool loop → validation → **audit receipt (here)**
→ response. `run_agent` calls `append_answer` for every outcome including abstentions,
and hands the returned receipt back to the caller; `GET /api/audit/<id>` calls
`get_record` to re-verify it later.

What the chain buys: the log is a plain JSONL file on disk, so anyone with write access
could edit an old answer after the fact. Chaining each record's hash into the next one
means such an edit invalidates that record *and every record after it*, and the Ed25519
signature means an attacker cannot simply recompute the chain — they would need the
private key too. A broken link therefore proves the log was altered after it was
written; it does not prove which party altered it, and it cannot survive an attacker
who holds both the key and the log (see REPORT.md — shipping the chain head off-host is
the documented production follow-up).

If this module is wrong, every "verified" badge in the UI is a lie: answers would look
tamper-evident while being freely editable.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .config import AUDIT_KEY, AUDIT_LOG

# The chain has to start somewhere. 64 hex zeroes is a value no SHA-256 digest will
# realistically take, so "previous_hash is all zeroes" unambiguously means "first record".
GENESIS_PREVIOUS_HASH = "0" * 64

# Owner-only permissions on the signing key. Without this the key would inherit the
# process umask and any local user could forge receipts.
SIGNING_KEY_FILE_MODE = 0o600

# The log is appended to from multiple HTTP worker threads (ThreadingHTTPServer). Two
# concurrent appends could otherwise read the same `previous_hash` and fork the chain,
# which would make every later record fail verification.
_LOCK = threading.Lock()


def canonical(value: object) -> bytes:
    """Serialise a record to the exact bytes that get hashed.

    Hashing has to be reproducible by a third party months later, so every degree of
    freedom in JSON output is pinned: keys sorted (dict order must not matter),
    no whitespace in separators, and non-ASCII kept as real characters rather than
    \\u escapes (so a Ukrainian question hashes the same in every Python version).
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha256_text(value: str) -> str:
    """Hash one piece of evidence content.

    Scope matters and is deliberate: this covers the **whole** stored content of an
    evidence item, not the truncated slice that was shown to the model. A citation hash
    has to identify the chunk itself, so a reviewer can re-fetch that chunk and compare.
    Pinned in tests/test_tools.py::test_the_content_hash_covers_the_untruncated_content.
    """
    return hashlib.sha256(value.encode()).hexdigest()


def _private_key(path: Path | None = None) -> Ed25519PrivateKey:
    """Load the persistent signing key, creating it on first use.

    Persistent rather than per-process: a key regenerated on restart would make every
    receipt issued before the restart unverifiable, which is indistinguishable from
    tampering. Ed25519 is used because a raw key is 32 bytes and a signature 64, small
    enough to inline into every JSON receipt without thinking about it.
    """
    path = path or AUDIT_KEY
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return Ed25519PrivateKey.from_private_bytes(path.read_bytes())
    key = Ed25519PrivateKey.generate()
    raw = key.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    path.write_bytes(raw)
    os.chmod(path, SIGNING_KEY_FILE_MODE)
    return key


def public_key_b64(path: Path | None = None) -> str:
    """Expose the verification key so a receipt can be checked without this server.

    Served at `GET /api/audit/public-key`. Offline verifiability is the point of signing
    at all — a receipt only the issuer can validate proves nothing to anyone else.
    """
    raw = _private_key(path).public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    return base64.b64encode(raw).decode()


def _read_chain_head() -> str:
    """Return the hash of the newest record, or the genesis value on an empty log.

    Reads the whole file rather than seeking to the end: the log is one answer per
    request on a single host, so it stays small, and correctness under a partially
    written final line matters more here than IO cost.
    """
    if not AUDIT_LOG.exists():
        return GENESIS_PREVIOUS_HASH
    lines = [line for line in AUDIT_LOG.read_text().splitlines() if line.strip()]
    if not lines:
        return GENESIS_PREVIOUS_HASH
    return json.loads(lines[-1])["record_hash"]


def _build_record(question: str, result: dict, evidence: list[dict], tool_trace: list[dict],
                  previous_hash: str) -> dict:
    """Assemble the exact key set that gets hashed and signed.

    This key set IS the hashing scope, so changing, adding or reordering a key here
    would invalidate every signature already written to data/answer-audit.jsonl.
    It deliberately captures three different things: the claim (`answer`, `as_of`,
    `sufficient`), the evidence it rests on (`evidence`, each item carrying its own
    `content_sha256`), and how that evidence was obtained (`tool_trace`). Recording only
    the answer would let someone later dispute which sources it came from.
    """
    return {
        "id": str(uuid.uuid4()),
        "created_at": datetime.now(timezone.utc).isoformat(),
        "question": question,
        "answer": result["answer"],
        "as_of": result.get("as_of"),
        # Defaulted rather than required: an abstention built by the agent's
        # `_abstention` helper always sets it, but a caller passing a bare result dict
        # must not be able to produce a record that silently claims sufficiency.
        "sufficient": result.get("sufficient", False),
        "evidence": evidence,
        "tool_trace": tool_trace,
        "previous_hash": previous_hash,
    }


def _hash_record(record: dict, previous_hash: str) -> str:
    """Compute SHA-256(previous_hash_bytes || canonical_record).

    The previous hash is mixed in as raw bytes, not as its hex string, and it is
    prepended rather than stored only inside the record — so a record cannot be lifted
    out of one position in the log and replayed at another without the digest changing.
    """
    return hashlib.sha256(bytes.fromhex(previous_hash) + canonical(record)).hexdigest()


def append_answer(question: str, result: dict, evidence: list[dict], tool_trace: list[dict]) -> dict:
    """Append one signed record and return the receipt shown to the user.

    Called for *every* outcome, abstentions included, because "the system declined to
    answer on 2026-09-12" is exactly the kind of statement someone may later want to
    verify. The write happens under a lock so concurrent requests cannot fork the chain.
    """
    with _LOCK:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        previous_hash = _read_chain_head()
        record = _build_record(question, result, evidence, tool_trace, previous_hash)
        record_hash = _hash_record(record, previous_hash)
        # Sign the digest, not the record: Ed25519 over 32 fixed bytes keeps the
        # signature independent of how large the evidence payload happens to be.
        signature = _private_key().sign(bytes.fromhex(record_hash))
        signed = {
            **record,
            "record_hash": record_hash,
            "signature": base64.b64encode(signature).decode(),
        }
        # Append-only, one JSON object per line: a crash mid-write can corrupt at most
        # the last line, and never rewrites an earlier record.
        with AUDIT_LOG.open("a") as handle:
            handle.write(json.dumps(signed, ensure_ascii=False, separators=(",", ":")) + "\n")
        return _receipt(record, record_hash, signed["signature"], evidence)


def _receipt(record: dict, record_hash: str, signature: str, evidence: list[dict]) -> dict:
    """The subset of the record handed back to the caller and rendered in the UI.

    Everything needed to verify offline (hash, signature, public key) plus the URL to
    re-verify online. The full evidence text is not repeated here — only its hashes —
    because the receipt travels in every API response and SSE `answer` event.
    """
    return {
        "id": record["id"],
        "record_hash": record_hash,
        "signature": signature,
        "public_key": public_key_b64(),
        "evidence_hashes": [item["content_sha256"] for item in evidence],
        "verify_url": f"/api/audit/{record['id']}",
    }


def _has_valid_signature(record: dict) -> bool:
    """Whether this record's signature matches its stated hash under the current key.

    A broad `except` is correct here: `verify` raises on a bad signature, and
    `b64decode`/`fromhex` raise on a malformed or truncated field. All of those mean the
    same thing to a verifier — do not trust this record — and none of them should turn
    a `GET /api/audit/<id>` into a 500.
    """
    try:
        _private_key().public_key().verify(
            base64.b64decode(record["signature"]),
            bytes.fromhex(record["record_hash"]),
        )
        return True
    except Exception:
        return False


def _record_is_intact(record: dict, expected_previous_hash: str) -> bool:
    """Whether this record is unaltered AND correctly linked to its predecessor.

    Recomputes the digest from the record minus the two fields that were added *after*
    hashing — that reconstruction is what catches an edited `answer` or `evidence`.
    """
    unsigned = {key: value for key, value in record.items() if key not in {"record_hash", "signature"}}
    recomputed = _hash_record(unsigned, record["previous_hash"])
    links_to_predecessor = record.get("previous_hash") == expected_previous_hash
    # All three checks are evaluated, not short-circuited, so that verifying a record
    # costs the same work whether it passes or fails and cannot be timed apart.
    signature_ok = _has_valid_signature(record)
    return links_to_predecessor and recomputed == record.get("record_hash") and signature_ok


def get_record(record_id: str) -> dict | None:
    """Return one audit record with a verdict on the chain leading up to it.

    Walks from the genesis record rather than checking the requested record alone: the
    point of a chain is that tampering with an *old* answer must invalidate the newer
    ones too. `verified` is therefore cumulative — it stays false for every record after
    the first break, which is what
    tests/test_audit.py::test_tampering_with_an_earlier_record_invalidates_every_later_one
    pins.
    """
    if not AUDIT_LOG.exists():
        return None
    expected_previous_hash = GENESIS_PREVIOUS_HASH
    chain_valid = True
    for line in AUDIT_LOG.read_text().splitlines():
        record = json.loads(line)
        # Every record is checked even after the chain has already broken, so that a
        # later malformed record still raises here rather than being skipped silently.
        this_record_intact = _record_is_intact(record, expected_previous_hash)
        chain_valid = chain_valid and this_record_intact
        if record.get("id") == record_id:
            return {**record, "verified": chain_valid, "public_key": public_key_b64()}
        expected_previous_hash = record.get("record_hash", "")
    return None
