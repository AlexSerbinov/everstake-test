"""Measured accounting for build stages, evaluations, and individual questions.

Every record uses the same append-only JSONL schema. Provider calls add steps to every
active recorder (for example both an eval and its nested question), while code/tool
steps cost zero but retain measured wall time, CPU time and process peak RSS.
"""

from __future__ import annotations

import json
import os
import platform
import resource
import threading
import time
import uuid
from contextvars import ContextVar
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import ACCOUNTING_LOG, PRICE_TABLE, PRICE_TABLE_COPIED_AT

_ACTIVE: ContextVar[tuple["RunRecorder", ...]] = ContextVar("accounting_recorders", default=())
_WRITE_LOCK = threading.Lock()


def price_usd(model: str, input_tokens: int, output_tokens: int,
              cached_input_tokens: int = 0) -> float:
    """Price provider-reported usage with the dated config row for `model`.

    `input_tokens` is the provider's complete prompt count. Cached tokens are reported
    separately for transparency but are not subtracted because the supplied price table
    has no discounted cache rate; doing so would understate spend.
    """
    row = PRICE_TABLE[model]
    return round(
        input_tokens / 1_000_000 * float(row["input_per_million"])
        + output_tokens / 1_000_000 * float(row["output_per_million"]),
        10,
    )


def _rss_mb() -> float:
    value = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS reports bytes; Linux (including the deployment container) reports KiB.
    divisor = 1024 * 1024 if platform.system() == "Darwin" else 1024
    return round(value / divisor, 2)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _machine() -> str:
    return os.getenv("EVERSTAKE_MACHINE_LABEL") or f"{platform.system()} {platform.machine()} ({platform.node()})"


class RunRecorder:
    """One measured run, activated explicitly so nested provider calls can find it."""

    def __init__(self, kind: str, name: str, metadata: dict[str, Any] | None = None,
                 log_path: Path | None = None):
        self.record: dict[str, Any] = {
            "schema_version": 1,
            "run_id": str(uuid.uuid4()),
            "kind": kind,
            "name": name,
            "started_at": _now(),
            "ended_at": None,
            "wall_ms": None,
            "cpu_ms": None,
            "peak_rss_mb": None,
            "machine": _machine(),
            "items": {},
            "bytes_downloaded": 0,
            "tokens": {"input": 0, "output": 0, "cached_input": 0},
            "cost_usd": 0.0,
            "models": [],
            "providers": [],
            "steps": [],
            "status": "running",
            "metadata": metadata or {},
        }
        self.log_path = log_path or ACCOUNTING_LOG
        self._wall_start = time.perf_counter()
        self._cpu_start = time.process_time()
        self._token = None
        self._finished = False

    def activate(self) -> "RunRecorder":
        self._token = _ACTIVE.set((*_ACTIVE.get(), self))
        return self

    def add_step(self, step: dict[str, Any]) -> None:
        self.record["steps"].append(step)
        tokens = step.get("tokens", {})
        for key in ("input", "output", "cached_input"):
            self.record["tokens"][key] += int(tokens.get(key, 0) or 0)
        self.record["cost_usd"] = round(
            self.record["cost_usd"] + float(step.get("cost_usd", 0) or 0), 10
        )
        for field, value in (("models", step.get("model")), ("providers", step.get("provider"))):
            if value and value not in self.record[field]:
                self.record[field].append(value)

    def finish(self, *, items: dict[str, int] | None = None, bytes_downloaded: int = 0,
               status: str = "completed", write: bool = True) -> dict[str, Any]:
        if self._finished:
            return self.record
        if self._token is not None:
            _ACTIVE.reset(self._token)
            self._token = None
        self.record.update({
            "ended_at": _now(),
            "wall_ms": round((time.perf_counter() - self._wall_start) * 1000, 3),
            "cpu_ms": round((time.process_time() - self._cpu_start) * 1000, 3),
            "peak_rss_mb": _rss_mb(),
            "items": items or self.record["items"],
            "bytes_downloaded": int(bytes_downloaded),
            "status": status,
        })
        self.record["cost_usd"] = round(self.record["cost_usd"], 10)
        self._finished = True
        if write:
            append_record(self.record, self.log_path)
        return self.record


def append_record(record: dict[str, Any], path: Path = ACCOUNTING_LOG) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with _WRITE_LOCK, path.open("a") as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + "\n")


class measured_run:
    """Context manager for a normal stage/eval run."""

    def __init__(self, kind: str, name: str, metadata: dict[str, Any] | None = None):
        self.recorder = RunRecorder(kind, name, metadata)

    def __enter__(self) -> RunRecorder:
        return self.recorder.activate()

    def __exit__(self, error_type, _error, _traceback) -> None:
        self.recorder.finish(status="failed" if error_type else "completed")


def record_provider_step(name: str, model: str, input_tokens: int, output_tokens: int,
                         cached_input_tokens: int, wall_ms: float, cpu_ms: float,
                         metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    row = PRICE_TABLE[model]
    step = {
        "name": name,
        "kind": "model" if float(row["output_per_million"]) else "embedding",
        "provider": row["provider"],
        "model": model,
        "tokens": {
            "input": int(input_tokens),
            "output": int(output_tokens),
            "cached_input": int(cached_input_tokens),
        },
        "cost_usd": price_usd(model, input_tokens, output_tokens, cached_input_tokens),
        "wall_ms": round(wall_ms, 3),
        "cpu_ms": round(cpu_ms, 3),
        "peak_rss_mb": _rss_mb(),
        "price_copied_at": PRICE_TABLE_COPIED_AT,
        "metadata": metadata or {},
    }
    for recorder in _ACTIVE.get():
        recorder.add_step(dict(step))
    return step


def record_code_step(name: str, wall_ms: float, cpu_ms: float,
                     metadata: dict[str, Any] | None = None) -> dict[str, Any]:
    step = {
        "name": name,
        "kind": "code",
        "provider": None,
        "model": None,
        "tokens": {"input": 0, "output": 0, "cached_input": 0},
        "cost_usd": 0.0,
        "wall_ms": round(wall_ms, 3),
        "cpu_ms": round(cpu_ms, 3),
        "peak_rss_mb": _rss_mb(),
        "metadata": metadata or {},
    }
    for recorder in _ACTIVE.get():
        recorder.add_step(dict(step))
    return step


def active_step_cost() -> float:
    """Current innermost run cost, used to subtract nested provider time from tools."""
    active = _ACTIVE.get()
    return active[-1].record["cost_usd"] if active else 0.0
