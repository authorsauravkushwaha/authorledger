"""
test_craft_layer.py

Covers the 2026 craft layer:

  * Story Bible storage in the optional Python/SQLite backend (CRUD,
    ordering, validation, cascade-on-book-delete) and its deliberate
    separation from the append-only compliance audit log.
  * Story Bible JSON API routes.
  * Markup/CSS invariants for the new studio tools (line edit, read
    aloud, typewriter mode, manuscript health) under the strict CSP.
"""

import json
import re
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from authorledger import database, server

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


@pytest.fixture
def conn():
    connection = database.connect(":memory:")
    yield connection
    connection.close()


# ------------------------------------------------------- database: bible --


def test_story_bible_crud_and_kind_ordering(conn):
    book_id = database.create_book(conn, "Bible Book")

    mira = database.save_bible_entry(
        conn, book_id, kind="character", name="Mira Quill",
        description="Harbor cartographer.", tags="protagonist, act one",
    )
    port = database.save_bible_entry(
        conn, book_id, kind="place", name="Port Veridian", description="A harbor town."
    )
    rule = database.save_bible_entry(
        conn, book_id, kind="lore", name="The tide-clock",
    )
    beat = database.save_bible_entry(
        conn, book_id, kind="plot", name="The folio disappears",
    )

    entries = database.list_bible_entries(conn, book_id)
    assert [entry["id"] for entry in entries] == [mira["id"], port["id"], rule["id"], beat["id"]]
    assert entries[0]["tags"] == "protagonist, act one"

    updated = database.save_bible_entry(
        conn, book_id, entry_id=mira["id"], kind="character",
        name="Mira Quill", description="Cartographer who lies about fear of deep water.",
        tags="protagonist , act one , rewritten",
    )
    assert updated["name"] == "Mira Quill"
    assert updated["tags"] == "protagonist, act one, rewritten"
    assert updated["created_at"] == mira["created_at"]

    database.delete_bible_entry(conn, port["id"])
    remaining = [entry["name"] for entry in database.list_bible_entries(conn, book_id)]
    assert "Port Veridian" not in remaining
    assert len(remaining) == 3


def test_story_bible_requires_name_and_defaults_kind(conn):
    book_id = database.create_book(conn, "Bible Book")
    with pytest.raises(ValueError):
        database.save_bible_entry(conn, book_id, kind="character", name="   ")

    entry = database.save_bible_entry(
        conn, book_id, kind="not-a-real-kind", name="  Unnamed Rule  "
    )
    assert entry["kind"] == "character"
    assert entry["name"] == "Unnamed Rule"

    with pytest.raises(ValueError):
        database.save_bible_entry(conn, 99999, name="Nowhere")
    with pytest.raises(ValueError):
        database.save_bible_entry(conn, book_id, entry_id=99999, name="Ghost")
    with pytest.raises(ValueError):
        database.delete_bible_entry(conn, 99999)


def test_story_bible_never_touches_the_audit_log(conn):
    book_id = database.create_book(conn, "Quiet Ledger")
    entry = database.save_bible_entry(conn, book_id, kind="lore", name="A rule")
    database.save_bible_entry(conn, book_id, entry_id=entry["id"], name="A revised rule")
    database.delete_bible_entry(conn, entry["id"])

    event_types = [row["event_type"] for row in database.get_audit_log(conn, book_id)]
    assert event_types == ["book_created"]


def test_story_bible_cascades_when_book_is_deleted(conn):
    book_id = database.create_book(conn, "Temporary")
    database.save_bible_entry(conn, book_id, name="Someone")
    assert len(database.list_bible_entries(conn, book_id)) == 1

    database.delete_book(conn, book_id)
    rows = conn.execute("SELECT COUNT(*) AS n FROM story_bible WHERE book_id = ?", (book_id,)).fetchone()
    assert rows["n"] == 0
    # The ledger survives the book, as always.
    assert any(e["event_type"] == "book_deleted" for e in database.get_all_audit_logs(conn))


def test_story_bible_survives_reopening_an_older_database(tmp_path):
    db_path = tmp_path / "older.db"
    first = database.connect(db_path)
    book_id = database.create_book(first, "Older File")
    database.save_bible_entry(first, book_id, kind="place", name="The Drowned Library")
    first.close()

    second = database.connect(db_path)
    entries = database.list_bible_entries(second, book_id)
    second.close()
    assert entries and entries[0]["name"] == "The Drowned Library"


# ----------------------------------------------------------- server API --


@pytest.fixture
def running_server(tmp_path):
    httpd = server.run(str(tmp_path / "bible.db"), port=0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_port}"
    httpd.shutdown()
    thread.join(timeout=5)


def request(url, method="GET", payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        url, data=data, method=method, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode("utf-8"))


def test_bible_endpoints_lifecycle(running_server):
    base = running_server
    status, book = request(f"{base}/api/books", "POST", {"title": "API Bible"})
    assert status == 201
    book_id = book["id"]
    assert book.get("bible") == [] or book.get("bible") is None

    status, entry = request(
        f"{base}/api/books/{book_id}/bible", "POST",
        {"kind": "character", "name": "Julian Vale", "description": "Night clerk.", "tags": "ally"},
    )
    assert status == 201
    assert entry["kind"] == "character"
    assert entry["tags"] == "ally"

    status, listing = request(f"{base}/api/books/{book_id}/bible")
    assert status == 200
    assert [item["name"] for item in listing["entries"]] == ["Julian Vale"]

    status, updated = request(
        f"{base}/api/books/{book_id}/bible/{entry['id']}", "PUT",
        {"kind": "character", "name": "Julian Vale", "description": "Night clerk with a debt."},
    )
    assert status == 200
    assert updated["description"] == "Night clerk with a debt."

    # The book payload carries the bible so the studio loads in one request.
    status, book_payload = request(f"{base}/api/books/{book_id}")
    assert status == 200
    assert book_payload["bible"][0]["name"] == "Julian Vale"

    # Bible notes must not leak into the compliance audit trail.
    status, audit = request(f"{base}/api/books/{book_id}/audit")
    assert status == 200
    assert [event["event_type"] for event in audit["audit_log"]] == ["book_created"]

    status, _ = request(f"{base}/api/books/{book_id}/bible/{entry['id']}", "DELETE")
    assert status == 200
    status, listing = request(f"{base}/api/books/{book_id}/bible")
    assert listing["entries"] == []


def test_bible_endpoint_validation(running_server):
    base = running_server
    status, book = request(f"{base}/api/books", "POST", {"title": "Validation"})
    book_id = book["id"]

    status, body = request(f"{base}/api/books/{book_id}/bible", "POST", {"name": "   "})
    assert status == 400
    assert "name" in body["error"].lower()

    status, _ = request(f"{base}/api/books/99999/bible")
    assert status == 404
    status, _ = request(f"{base}/api/books/99999/bible", "POST", {"name": "Ghost"})
    assert status == 400


# ------------------------------------------------------ frontend assets --


def test_craft_controls_exist_in_studio_markup():
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    for element_id in (
        "line-edit-btn", "line-edit-panel", "line-edit-run-btn",
        "line-edit-summary", "line-edit-results",
        "read-aloud-btn", "read-aloud-bar", "read-toggle-btn", "read-stop-btn",
        "read-rate-select", "read-aloud-status",
        "typewriter-btn", "editor-bible-btn",
        "manuscript-insights", "health-badge", "health-next-step",
        "chapter-pace-chart", "health-notes",
        "bible-grid", "bible-search", "bible-filter", "bible-add-btn",
        "bible-empty", "bible-modal", "bible-form", "bible-name",
    ):
        assert f'id="{element_id}"' in html, f"missing #{element_id} in web/index.html"


def test_bible_modal_starts_hidden_and_form_has_no_inline_styles():
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    marker = 'id="bible-modal"'
    idx = html.index(marker)
    opening_tag = html[max(0, idx - 60):html.index(">", idx)]
    assert "hidden" in opening_tag
    assert "hidden" in html[html.index('id="bible-form"'):html.index(">", html.index('id="bible-form"'))]
    assert not re.search(r'\bstyle\s*=', html), "Inline style attributes violate strict CSP"


def test_craft_layer_styles_are_present():
    css = (WEB_DIR / "style.css").read_text(encoding="utf-8")
    for selector in (
        ".manuscript-insights", ".insight-card", ".pace-bar-fill",
        ".bible-card", ".bible-kind-chip", ".bible-form",
        ".line-edit-block", ".lint-category", ".lint-example",
        ".read-aloud-bar", "body.typewriter-mode #chapter-text",
        ".goal-streak",
    ):
        assert selector in css, f"missing styles for {selector}"


def test_line_edit_is_never_framed_as_a_detector():
    """The feature grid disclaimer is a design rule for this codebase."""
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    engine = (WEB_DIR / "engine.js").read_text(encoding="utf-8")
    lint_section = html[html.index('id="line-edit-panel"'):html.index('id="run-pattern-btn"')]
    assert "never scores your writing" in lint_section
    lint_source = engine[engine.index("function lintProse("):engine.index("function computeManuscriptHealth(")]
    assert "confidence" not in lint_source.lower()
    assert "ai_generated" not in lint_source
    assert "verdict" not in lint_source.lower()
