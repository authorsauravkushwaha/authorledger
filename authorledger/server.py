"""
server.py — a small stdlib-only web server for AuthorLedger.

Serves the static frontend (web/) and a small JSON API. No Flask, no
Django, no third-party web framework — just ``http.server`` from the
standard library. That's a deliberate choice, not a limitation: it means
`git clone` + `python3 main.py` is the entire install process.
"""

from __future__ import annotations

import json
import mimetypes
import re
import sqlite3
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse

from . import analysis, database, llm_assist, reports

WEB_DIR = Path(__file__).resolve().parent.parent / "web"

# 10 MB is generous for even a very long chapter (a 10MB text file is
# roughly 1.5-2 million words) and stops a runaway or malicious request
# body from being read into memory unbounded.
MAX_BODY_BYTES = 10 * 1024 * 1024

# If a client claims a body bigger than MAX_BODY_BYTES, we still drain up
# to this many bytes off the socket (in small chunks, never holding it
# all in memory) before responding, so a merely-too-big request gets a
# clean 400 instead of the client seeing a broken pipe. Beyond this, we
# stop being polite about it -- nothing legitimate needs a 50MB request
# body here.
DRAIN_CAP_BYTES = 50 * 1024 * 1024
_DRAIN_CHUNK = 65536

# AuthorLedger only ever binds to 127.0.0.1 (see run(), below), but this
# extra check costs nothing and rejects requests whose Host header doesn't
# match — a cheap second layer against a browser tab on some other site
# trying to poke at a server it happens to guess is running locally.
def _host_is_allowed(host_header: str | None, port: int) -> bool:
    if not host_header:
        return False
    host = host_header.split(",")[0].strip().lower()
    return host in (f"localhost:{port}", f"127.0.0.1:{port}", "localhost", "127.0.0.1")

# (regex, method) -> handler name. Handlers receive (self, match, body).
ROUTES: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"^/api/status$"), "GET", "handle_status"),
    (re.compile(r"^/api/books$"), "GET", "handle_list_books"),
    (re.compile(r"^/api/books$"), "POST", "handle_create_book"),
    (re.compile(r"^/api/books/(?P<book_id>\d+)$"), "GET", "handle_get_book"),
    (re.compile(r"^/api/books/(?P<book_id>\d+)$"), "DELETE", "handle_delete_book"),
    (re.compile(r"^/api/books/(?P<book_id>\d+)/chapters$"), "POST", "handle_create_chapter"),
    (re.compile(r"^/api/books/(?P<book_id>\d+)/audit$"), "GET", "handle_get_audit"),
    (re.compile(r"^/api/books/(?P<book_id>\d+)/report$"), "GET", "handle_get_report"),
    (re.compile(r"^/api/chapters/(?P<chapter_id>\d+)$"), "GET", "handle_get_chapter"),
    (re.compile(r"^/api/chapters/(?P<chapter_id>\d+)$"), "DELETE", "handle_delete_chapter"),
    (re.compile(r"^/api/chapters/(?P<chapter_id>\d+)/text$"), "PUT", "handle_update_text"),
    (re.compile(r"^/api/chapters/(?P<chapter_id>\d+)/classify$"), "PUT", "handle_classify"),
    (re.compile(r"^/api/chapters/(?P<chapter_id>\d+)/analysis$"), "GET", "handle_analysis"),
    (re.compile(r"^/api/chapters/(?P<chapter_id>\d+)/feedback$"), "POST", "handle_feedback"),
]


def make_handler(db_path: str):
    """Builds a request-handler class bound to a specific database file.
    (BaseHTTPRequestHandler classes are instantiated per-request by
    ThreadingHTTPServer, so state has to live at the class/closure level.)"""

    class Handler(BaseHTTPRequestHandler):
        server_version = "AuthorLedger/1.0"

        # -- plumbing -------------------------------------------------

        def _connect(self) -> sqlite3.Connection:
            return database.connect(db_path)

        def _security_headers(self) -> None:
            # Zero external resources are ever loaded (no CDN, no fonts,
            # no third-party scripts), so a strict same-origin policy costs
            # nothing and closes off a lot of common attack classes.
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'",
            )

        def _valid_host(self) -> bool:
            return _host_is_allowed(self.headers.get("Host"), self.server.server_port)

        def _send_json(self, status: int, payload) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self._security_headers()
            self.end_headers()
            self.wfile.write(body)

        def _read_json_body(self) -> dict:
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length <= 0:
                return {}
            if length > MAX_BODY_BYTES:
                self._drain(length)
                raise ValueError("Request body is too large.")
            raw = self.rfile.read(length)
            try:
                return json.loads(raw.decode("utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                return {}

        def _drain(self, length: int) -> None:
            """Read and discard up to DRAIN_CAP_BYTES of an oversized body,
            in small fixed-size chunks so memory use stays flat regardless
            of how large the (client-controlled) Content-Length claims to
            be. This lets a merely-too-big request finish sending cleanly
            instead of hitting a broken pipe when we respond early."""
            remaining = min(length, DRAIN_CAP_BYTES)
            while remaining > 0:
                chunk = self.rfile.read(min(_DRAIN_CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)

        def _dispatch(self, method: str) -> bool:
            if not self._valid_host():
                self._send_json(400, {"error": "Invalid Host header."})
                return True
            parsed = urlparse(self.path)
            for pattern, route_method, handler_name in ROUTES:
                if route_method != method:
                    continue
                match = pattern.match(parsed.path)
                if not match:
                    continue
                try:
                    body = self._read_json_body() if method in ("POST", "PUT") else {}
                    getattr(self, handler_name)(match, body)
                except ValueError as exc:
                    self._send_json(400, {"error": str(exc)})
                except Exception:  # noqa: BLE001 - last line of defense
                    # Full details go to the server console only. The client
                    # never sees a stack trace or exception text — that can
                    # leak file paths and internals to anything that can
                    # reach this port.
                    print("Unexpected error handling request:", file=sys.stderr)
                    traceback.print_exc()
                    self._send_json(500, {"error": "Unexpected server error."})
                return True
            return False

        def log_message(self, fmt, *args):  # quieter console output
            pass

        # -- static files ----------------------------------------------

        def _serve_static(self) -> None:
            if not self._valid_host():
                self.send_error(400, "Invalid Host header.")
                return
            parsed = urlparse(self.path)
            rel = unquote(parsed.path).lstrip("/") or "index.html"
            try:
                file_path = (WEB_DIR / rel).resolve()
                file_path.relative_to(WEB_DIR.resolve())  # raises if outside WEB_DIR
            except ValueError:
                self.send_error(403, "Forbidden")
                return
            if not file_path.exists() or file_path.is_dir():
                file_path = WEB_DIR / "index.html"
            content_type, _ = mimetypes.guess_type(str(file_path))
            data = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self._security_headers()
            self.end_headers()
            self.wfile.write(data)

        # -- HTTP verbs --------------------------------------------------

        def do_GET(self):
            if self.path.startswith("/api/"):
                if not self._dispatch("GET"):
                    self._send_json(404, {"error": "Not found."})
            else:
                self._serve_static()

        def do_POST(self):
            if not self._dispatch("POST"):
                self._send_json(404, {"error": "Not found."})

        def do_PUT(self):
            if not self._dispatch("PUT"):
                self._send_json(404, {"error": "Not found."})

        def do_DELETE(self):
            if not self._dispatch("DELETE"):
                self._send_json(404, {"error": "Not found."})

        # -- route handlers ----------------------------------------------

        def handle_status(self, match, body):
            self._send_json(200, {"ok": True, "llm_configured": llm_assist.is_configured()})

        def handle_list_books(self, match, body):
            conn = self._connect()
            self._send_json(200, {"books": database.list_books(conn)})

        def handle_create_book(self, match, body):
            conn = self._connect()
            book_id = database.create_book(
                conn, body.get("title", ""), body.get("author_note", "")
            )
            self._send_json(201, database.get_book(conn, book_id))

        def handle_get_book(self, match, body):
            conn = self._connect()
            book_id = int(match.group("book_id"))
            book = database.get_book(conn, book_id)
            if book is None:
                self._send_json(404, {"error": "Book not found."})
                return
            book["chapters"] = database.list_chapters(conn, book_id)
            self._send_json(200, book)

        def handle_delete_book(self, match, body):
            conn = self._connect()
            database.delete_book(conn, int(match.group("book_id")))
            self._send_json(200, {"ok": True})

        def handle_create_chapter(self, match, body):
            conn = self._connect()
            book_id = int(match.group("book_id"))
            chapter_id = database.create_chapter(
                conn, book_id, body.get("title", ""), body.get("text", "")
            )
            self._send_json(201, database.get_chapter(conn, chapter_id))

        def handle_get_chapter(self, match, body):
            conn = self._connect()
            chapter = database.get_chapter(conn, int(match.group("chapter_id")))
            if chapter is None:
                self._send_json(404, {"error": "Chapter not found."})
                return
            self._send_json(200, chapter)

        def handle_delete_chapter(self, match, body):
            conn = self._connect()
            database.delete_chapter(conn, int(match.group("chapter_id")))
            self._send_json(200, {"ok": True})

        def handle_update_text(self, match, body):
            conn = self._connect()
            chapter_id = int(match.group("chapter_id"))
            database.update_chapter_text(conn, chapter_id, body.get("text", ""))
            self._send_json(200, database.get_chapter(conn, chapter_id))

        def handle_classify(self, match, body):
            conn = self._connect()
            chapter_id = int(match.group("chapter_id"))
            database.classify_chapter(
                conn, chapter_id, body.get("classification", ""), body.get("note", "")
            )
            self._send_json(200, database.get_chapter(conn, chapter_id))

        def handle_analysis(self, match, body):
            conn = self._connect()
            chapter = database.get_chapter(conn, int(match.group("chapter_id")))
            if chapter is None:
                self._send_json(404, {"error": "Chapter not found."})
                return
            report = analysis.analyze_text(chapter["text"])
            self._send_json(200, report.to_dict())

        def handle_feedback(self, match, body):
            conn = self._connect()
            chapter = database.get_chapter(conn, int(match.group("chapter_id")))
            if chapter is None:
                self._send_json(404, {"error": "Chapter not found."})
                return
            if not llm_assist.is_configured():
                self._send_json(200, {
                    "feedback": None,
                    "message": (
                        f"Craft feedback needs a Claude API key. Set the "
                        f"{llm_assist.ENV_VAR} environment variable to turn it on — "
                        "everything else in AuthorLedger works without it."
                    ),
                })
                return
            feedback = llm_assist.craft_feedback(chapter["text"])
            self._send_json(200, {"feedback": feedback})

        def handle_get_audit(self, match, body):
            conn = self._connect()
            book_id = int(match.group("book_id"))
            self._send_json(200, {"audit_log": database.get_audit_log(conn, book_id)})

        def handle_get_report(self, match, body):
            conn = self._connect()
            book_id = int(match.group("book_id"))
            report = reports.build_report_with_narrative(conn, book_id)
            self._send_json(200, report)

    return Handler


def run(db_path: str, port: int = 8420) -> ThreadingHTTPServer:
    handler_cls = make_handler(db_path)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler_cls)
    return httpd
