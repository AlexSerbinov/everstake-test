from __future__ import annotations

import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .config import DB_PATH, PORT, ROOT
from .agent import run_agent
from .audit import get_record, public_key_b64

WEB = ROOT / "web"


class Handler(BaseHTTPRequestHandler):
    server_version = "EverstakeKnowledgeAssistant/1.0"

    def _json(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def _security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200 if DB_PATH.exists() else 503, {"status": "ok" if DB_PATH.exists() else "index_missing"})
            return
        if self.path == "/api/stats":
            path = DB_PATH.with_name("index-stats.json")
            self._json(200, json.loads(path.read_text()))
            return
        if self.path == "/api/audit/public-key":
            self._json(200, {"algorithm": "Ed25519", "encoding": "base64", "public_key": public_key_b64(), "hash_chain": "SHA-256(previous_hash || canonical_record)"})
            return
        if self.path.startswith("/api/audit/"):
            record = get_record(self.path.removeprefix("/api/audit/").split("?", 1)[0])
            self._json(200 if record else 404, record or {"error": "Audit record not found."})
            return
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
        if self.path not in {"/api/query", "/api/query/stream"}:
            self.send_error(404)
            return
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 20_000)
            payload = json.loads(self.rfile.read(length))
            question = str(payload.get("question", "")).strip()
            mode = str(payload.get("mode", "auto"))
            if not 3 <= len(question) <= 1000 or mode not in {"auto", "factual", "synthesis"}:
                self._json(400, {"error": "Provide a question (3–1000 characters) and a valid mode."})
                return
            if self.path == "/api/query/stream":
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache, no-transform")
                self.send_header("Connection", "keep-alive")
                self.send_header("X-Accel-Buffering", "no")
                self._security_headers()
                self.end_headers()

                def emit(event: str, data: dict) -> None:
                    self.wfile.write(f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode())
                    self.wfile.flush()

                run_agent(question, mode, emit=emit)
            else:
                self._json(200, run_agent(question, mode))
        except Exception as error:
            if self.path == "/api/query/stream":
                try:
                    self.wfile.write(f"event: error\ndata: {json.dumps({'error': f'Query failed: {type(error).__name__}'})}\n\n".encode())
                    self.wfile.flush()
                except Exception:
                    pass
            else:
                self._json(500, {"error": f"Query failed: {type(error).__name__}"})

    def log_message(self, format: str, *args) -> None:
        print(f"{self.address_string()} {format % args}")


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Serving on http://0.0.0.0:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
