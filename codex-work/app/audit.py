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

_LOCK = threading.Lock()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _private_key(path: Path | None = None) -> Ed25519PrivateKey:
    path = path or AUDIT_KEY
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return Ed25519PrivateKey.from_private_bytes(path.read_bytes())
    key = Ed25519PrivateKey.generate()
    raw = key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())
    path.write_bytes(raw)
    os.chmod(path, 0o600)
    return key


def public_key_b64(path: Path | None = None) -> str:
    raw = _private_key(path).public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode()


def append_answer(question: str, result: dict, evidence: list[dict], tool_trace: list[dict]) -> dict:
    """Append an Ed25519-signed hash-chain record containing the exact evidence."""
    with _LOCK:
        AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
        previous_hash = "0" * 64
        if AUDIT_LOG.exists():
            lines = [line for line in AUDIT_LOG.read_text().splitlines() if line.strip()]
            if lines:
                previous_hash = json.loads(lines[-1])["record_hash"]
        record = {
            "id": str(uuid.uuid4()),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "question": question,
            "answer": result["answer"],
            "as_of": result.get("as_of"),
            "sufficient": result.get("sufficient", False),
            "evidence": evidence,
            "tool_trace": tool_trace,
            "previous_hash": previous_hash,
        }
        record_hash = hashlib.sha256(bytes.fromhex(previous_hash) + canonical(record)).hexdigest()
        signature = _private_key().sign(bytes.fromhex(record_hash))
        signed = {**record, "record_hash": record_hash, "signature": base64.b64encode(signature).decode()}
        with AUDIT_LOG.open("a") as handle:
            handle.write(json.dumps(signed, ensure_ascii=False, separators=(",", ":")) + "\n")
        return {
            "id": record["id"],
            "record_hash": record_hash,
            "signature": signed["signature"],
            "public_key": public_key_b64(),
            "evidence_hashes": [item["content_sha256"] for item in evidence],
            "verify_url": f"/api/audit/{record['id']}",
        }


def get_record(record_id: str) -> dict | None:
    if not AUDIT_LOG.exists():
        return None
    previous = "0" * 64
    chain_valid = True
    for line in AUDIT_LOG.read_text().splitlines():
        record = json.loads(line)
        unsigned = {key: value for key, value in record.items() if key not in {"record_hash", "signature"}}
        expected = hashlib.sha256(bytes.fromhex(record["previous_hash"]) + canonical(unsigned)).hexdigest()
        try:
            _private_key().public_key().verify(base64.b64decode(record["signature"]), bytes.fromhex(record["record_hash"]))
            signature_valid = True
        except Exception:
            signature_valid = False
        chain_valid = chain_valid and record.get("previous_hash") == previous and expected == record.get("record_hash") and signature_valid
        if record.get("id") == record_id:
            return {**record, "verified": chain_valid, "public_key": public_key_b64()}
        previous = record.get("record_hash", "")
    return None
