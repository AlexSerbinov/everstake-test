"""The five evidence tools the model may call, and the bookkeeping around them.

Pipeline position: question → guards → **tool loop (here)** → validation → audit receipt
→ response. `app/agent.py` runs the loop; this module owns what each tool actually does,
what it is allowed to reach, and how every returned passage is registered as citable
evidence with a stable `E<n>` reference.

Two invariants make the rest of the system work:

* **Only evidence registered here can be cited.** `_validate_submission` in agent.py
  rejects any reference that is not a key of `ToolContext.evidence`, so a model cannot
  invent a source — it can only cite something a tool really returned.
* **Reach is allow-listed, never model-chosen.** The model picks *which* URL or MCP tool
  to ask for; `LIVE_HOSTS` and `READ_ONLY_MCP_TOOLS` decide whether it is permitted. If
  those lists were enforced in the prompt instead of here, a prompt injection inside a
  crawled page could talk the model past them.

If this module is wrong, the audit chain still signs faithfully — it would just be
signing a record of the system fetching something it should not have.
"""

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

# Hosts `live_fetch` may contact. Deliberately narrower than the crawler's allowlist
# (pinned by tests/test_tools.py::test_the_live_host_allowlist_is_narrower_than_the_crawl_allowlist):
# crawling happens offline under review, whereas a live fetch happens inside a user
# request and is therefore an SSRF primitive — a URL the *model* chose, executed by the
# server. Restricting it to first-party Everstake hosts stops three attacks at once:
# reaching internal/cloud-metadata addresses, exfiltrating the question to a third-party
# host as a URL path, and laundering an attacker-controlled page into the corpus as if
# it were an Everstake source. `status.everstake.one` is a different TLD and is listed
# explicitly rather than matched by suffix, because suffix matching is what lets
# "everstake.com.evil.example" through.
LIVE_HOSTS = {
    "everstake.com",
    "www.everstake.com",
    "docs.everstake.com",
    "security.everstake.com",
    "status.everstake.one",
}

# MCP tools the agent may invoke on Everstake's own server. Everstake's MCP also exposes
# `request_integration`, which submits a sales lead, and `get_contact_information`.
# Neither is here: a question-answering agent must not be able to take an action in the
# real world or pull contact data, and "the prompt says not to" is not a control. Only
# read-only, idempotent lookups are allow-listed.
READ_ONLY_MCP_TOOLS = {
    "get_chains",
    "get_uptime_metrics",
    "staking_calculator",
    "get_company_profile",
    "get_security_profile",
    "get_products",
}

# How much of an evidence item is shown to the model, per tool. Larger for tools the
# model asked for deliberately (a full document read, a live page, a structured MCP
# payload) than for the many snippets a search returns. All four are hand-tuned to fit a
# five-turn loop inside the 900-token output budget in api_clients.py; no measurement
# backs the exact values. The *hash* always covers the untruncated content, so a
# citation still identifies the whole chunk (see audit.sha256_text).
SEARCH_SNIPPET_CHARS = 2800
DOCUMENT_READ_CHARS = 6000
LIVE_PAGE_CHARS = 7000
MCP_PAYLOAD_CHARS = 9000

# Storage caps applied before truncation-for-the-model, so the stored (and hashed)
# content stays bounded too. Hand-tuned.
DOCUMENT_CONTENT_CHARS = 12000
LIVE_CONTENT_CHARS = 16000

# Retrieval widths. Synthesis needs a wide net across time and pages; a factual lookup
# wants the few best-scoring passages and nothing else. Hand-tuned; no measurement
# backs the exact values.
SYNTHESIS_RETRIEVAL_LIMIT = 20
FACTUAL_RETRIEVAL_LIMIT = 6
NUMBER_LOOKUP_RETRIEVAL_LIMIT = 9
NUMBER_LOOKUP_RESULTS = 5
SYNTHESIS_RESULTS = 8
FACTUAL_RESULTS = 6
# In synthesis mode, reserve this many slots for evidence at or before the earliest year
# the question names, so a "since 2024" answer is forced to actually carry 2024 evidence.
SYNTHESIS_HISTORICAL_ANCHORS = 2
SYNTHESIS_RECENT_SLOTS = 6

# Chunks pulled for a full-document read. Enough to cover the qualifiers that a search
# snippet cuts off, without turning one tool call into the whole page. Hand-tuned.
DOCUMENT_READ_CHUNKS = 8

MCP_ENDPOINT = "https://mcp.everstake.com"
MCP_REQUEST_TIMEOUT_SECONDS = 20


@dataclass
class RegisteredEvidence:
    """One citable passage, with everything needed to re-find and re-check it.

    `ref` is the short handle (`E1`, `E2`, …) the model cites and validation resolves.
    It is empty at construction and filled in by `ToolContext._register`, because a
    reference number is only meaningful relative to one question's evidence set.
    `provenance` records *how* the passage was obtained (corpus snapshot, live fetch,
    MCP tool), which is what lets a reviewer weigh a frozen snapshot against a live
    reading of the same page.
    """

    ref: str
    title: str
    url: str
    date: str
    content: str
    provenance: str
    document_id: int | None = None

    def audit_dict(self) -> dict:
        """The full record of this evidence for the signed audit log.

        Unlike `_model_evidence`, this keeps the content **untruncated** and adds its
        hash: the audit record must show exactly what the system had, not the excerpt
        the model was shown.
        """
        return {**asdict(self), "content_sha256": sha256_text(self.content)}


class ToolContext:
    """Per-question state for the tool loop: what was found, and what was spent.

    One instance lives for one call to `run_agent`. It exists so that evidence
    references are scoped to a single question — `E1` in one answer has nothing to do
    with `E1` in the next — and so the audit trace records the tool calls of that one
    question and no other.
    """

    def __init__(self, database: Path = DB_PATH):
        """Start an empty evidence set for one question against one index file.

        The database path is injectable so tests can point at a file that does not
        exist — every allowlist rejection returns before SQLite is opened, which proves
        those checks never touch the corpus.
        """
        self.database = database
        # ref -> evidence. Insertion-ordered, which is what makes E-numbers stable.
        self.evidence: dict[str, RegisteredEvidence] = {}
        # Summarised call log written verbatim into the signed audit record.
        self.trace: list[dict] = []
        # Tool-call counter. The real budget is enforced by the turn loop in agent.py;
        # this is the observable count for tests and diagnostics.
        self.calls = 0

    def _register(self, item: Evidence | RegisteredEvidence) -> RegisteredEvidence:
        """Give a passage a citable `E<n>` reference, reusing one if it is a repeat.

        De-duplication is on (url, content) rather than url alone: two chunks of the
        same page are genuinely distinct evidence and must be citable apart, but the
        same chunk arriving twice — from a search and then from a document read — must
        not become two references, or a single-source answer could masquerade as
        corroborated by citing both.
        """
        candidate = _as_registered_evidence(item)
        for existing in self.evidence.values():
            if existing.url == candidate.url and existing.content == candidate.content:
                return existing
        candidate.ref = f"E{len(self.evidence) + 1}"
        self.evidence[candidate.ref] = candidate
        return candidate

    def execute(self, name: str, arguments: dict[str, Any]) -> dict:
        """Dispatch one model-requested tool call and record it in the audit trace.

        The dispatch table is the enforcement point for "the model may only do these
        five things": an unknown name raises rather than falling through to anything.
        Arguments are splatted, so a schema-violating argument name raises a TypeError
        that agent.py catches and reports back to the model as a tool error.
        """
        # KNOWN LIMITATION: the counter is incremented before the name is validated, so
        # a hallucinated tool name still consumes a call. Pinned in
        # tests/test_tools.py::test_the_call_counter_increments_even_for_a_rejected_tool_name.
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
        # Only the summary goes into the trace — never the passage text. The trace is
        # signed and stored forever, so it must not become a second copy of the corpus.
        self.trace.append({"tool": name, "arguments": arguments, "result": _summary(result)})
        return result

    def corpus_search(self, query: str, mode: str = "factual") -> dict:
        """Search the frozen, sanitised corpus — the default first move for any question.

        Mode changes the shape of the answer being built, so it changes retrieval:
        a factual question wants the few best and freshest passages, a synthesis
        question wants breadth across time and must not be biased toward "now".
        """
        rows, usage = retrieve(
            query,
            limit=SYNTHESIS_RETRIEVAL_LIMIT if mode == "synthesis" else FACTUAL_RETRIEVAL_LIMIT,
            database=self.database,
            prefer_recent=mode != "synthesis",
        )
        rows = adjudicate_evidence(query, mode, rows)
        if mode == "synthesis":
            rows = _rebalance_for_synthesis(query, rows)
        result_count = SYNTHESIS_RESULTS if mode == "synthesis" else FACTUAL_RESULTS
        items = [self._register(row) for row in rows[:result_count]]
        return {"evidence": [_model_evidence(item) for item in items], "retrieval": usage}

    def fact_number_lookup(self, query: str) -> dict:
        """Find passages that actually contain a literal value, not just the topic.

        Separate from `corpus_search` because embedding similarity happily returns a
        page *about* fees that never states one. For "what is the fee", a passage with
        no number in it is not evidence, so numeric passages are promoted ahead of
        merely relevant ones.
        """
        rows, usage = retrieve(query, limit=NUMBER_LOOKUP_RETRIEVAL_LIMIT,
                               database=self.database, prefer_recent=True)
        rows = adjudicate_evidence(query, "factual", rows)
        numeric = [row for row in rows if _contains_literal_value(row.text)]
        # Fall back to the unfiltered rows rather than returning nothing: an empty
        # result teaches the model nothing, whereas the topical passages let it see for
        # itself that no figure is published and abstain for the right reason.
        items = [self._register(row) for row in (numeric or rows)[:NUMBER_LOOKUP_RESULTS]]
        return {"evidence": [_model_evidence(item) for item in items], "retrieval": usage}

    def document_read(self, document_id: int) -> dict:
        """Read the head of one canonical document to recover context a snippet cut off.

        Restricted to `is_canonical=1` so a de-duplicated syndication copy cannot be
        read and cited as an independent second source — that would defeat the
        "two distinct sources" rule synthesis answers are held to.
        """
        row, chunks = self._read_canonical_document(document_id)
        if not row or not chunks:
            return {"error": "Canonical document not found."}
        content = "\n\n".join(item["text"] for item in chunks)[:DOCUMENT_CONTENT_CHARS]
        item = self._register(RegisteredEvidence(
            "",
            row["title"],
            row["final_url"],
            _document_evidence_date(row),
            content,
            "corpus_document",
            document_id,
        ))
        return {"evidence": _model_evidence(item, DOCUMENT_READ_CHARS)}

    def _read_canonical_document(self, document_id: int) -> tuple[Any, list[Any]]:
        """Fetch the document row and its leading chunks in one short-lived connection.

        A fresh connection per call rather than a shared one: the HTTP server is
        threaded and a SQLite connection is not safe to share across threads.
        """
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        try:
            row = connection.execute(
                "SELECT * FROM documents WHERE id=? AND is_canonical=1",
                (document_id,),
            ).fetchone()
            chunks = connection.execute(
                "SELECT text FROM chunks WHERE document_id=? ORDER BY position LIMIT ?",
                (document_id, DOCUMENT_READ_CHUNKS),
            ).fetchall()
        finally:
            connection.close()
        return row, chunks

    def live_fetch(self, url: str) -> dict:
        """Fetch one allow-listed HTTPS page when the frozen snapshot may be stale.

        Every check below runs *before* the request, or on the response, rather than
        being left to the crawler — this is the one tool where the target URL comes from
        the model, i.e. ultimately from text an attacker may have written.
        """
        if not _is_allowlisted_live_url(url):
            return {"error": "URL is outside the live-fetch allowlist."}
        result = PoliteFetcher(delay=0).get(url)
        # delay=0 because this is inside a user request and the polite crawl delay would
        # show up as latency; a single page load is not a crawl. Robots is still honoured
        # by PoliteFetcher, and a disallowed page comes back as None.
        if not result:
            return {"error": "Live page could not be fetched under robots policy."}
        _, content_type, body, final_url = result
        # Re-check after redirects: an allow-listed URL that 302s off-domain would
        # otherwise smuggle third-party content in under an Everstake provenance label.
        final_host = urllib.parse.urlparse(final_url).hostname
        if final_host not in LIVE_HOSTS or "html" not in content_type:
            return {"error": "Redirect or content type is not allowed."}
        return self._register_live_page(body, final_url)

    def _register_live_page(self, body: bytes, final_url: str) -> dict:
        """Sanitise a fetched page and register it as evidence.

        The sanitiser runs on live text for the same reason it runs at ingestion: a page
        edited between the crawl and now is exactly where a fresh injection would appear.
        The count of removed passages is reported to the model so it can see that the
        page tried something.
        """
        title, text, published, modified, _ = extract_html(body)
        sanitized = sanitize_untrusted_text(text)
        # Prefer the page's own modified date, then published, and only fall back to
        # "today" when the page is undated — an undated page is not evidence that a
        # value changed today, but the answer still needs an as-of date to show.
        date = (modified or published or datetime.now(timezone.utc).date().isoformat())[:10]
        item = self._register(RegisteredEvidence(
            "", title, final_url, date, sanitized.text[:LIVE_CONTENT_CHARS], "allowlisted_live_fetch",
        ))
        return {
            "evidence": _model_evidence(item, LIVE_PAGE_CHARS),
            "removed_instruction_passages": len(sanitized.removed_passages),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }

    def everstake_mcp(self, tool: str, arguments: dict | None = None) -> dict:
        """Call one read-only tool on Everstake's own MCP server for live operational data.

        This is the only source of truth for values that change hourly — APR/APY, chain
        status, uptime — which a frozen corpus can only ever report staleley.
        """
        if tool not in READ_ONLY_MCP_TOOLS:
            return {"error": "Only allow-listed read-only MCP tools are available."}
        requested = arguments or {}
        payload = _mcp_call(tool, _server_arguments_for(tool, requested))
        if tool == "get_chains" and requested.get("network"):
            payload = _filter_chains_by_network(payload, str(requested["network"]))
        # Store the payload canonically (sorted keys) so the same MCP response always
        # hashes to the same value and two identical calls de-duplicate in `_register`.
        content = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        item = self._register(RegisteredEvidence(
            "",
            f"Everstake MCP: {tool}",
            MCP_ENDPOINT,
            _mcp_evidence_date(tool, payload),
            content,
            f"everstake_mcp:{tool}",
        ))
        return {
            "evidence": _model_evidence(item, MCP_PAYLOAD_CHARS),
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }


def _as_registered_evidence(item: Evidence | RegisteredEvidence) -> RegisteredEvidence:
    """Normalise a retrieval hit into the citable shape, leaving `ref` for the caller.

    `Evidence` (from retrieval) and `RegisteredEvidence` differ because retrieval also
    carries scoring fields that have no business in an audit record.
    """
    if not isinstance(item, Evidence):
        return item
    return RegisteredEvidence(
        "",
        item.title,
        item.url,
        # Dates arrive as full timestamps; evidence is dated to the day, because the
        # as-of line shown to the user is a date and a false precision of seconds would
        # imply the system knows when a value changed.
        item.evidence_date[:10],
        item.text,
        "corpus_snapshot",
        item.document_id,
    )


def _rebalance_for_synthesis(query: str, rows: list[Evidence]) -> list[Evidence]:
    """Force a "how has X changed since YYYY" search to carry evidence from both ends.

    Two problems this fixes, in order. First, several chunks of one current canonical
    page otherwise crowd out older material entirely, so the result set looks rich while
    describing a single moment. Second, even after that, purely score-ordered results
    skew recent, so a "since 2024" answer can end up citing nothing from 2024 and merely
    *sounding* temporal — which the year-straddle check in agent.py would then reject.
    """
    # One row per document: chunk-level duplicates of the same page are not breadth.
    unique: list[Evidence] = []
    seen_documents = set()
    for row in rows:
        if row.document_id not in seen_documents:
            unique.append(row)
            seen_documents.add(row.document_id)
    requested_years = [int(value) for value in re.findall(r"20\d{2}", query)]
    # Anchors: evidence dated at or before the earliest year the question names.
    anchors = [
        row for row in unique
        if requested_years and int(row.evidence_date[:4]) <= min(requested_years)
    ]
    remainder = [row for row in unique if row not in anchors]
    return anchors[:SYNTHESIS_HISTORICAL_ANCHORS] + remainder[:SYNTHESIS_RECENT_SLOTS]


# Matches a passage that states an actual value: a dollar amount, or a digit-led number
# optionally carrying a unit. Examples it accepts: "$1,200", "7%", "3.5 billion",
# "12 bps", "4.2 apy". The unit group is optional, so a bare "85" also counts — a legal
# registration number or a network count is a literal value too.
_LITERAL_VALUE = re.compile(
    r"(?:\$|\b\d[\d,.]*\s*(?:%|billion|million|thousand|bps|apy|apr)?)",
    re.I,
)


def _contains_literal_value(text: str) -> bool:
    """Whether a passage states a number, as opposed to merely discussing the topic."""
    return bool(_LITERAL_VALUE.search(text))


def _document_evidence_date(row: Any) -> str:
    """Date a whole document by the most specific timestamp it has.

    Modified beats published beats fetched: the question a reader is really asking is
    "how old is this claim", and a page revised last week is fresher evidence than its
    2019 publication date suggests. `fetched_at` is the last resort and is always
    present, so this cannot return None.
    """
    return (row["modified_at"] or row["published_at"] or row["fetched_at"])[:10]


def _server_arguments_for(tool: str, requested: dict) -> dict:
    """Translate the model's arguments into what the MCP server actually accepts."""
    if tool == "get_chains":
        # get_chains has no server-side filter, so sending the model's `network` would
        # be ignored anyway. Send nothing and filter locally instead — that keeps the
        # payload the model sees small and stops cross-chain confusion.
        return {}
    if tool == "staking_calculator":
        # The model conflates `network` and `currency`; the server needs both. Mirror
        # whichever one was supplied into the other rather than failing the call.
        network = requested.get("network") or requested.get("currency")
        currency = requested.get("currency") or requested.get("network")
        # amount=1 is the neutral rate probe documented in prompts/agent-system.txt: the
        # calculator's reward figure is illustrative and must not be reported, but at
        # one unit the rate it implies is the APY the question asked for.
        return {"network": network, "currency": currency, "amount": requested.get("amount", 1)}
    return requested


def _filter_chains_by_network(payload: dict, network: str) -> dict:
    """Keep only the rows for the network the question is about.

    Matching is substring-on-chain-name OR exact-on-ticker: "solana" should match the
    chain named "Solana", but "eth" must not match every chain whose ticker merely
    contains those letters, so the ticker comparison is exact.
    """
    needle = network.lower()
    data = payload.get("structuredContent", {}).get("data", [])
    matching = [
        row for row in data
        if needle in str(row.get("chain", "")).lower()
        or needle == str(row.get("currency_code", "")).lower()
    ]
    return {**payload, "structuredContent": {"data": matching}}


def _mcp_evidence_date(tool: str, payload: dict) -> str:
    """Date an MCP result by the data itself where the data says so.

    For `get_chains` the rows carry their own `updated_at`, and the newest of those is a
    truthful as-of date for the answer. Every other tool returns a live reading with no
    embedded timestamp, so the fetch date is the honest answer.
    """
    today = datetime.now(timezone.utc).date().isoformat()
    if tool != "get_chains":
        return today
    rows = payload.get("structuredContent", {}).get("data", [])
    dates = [str(row.get("updated_at", ""))[:10] for row in rows if row.get("updated_at")]
    return max(dates) if dates else today


def _model_evidence(item: RegisteredEvidence, limit: int = SEARCH_SNIPPET_CHARS) -> dict:
    """The view of one evidence item that is sent to the model.

    Content is truncated to fit the context budget, but `content_sha256` is computed
    over the **whole** content, not the truncated slice. That is the point: the model
    cites a reference, and the hash in the audit record identifies the entire chunk a
    reviewer can go and re-read — not the excerpt that happened to fit.
    """
    return {
        "ref": item.ref,
        "document_id": item.document_id,
        "title": item.title,
        "url": item.url,
        "date": item.date,
        "provenance": item.provenance,
        "content_sha256": sha256_text(item.content),
        "content": item.content[:limit],
    }


# Fields of an evidence item that are safe and useful to keep in the permanent trace:
# enough to say what was returned, with the hash standing in for the text itself.
_TRACE_EVIDENCE_FIELDS = ("ref", "title", "date", "provenance", "content_sha256")


def _summary(result: dict) -> dict:
    """Shrink a tool result to what belongs in the signed audit trace.

    The trace is written into every audit record and kept forever, so copying passage
    text into it would duplicate the corpus inside the log and bloat every receipt. The
    content hash carries the same evidentiary weight in a fraction of the bytes.
    """
    if "error" in result:
        return {"error": result["error"]}
    raw = result.get("evidence", [])
    # document_read and the live tools return a single evidence object; the search tools
    # return a list. Normalise so the trace shape is the same either way.
    items = raw if isinstance(raw, list) else [raw]
    return {"evidence": [{key: item.get(key) for key in _TRACE_EVIDENCE_FIELDS} for item in items]}


# Length of the SSE field prefix "data: ", skipped when parsing the payload.
_SSE_DATA_PREFIX = "data: "


def _read_sse_json(response: Any) -> dict:
    """Read one JSON object from an MCP response, whichever transport it used.

    The MCP endpoint advertises both `application/json` and `text/event-stream` and may
    answer with either, so this accepts both rather than pinning a content type. Only
    the first `data:` line is read: every call here is a single request/response
    exchange, not a subscription.
    """
    text = response.read().decode("utf-8", "replace")
    if not text.strip():
        # A notification (`notifications/initialized`) is answered with an empty body.
        return {}
    for line in text.splitlines():
        if line.startswith(_SSE_DATA_PREFIX):
            return json.loads(line[len(_SSE_DATA_PREFIX):])
    return json.loads(text)


def _mcp_request(body: dict, session: str | None = None) -> tuple[dict, str | None]:
    """Send one JSON-RPC message to the MCP endpoint and return (result, session id).

    The session id is threaded back out because MCP requires every call after
    `initialize` to carry it; the server may also re-issue it, so the response header
    wins over the value passed in.
    """
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "EverstakeEvidenceAgent/2.0",
    }
    if session:
        headers["mcp-session-id"] = session
    request = urllib.request.Request(
        MCP_ENDPOINT,
        data=json.dumps(body).encode(),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=MCP_REQUEST_TIMEOUT_SECONDS) as response:
        return _read_sse_json(response), response.headers.get("mcp-session-id") or session


def _mcp_call(tool: str, arguments: dict) -> dict:
    """Run the full MCP handshake and invoke one tool.

    The three-step handshake (initialize → initialized notification → tools/call) is
    required by the MCP spec and is redone per call rather than cached, because a cached
    session would be shared across HTTP worker threads. Failures raise rather than
    return an error dict: agent.py converts an exception into a tool-error message for
    the model, so a dead MCP degrades into an abstention instead of a wrong answer.
    """
    init, session = _mcp_request({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            # Pinned protocol version: an unpinned client can be handed a newer dialect
            # mid-deployment and start failing on responses it used to understand.
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "everstake-codex", "version": "2.0"},
        },
    })
    if "error" in init or not session:
        raise RuntimeError("MCP initialization failed")
    _mcp_request({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}, session)
    result, _ = _mcp_request({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }, session)
    if "error" in result:
        raise RuntimeError(f"MCP tool failed: {result['error'].get('message', 'unknown error')}")
    return result.get("result", {})


def _is_allowlisted_live_url(url: str) -> bool:
    """Whether `live_fetch` may request this URL at all.

    Each clause blocks a real attack shape, all pinned in
    tests/test_tools.py::LiveFetchAllowlistTests:
      * scheme must be https — stops `file:///etc/passwd` and plaintext downgrade;
      * hostname must be an exact allowlist member — stops `evil.example` and the
        lookalike `everstake.com.evil.example`, which a suffix check would accept;
      * no username/password — stops `https://everstake.com@evil.example/x`, where the
        part before the `@` is userinfo and the real host is `evil.example`. A human
        reading that URL sees "everstake.com"; the parser does not.
    """
    parsed = urllib.parse.urlparse(url)
    return (
        parsed.scheme == "https"
        and parsed.hostname in LIVE_HOSTS
        and not parsed.username
        and not parsed.password
    )


def load_tool_specs() -> list[dict]:
    """Read the function schemas the model is offered.

    Loaded from `agents/tools.json` at call time rather than hard-coded, so the schema a
    reviewer reads is provably the schema the deployed agent uses.
    """
    return json.loads((ROOT / "agents/tools.json").read_text())
