"""The HTTP surface: a stdlib server that fronts the agent and the audit log.

Pipeline position: this is the entry and exit. A browser posts a question here, the
request is validated, `app/agent.py::run_agent` does the work, and the result leaves
either as one JSON body or as a stream of SSE events that let the UI show the pipeline
as it happens. The same process also serves the static UI from `web/` and exposes the
audit log for verification.

Routes (all part of the public contract — README.md documents them and the UI calls them):
  GET  /health                  liveness plus "is the index actually present"
  GET  /api/stats               the frozen index's build statistics
  GET  /api/costs               generated measured cost/resource report
  GET  /api/freshness           active policy, measured calculator, refresh/change log
  GET  /api/audit/public-key    the Ed25519 verification key, for offline checking
  GET  /api/audit/<id>          one audit record with a verdict on the chain up to it
  GET  /<path>                  static files from web/
  POST /api/query               answer, one JSON response
  POST /api/query/stream        answer, streamed as SSE (thinking, tool_call,
                                tool_result, verification, answer, error)

Built on `http.server` on purpose: no framework means no dependency the reviewer has to
audit, and the whole request path fits in one readable file. It is `ThreadingHTTPServer`
because a query takes seconds of network wait, so a single-threaded server would let one
question block the UI's own static assets.

If the validation in `do_POST` is wrong, an unbounded body or question reaches the model
and the cost ceiling stops being enforced anywhere.
"""

from __future__ import annotations

import json
import mimetypes
import sqlite3
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .config import COST_REPORT_PATH, DB_PATH, PORT, ROOT
from .agent import run_agent
from .audit import get_record, public_key_b64
from .freshness import calculator_payload
from .refresh import freshness_status

WEB = ROOT / "web"

# Largest request body read. A question is capped at 1000 characters below, so 20 kB is
# already generous; the cap exists so a malicious client cannot make the server buffer an
# arbitrary amount before validation gets a chance to reject it. Hand-tuned.
MAX_REQUEST_BODY_BYTES = 20_000

# Question length bounds. The floor rejects accidental submits ("hi"), which would
# otherwise cost a full agent run; the ceiling keeps one question from dominating the
# model's context window. Hand-tuned; no measurement backs the exact values.
MIN_QUESTION_CHARS = 3
MAX_QUESTION_CHARS = 1000

VALID_MODES = {"auto", "factual", "synthesis"}

# How the audit chain is built, echoed to clients so a third party can re-verify a
# receipt without reading this source. Must stay in step with app/audit.py::_hash_record.
AUDIT_CHAIN_DESCRIPTION = "SHA-256(previous_hash || canonical_record)"


class Handler(BaseHTTPRequestHandler):
    server_version = "EverstakeKnowledgeAssistant/1.0"

    def _json(self, status: int, body: dict) -> None:
        """Write one JSON response with an explicit length and no caching.

        `Content-Length` is set explicitly rather than relying on chunking, so the
        browser knows when a response is complete even though `Connection: close` is
        used on the streaming route. `no-store` because every answer carries a fresh
        audit receipt — a cached one would show a receipt id that does not match the
        question on screen.
        """
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self._security_headers()
        self.end_headers()
        self.wfile.write(encoded)

    def _security_headers(self) -> None:
        """Headers sent on every response, static assets included.

        The CSP is the load-bearing one and is deliberately strict. `script-src 'self'`
        with no `unsafe-inline` means the UI has to live in `web/app.js` as a real file,
        so an injected string can never execute as script. `connect-src 'self'` stops a
        compromised page exfiltrating an answer to a third-party host. `frame-ancestors
        'none'` blocks clickjacking, and `base-uri 'none'` stops a `<base>` tag from
        re-pointing every relative URL on the page. `nosniff` keeps the browser from
        re-interpreting a text file as script, and `no-referrer` keeps question text out
        of the Referer header on any outbound link the answer renders.
        """
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; "
            "connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        )

    def do_GET(self) -> None:
        """Route a GET to an API handler, or fall through to the static UI."""
        if self.path == "/health":
            self._serve_health()
            return
        if self.path == "/api/stats":
            self._serve_index_stats()
            return
        if self.path == "/api/costs":
            self._json(200, json.loads(COST_REPORT_PATH.read_text()))
            return
        if self.path == "/api/freshness":
            self._json(200, {"calculator": calculator_payload(), "status": freshness_status()})
            return
        if self.path.startswith("/api/corpus"):
            self._serve_corpus()
            return
        if self.path == "/api/audit/public-key":
            self._serve_audit_public_key()
            return
        # Checked after the exact public-key route above, because that path also starts
        # with the audit prefix and would otherwise be read as a record id.
        if self.path.startswith("/api/audit/"):
            self._serve_audit_record()
            return
        self._serve_static_file()

    def _serve_health(self) -> None:
        """Liveness that actually checks the thing that breaks.

        Reports 503 when the SQLite index is missing, because the process starts and
        serves pages perfectly well without it while being unable to answer anything —
        a health check that only proved "the port is open" would call that healthy.
        """
        index_present = DB_PATH.exists()
        self._json(200 if index_present else 503,
                   {"status": "ok" if index_present else "index_missing"})

    def _serve_index_stats(self) -> None:
        """Serve the index build statistics written next to the database.

        Read from disk per request rather than cached, so a rebuild by `app.refresh`
        shows up without restarting the server. A missing file raises and becomes a 500
        via the server's own error handling — the stats endpoint is diagnostics, and a
        silent empty body would be worse than a visible failure.
        """
        path = DB_PATH.with_name("index-stats.json")
        self._json(200, json.loads(path.read_text()))

    def _serve_corpus(self) -> None:
        """Expose speaker-aware document metadata, never transcript bodies."""
        voice = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get("voice", [""])[0]
        allowed = {"first_party_channel", "employee_on_third_party", "third_party"}
        if voice and voice not in allowed:
            self._json(400, {"error": "Unknown voice filter."})
            return
        connection = sqlite3.connect(DB_PATH)
        connection.row_factory = sqlite3.Row
        try:
            where, params = ("WHERE voice=?", (voice,)) if voice else ("", ())
            rows = connection.execute(
                "SELECT id,title,final_url url,published_at,voice,speakers,attribution,claim_provenance,"
                "trust_penalty,trust_penalty_reason,unverified_claims FROM documents " + where +
                " ORDER BY COALESCE(published_at,fetched_at) DESC LIMIT 200", params,
            ).fetchall()
            counts = dict(connection.execute("SELECT voice,COUNT(*) FROM documents GROUP BY voice").fetchall())
        finally:
            connection.close()
        self._json(200, {"counts": counts, "documents": [
            {**dict(row), "speakers": json.loads(row["speakers"] or "[]"),
             "unverified": bool(row["unverified_claims"])} for row in rows
        ]})

    def _serve_audit_public_key(self) -> None:
        """Publish everything needed to verify a receipt without trusting this server."""
        self._json(200, {
            "algorithm": "Ed25519",
            "encoding": "base64",
            "public_key": public_key_b64(),
            "hash_chain": AUDIT_CHAIN_DESCRIPTION,
        })

    def _serve_audit_record(self) -> None:
        """Return one audit record by id, with its chain verdict.

        The query string is stripped before lookup so a link carrying tracking
        parameters still resolves. A 404 is returned for an unknown id rather than a
        400: from the client's side "no such receipt" is the same answer either way, and
        distinguishing them would confirm which ids exist.
        """
        record_id = self.path.removeprefix("/api/audit/").split("?", 1)[0]
        record = get_record(record_id)
        self._json(200 if record else 404, record or {"error": "Audit record not found."})

    def _serve_static_file(self) -> None:
        """Serve the UI from web/, refusing anything that escapes that directory.

        `resolve()` collapses `..` and symlinks *before* the containment check, so
        `/../.env` and a symlink planted inside web/ both fail it. The check is against
        the resolved parents rather than a string prefix, because a string prefix would
        happily accept a sibling directory named `web-backup`.
        """
        target = WEB / ("index.html" if self.path == "/" else self.path.lstrip("/"))
        if not target.is_file() or WEB not in target.resolve().parents:
            self.send_error(404)
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(target)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self._security_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        """Handle the two query routes; everything else is a 404.

        The whole body is wrapped in one try/except because an agent run touches the
        network, the model API, SQLite and the filesystem. Any of those can fail, and a
        traceback escaping here would kill the connection mid-stream and leave the UI
        spinning forever.
        """
        if self.path not in {"/api/query", "/api/query/stream"}:
            self.send_error(404)
            return
        try:
            question, mode = self._read_query_request()
            if question is None:
                return
            if self.path == "/api/query/stream":
                self._answer_streaming(question, mode)
            else:
                self._json(200, run_agent(question, mode))
        except Exception as error:
            self._report_failure(error)

    def _read_query_request(self) -> tuple[str | None, str]:
        """Parse and validate the request body, answering 400 itself if it is bad.

        Returns `(None, ...)` to mean "already responded, stop" — the caller must not
        write a second response. Validation happens here rather than inside the agent so
        a junk request never reaches a paid model call.
        """
        length = min(int(self.headers.get("Content-Length", "0")), MAX_REQUEST_BODY_BYTES)
        payload = json.loads(self.rfile.read(length))
        question = str(payload.get("question", "")).strip()
        mode = str(payload.get("mode", "auto"))
        if not MIN_QUESTION_CHARS <= len(question) <= MAX_QUESTION_CHARS or mode not in VALID_MODES:
            # One message for both failures: the client is the UI, which cannot recover
            # differently, and the range is stated so a human sees what to fix.
            self._json(400, {"error": "Provide a question (3–1000 characters) and a valid mode."})
            return None, mode
        return question, mode

    def _answer_streaming(self, question: str, mode: str) -> None:
        """Run the agent and push each pipeline step to the browser as an SSE event.

        Streaming exists because an answer takes several seconds of tool calls; showing
        the tool trace as it happens is also the demonstration that the answer came from
        tools rather than from model memory.
        """
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        # `no-transform` matters as much as `no-cache`: a proxy that gzips the stream
        # would buffer it, and the events would all arrive at once at the end.
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "close")
        # Nginx-specific: without it, nginx buffers the response and defeats streaming.
        self.send_header("X-Accel-Buffering", "no")
        self._security_headers()
        self.end_headers()
        # No Content-Length is sent, so the end of the body is the end of the
        # connection. Marking it closed here tells BaseHTTPRequestHandler not to try to
        # keep it alive for a following request.
        self.close_connection = True

        def emit(event: str, data: dict) -> None:
            """Write one SSE frame: an event name, its JSON payload, and a blank line.

            The blank line is the terminator the browser splits on — web/app.js buffers
            until it sees `\\n\\n`, so omitting it would stall the UI mid-run.
            """
            # Flushed per event; without the flush Python's buffering would hold the
            # events until the run finished, which is the thing streaming exists to avoid.
            self.wfile.write(
                f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()
            )
            self.wfile.flush()

        run_agent(question, mode, emit=emit)

    def _report_failure(self, error: Exception) -> None:
        """Report a failed query without leaking internals.

        Only the exception class name is sent — a message can carry a filesystem path,
        an API key fragment from an upstream error, or a URL. On the streaming route the
        headers are already on the wire, so the failure has to arrive as an `error`
        event rather than a status code; if even that write fails the client has gone
        away, and there is nothing left to say.
        """
        detail = {"error": f"Query failed: {type(error).__name__}"}
        if self.path != "/api/query/stream":
            self._json(500, detail)
            return
        try:
            self.wfile.write(f"event: error\ndata: {json.dumps(detail)}\n\n".encode())
            self.wfile.flush()
        except Exception:
            pass

    def log_message(self, format: str, *args) -> None:
        """Log to stdout instead of stderr so journald/docker logs read in order.

        Overriding also drops the default timestamp prefix, which duplicates the one the
        log collector adds.
        """
        print(f"{self.address_string()} {format % args}")


def main() -> None:
    """Run the server in the foreground.

    Binds 0.0.0.0 because the deployed instance runs in a container and must accept
    connections from outside it; there is no TLS here, that is the reverse proxy's job.
    """
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Serving on http://0.0.0.0:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
