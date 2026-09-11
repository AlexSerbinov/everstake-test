from __future__ import annotations

import json
import mimetypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from .config import DB_PATH, PORT, ROOT
from .retrieval import answer

WEB = ROOT / "web"


class Handler(BaseHTTPRequestHandler):
    server_version = "EverstakeKnowledgeAssistant/1.0"

    def _json(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200 if DB_PATH.exists() else 503, {"status": "ok" if DB_PATH.exists() else "index_missing"})
            return
        if self.path == "/api/stats":
            path = DB_PATH.with_name("index-stats.json")
            self._json(200, json.loads(path.read_text()))
            return
        target = WEB / ("index.html" if self.path == "/" else self.path.lstrip("/"))
        if not target.is_file() or WEB not in target.resolve().parents:
            self.send_error(404)
            return
        body = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(target)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        if self.path != "/api/query":
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
            self._json(200, answer(question, mode))
        except Exception as error:
            self._json(500, {"error": f"Query failed: {type(error).__name__}"})

    def log_message(self, format: str, *args) -> None:
        print(f"{self.address_string()} {format % args}")


def main() -> None:
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Serving on http://0.0.0.0:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()

