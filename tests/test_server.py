import json
import threading
import urllib.request
import urllib.error

import pytest

from authorledger import server


@pytest.fixture
def running_server(tmp_path):
    db_path = str(tmp_path / "test.db")
    httpd = server.run(db_path, port=0)  # port=0 -> OS picks a free port
    port = httpd.server_port
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()
    thread.join(timeout=5)


def request(url, method="GET", payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            # Static-file errors (e.g. a 403 from a path-traversal attempt)
            # go through http.server's default HTML error page, not our
            # JSON API -- that's expected, not a bug.
            return exc.code, {"raw_html": raw}


def test_status_endpoint(running_server):
    status, body = request(f"{running_server}/api/status")
    assert status == 200
    assert "llm_configured" in body


def test_full_book_lifecycle(running_server):
    base = running_server

    status, book = request(f"{base}/api/books", "POST", {"title": "Integration Test Book"})
    assert status == 201
    book_id = book["id"]

    status, chapter = request(f"{base}/api/books/{book_id}/chapters", "POST",
                               {"title": "Chapter One", "text": "hello there world"})
    assert status == 201
    chapter_id = chapter["id"]

    status, updated = request(f"{base}/api/chapters/{chapter_id}/text", "PUT",
                               {"text": "one two three four five six"})
    assert status == 200
    assert updated["text"] == "one two three four five six"

    status, classified = request(f"{base}/api/chapters/{chapter_id}/classify", "PUT",
                                  {"classification": "ai_assisted", "note": "grammar pass"})
    assert status == 200
    assert classified["classification"] == "ai_assisted"

    status, analysis = request(f"{base}/api/chapters/{chapter_id}/analysis")
    assert status == 200
    assert analysis["word_count"] == 6

    status, audit = request(f"{base}/api/books/{book_id}/audit")
    assert status == 200
    event_types = [e["event_type"] for e in audit["audit_log"]]
    assert "book_created" in event_types
    assert "chapter_created" in event_types
    assert "classified" in event_types

    status, report = request(f"{base}/api/books/{book_id}/report")
    assert status == 200
    assert report["word_counts_by_classification"]["ai_assisted"] == 6

    status, feedback = request(f"{base}/api/chapters/{chapter_id}/feedback", "POST")
    assert status == 200
    assert feedback["feedback"] is None  # no API key configured in test env

    status, _ = request(f"{base}/api/books/{book_id}", "DELETE")
    assert status == 200
    status, missing = request(f"{base}/api/books/{book_id}")
    assert status == 404


def test_404_for_unknown_route(running_server):
    status, _ = request(f"{running_server}/api/nonexistent")
    assert status == 404


def test_invalid_host_header_is_rejected(running_server):
    port = running_server.split(":")[-1]
    req = urllib.request.Request(
        f"{running_server}/api/status",
        headers={"Host": "evil.example.com"},
    )
    # urllib normally overwrites Host based on the URL, so hit the socket
    # more directly via http.client to actually control the header sent.
    import http.client
    conn = http.client.HTTPConnection("127.0.0.1", int(port))
    conn.putrequest("GET", "/api/status", skip_host=True)
    conn.putheader("Host", "evil.example.com")
    conn.endheaders()
    resp = conn.getresponse()
    assert resp.status == 400
    conn.close()


def test_path_traversal_attempt_does_not_escape_web_dir(running_server):
    # Should never be able to read a file outside web/ (e.g. the server's
    # own source code) through the static file route. This route isn't
    # part of the JSON API, so we fetch it directly instead of going
    # through the JSON-assuming request() helper.
    url = f"{running_server}/../authorledger/server.py"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            status, body = resp.status, resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        status, body = exc.code, exc.read().decode("utf-8", errors="replace")

    assert status in (200, 403, 404)
    assert "ThreadingHTTPServer" not in body, "must never serve the server's own source code"
    if status == 200:
        # A 200 here must mean it fell back to index.html, not that it
        # actually escaped web/.
        assert "<!doctype html>" in body.lower()


def test_oversized_request_body_is_rejected(running_server):
    _, book = request(f"{running_server}/api/books", "POST", {"title": "Book"})
    huge_payload = json.dumps({"title": "x" * (11 * 1024 * 1024)}).encode("utf-8")
    req = urllib.request.Request(
        f"{running_server}/api/books/{book['id']}/chapters",
        data=huge_payload, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            status = resp.status
    except urllib.error.HTTPError as exc:
        status = exc.code
    assert status == 400


def test_security_headers_present(running_server):
    req = urllib.request.Request(f"{running_server}/api/status")
    with urllib.request.urlopen(req, timeout=5) as resp:
        headers = dict(resp.getheaders())
    assert headers.get("X-Content-Type-Options") == "nosniff"
    assert headers.get("X-Frame-Options") == "DENY"


def test_invalid_classification_returns_400(running_server):
    base = running_server
    _, book = request(f"{base}/api/books", "POST", {"title": "Book"})
    _, chapter = request(f"{base}/api/books/{book['id']}/chapters", "POST", {"title": "Ch"})
    status, body = request(f"{base}/api/chapters/{chapter['id']}/classify", "PUT",
                            {"classification": "wizardry"})
    assert status == 400
    assert "error" in body
