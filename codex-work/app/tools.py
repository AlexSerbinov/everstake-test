from __future__ import annotations

import json
import re
import sqlite3
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .audit import sha256_text
from .config import DB_PATH, ROOT
from .crawler import PoliteFetcher, extract_html
from .retrieval import Evidence, adjudicate_evidence, retrieve
from .security import sanitize_untrusted_text

LIVE_HOSTS = {"everstake.com", "www.everstake.com", "docs.everstake.com", "security.everstake.com", "status.everstake.one"}
READ_ONLY_MCP_TOOLS = {"get_chains", "get_uptime_metrics", "staking_calculator", "get_company_profile", "get_security_profile", "get_products"}


@dataclass
class RegisteredEvidence:
    ref: str
    title: str
    url: str
    date: str
    content: str
    provenance: str
    document_id: int | None = None

    def audit_dict(self) -> dict:
        return {**asdict(self), "content_sha256": sha256_text(self.content)}


class ToolContext:
    def __init__(self, database: Path = DB_PATH):
        self.database = database
        self.evidence: dict[str, RegisteredEvidence] = {}
        self.trace: list[dict] = []
        self.calls = 0

    def _register(self, item: Evidence | RegisteredEvidence) -> RegisteredEvidence:
        if isinstance(item, Evidence):
            candidate = RegisteredEvidence("", item.title, item.url, item.evidence_date[:10], item.text, "corpus_snapshot", item.document_id)
        else:
            candidate = item
        for existing in self.evidence.values():
            if existing.url == candidate.url and existing.content == candidate.content:
                return existing
        candidate.ref = f"E{len(self.evidence) + 1}"
        self.evidence[candidate.ref] = candidate
        return candidate

    def execute(self, name: str, arguments: dict[str, Any]) -> dict:
        self.calls += 1
        handlers = {
            "corpus_search": self.corpus_search,
            "fact_number_lookup": self.fact_number_lookup,
            "document_read": self.document_read,
            "live_fetch": self.live_fetch,
            "everstake_mcp": self.everstake_mcp,
        }
        if name not in handlers:
            raise ValueError(f"Unsupported tool: {name}")
        result = handlers[name](**arguments)
        self.trace.append({"tool": name, "arguments": arguments, "result": _summary(result)})
        return result

    def corpus_search(self, query: str, mode: str = "factual") -> dict:
        rows, usage = retrieve(query, limit=8 if mode == "synthesis" else 6, database=self.database, prefer_recent=mode != "synthesis")
        rows = adjudicate_evidence(query, mode, rows)
        items = [self._register(row) for row in rows[:6]]
        return {"evidence": [_model_evidence(item) for item in items], "retrieval": usage}

    def fact_number_lookup(self, query: str) -> dict:
        rows, usage = retrieve(query, limit=9, database=self.database, prefer_recent=True)
        rows = adjudicate_evidence(query, "factual", rows)
        numeric = [row for row in rows if re.search(r"(?:\$|\b\d[\d,.]*\s*(?:%|billion|million|thousand|bps|apy|apr)?)", row.text, re.I)]
        items = [self._register(row) for row in (numeric or rows)[:5]]
        return {"evidence": [_model_evidence(item) for item in items], "retrieval": usage}

    def document_read(self, document_id: int) -> dict:
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        row = connection.execute("SELECT * FROM documents WHERE id=? AND is_canonical=1", (document_id,)).fetchone()
        chunks = connection.execute("SELECT text FROM chunks WHERE document_id=? ORDER BY position LIMIT 8", (document_id,)).fetchall()
        connection.close()
        if not row or not chunks:
            return {"error": "Canonical document not found."}
        content = "\n\n".join(item["text"] for item in chunks)[:12000]
        item = self._register(RegisteredEvidence("", row["title"], row["final_url"], (row["modified_at"] or row["published_at"] or row["fetched_at"])[:10], content, "corpus_document", document_id))
        return {"evidence": _model_evidence(item, 6000)}

    def live_fetch(self, url: str) -> dict:
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in LIVE_HOSTS or parsed.username or parsed.password:
            return {"error": "URL is outside the live-fetch allowlist."}
        result = PoliteFetcher(delay=0).get(url)
        if not result:
            return {"error": "Live page could not be fetched under robots policy."}
        _, content_type, body, final_url = result
        final_host = urllib.parse.urlparse(final_url).hostname
        if final_host not in LIVE_HOSTS or "html" not in content_type:
            return {"error": "Redirect or content type is not allowed."}
        title, text, published, modified, _ = extract_html(body)
        sanitized = sanitize_untrusted_text(text)
        date = (modified or published or datetime.now(timezone.utc).date().isoformat())[:10]
        item = self._register(RegisteredEvidence("", title, final_url, date, sanitized.text[:16000], "allowlisted_live_fetch"))
        return {"evidence": _model_evidence(item, 7000), "removed_instruction_passages": len(sanitized.removed_passages), "fetched_at": datetime.now(timezone.utc).isoformat()}

    def everstake_mcp(self, tool: str, arguments: dict | None = None) -> dict:
        if tool not in READ_ONLY_MCP_TOOLS:
            return {"error": "Only allow-listed read-only MCP tools are available."}
        requested = arguments or {}
        # get_chains has no server-side filter. Filter locally before the result
        # reaches the model to reduce cost and prevent cross-chain confusion.
        server_arguments = {} if tool == "get_chains" else requested
        payload = _mcp_call(tool, server_arguments)
        if tool == "get_chains" and requested.get("network"):
            needle = str(requested["network"]).lower()
            data = payload.get("structuredContent", {}).get("data", [])
            payload = {**payload, "structuredContent": {"data": [row for row in data if needle in str(row.get("chain", "")).lower() or needle == str(row.get("currency_code", "")).lower()]}}
        content = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        date = datetime.now(timezone.utc).date().isoformat()
        if tool == "get_chains":
            dates = [str(row.get("updated_at", ""))[:10] for row in payload.get("structuredContent", {}).get("data", []) if row.get("updated_at")]
            date = max(dates) if dates else date
        item = self._register(RegisteredEvidence("", f"Everstake MCP: {tool}", "https://mcp.everstake.com", date, content, f"everstake_mcp:{tool}"))
        return {"evidence": _model_evidence(item, 9000), "fetched_at": datetime.now(timezone.utc).isoformat()}


def _model_evidence(item: RegisteredEvidence, limit: int = 2800) -> dict:
    return {"ref": item.ref, "document_id": item.document_id, "title": item.title, "url": item.url, "date": item.date, "provenance": item.provenance, "content_sha256": sha256_text(item.content), "content": item.content[:limit]}


def _summary(result: dict) -> dict:
    if "error" in result:
        return {"error": result["error"]}
    raw = result.get("evidence", [])
    items = raw if isinstance(raw, list) else [raw]
    return {"evidence": [{key: item.get(key) for key in ("ref", "title", "date", "provenance", "content_sha256")} for item in items]}


def _read_sse_json(response: Any) -> dict:
    text = response.read().decode("utf-8", "replace")
    if not text.strip():
        return {}
    for line in text.splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])
    return json.loads(text)


def _mcp_request(body: dict, session: str | None = None) -> tuple[dict, str | None]:
    headers = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "User-Agent": "EverstakeEvidenceAgent/2.0"}
    if session:
        headers["mcp-session-id"] = session
    request = urllib.request.Request("https://mcp.everstake.com", data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=20) as response:
        return _read_sse_json(response), response.headers.get("mcp-session-id") or session


def _mcp_call(tool: str, arguments: dict) -> dict:
    init, session = _mcp_request({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "everstake-codex", "version": "2.0"}}})
    if "error" in init or not session:
        raise RuntimeError("MCP initialization failed")
    _mcp_request({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}, session)
    result, _ = _mcp_request({"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": tool, "arguments": arguments}}, session)
    if "error" in result:
        raise RuntimeError(f"MCP tool failed: {result['error'].get('message', 'unknown error')}")
    return result.get("result", {})


def load_tool_specs() -> list[dict]:
    return json.loads((ROOT / "agents/tools.json").read_text())
