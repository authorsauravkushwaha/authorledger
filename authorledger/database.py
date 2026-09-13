"""
database.py — AuthorLedger's data layer.

Everything in AuthorLedger revolves around one idea: a book is made of
chapters, every chapter has an honest classification (human-written /
AI-assisted / AI-generated), and every change to that classification is
written to an append-only audit log that is never edited or deleted.

That last part is the whole point of the tool. A KDP disclosure only means
something if you can show *when* you decided a chapter was AI-generated,
not just what today's checkbox says. So this module intentionally does not
expose any function that updates or deletes a row in ``audit_log`` — only
``_log_event`` (private, insert-only) writes to it.

Zero third-party dependencies: this whole file only uses Python's built-in
``sqlite3`` module.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

# The three honest answers a chapter can have. "unclassified" is the
# starting state — AuthorLedger never guesses this for you.
VALID_CLASSIFICATIONS = ("human", "ai_assisted", "ai_generated", "unclassified")

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    classification TEXT NOT NULL DEFAULT 'unclassified',
    classification_note TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Deliberately NOT a foreign key with ON DELETE CASCADE: if a book is
-- deleted, its history should still exist. A ledger that erases itself
-- when you delete a book is not a ledger.
CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL,
    chapter_id INTEGER,
    book_title TEXT NOT NULL DEFAULT '',
    chapter_title TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    word_count INTEGER,
    timestamp TEXT NOT NULL
);
"""


def _now() -> str:
    """UTC timestamp, ISO 8601. Every audit row is time-stamped this way
    so the log can't be quietly reordered or backdated by editing a file."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(db_path: str | Path) -> sqlite3.Connection:
    """Open (and if needed, create) the AuthorLedger database file."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def _log_event(
    conn: sqlite3.Connection,
    *,
    book_id: int,
    event_type: str,
    chapter_id: int | None = None,
    book_title: str = "",
    chapter_title: str = "",
    detail: str = "",
    word_count: int | None = None,
) -> None:
    conn.execute(
        """INSERT INTO audit_log
           (book_id, chapter_id, book_title, chapter_title, event_type,
            detail, word_count, timestamp)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        (book_id, chapter_id, book_title, chapter_title, event_type,
         detail, word_count, _now()),
    )
    conn.commit()


# ---------------------------------------------------------------- books --

def create_book(conn: sqlite3.Connection, title: str, author_note: str = "") -> int:
    title = title.strip()
    if not title:
        raise ValueError("A book needs a title.")
    cur = conn.execute(
        "INSERT INTO books (title, author_note, created_at) VALUES (?, ?, ?)",
        (title, author_note, _now()),
    )
    conn.commit()
    book_id = cur.lastrowid
    _log_event(conn, book_id=book_id, event_type="book_created",
               book_title=title, detail=f"Book '{title}' created.")
    return book_id


def list_books(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT * FROM books ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


def get_book(conn: sqlite3.Connection, book_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
    return dict(row) if row else None


def delete_book(conn: sqlite3.Connection, book_id: int) -> None:
    """Deletes a book and its chapters. The audit_log rows for this book
    are kept on purpose — see the schema comment above."""
    book = get_book(conn, book_id)
    if book is None:
        raise ValueError(f"No book with id {book_id}.")
    conn.execute("DELETE FROM chapters WHERE book_id = ?", (book_id,))
    conn.execute("DELETE FROM books WHERE id = ?", (book_id,))
    conn.commit()
    _log_event(conn, book_id=book_id, event_type="book_deleted",
               book_title=book["title"],
               detail=f"Book '{book['title']}' deleted (history retained).")


# ------------------------------------------------------------- chapters --

def create_chapter(conn: sqlite3.Connection, book_id: int, title: str, text: str = "") -> int:
    book = get_book(conn, book_id)
    if book is None:
        raise ValueError(f"No book with id {book_id}.")
    title = title.strip() or "Untitled chapter"
    pos_row = conn.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM chapters WHERE book_id = ?",
        (book_id,),
    ).fetchone()
    now = _now()
    cur = conn.execute(
        """INSERT INTO chapters
           (book_id, title, text, classification, classification_note,
            position, created_at, updated_at)
           VALUES (?, ?, ?, 'unclassified', '', ?, ?, ?)""",
        (book_id, title, text, pos_row["next_pos"], now, now),
    )
    conn.commit()
    chapter_id = cur.lastrowid
    _log_event(
        conn, book_id=book_id, chapter_id=chapter_id,
        book_title=book["title"], chapter_title=title,
        event_type="chapter_created",
        detail=f"Chapter '{title}' created.",
        word_count=_word_count(text),
    )
    return chapter_id


def list_chapters(conn: sqlite3.Connection, book_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM chapters WHERE book_id = ? ORDER BY position ASC",
        (book_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_chapter(conn: sqlite3.Connection, chapter_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
    return dict(row) if row else None


def update_chapter_text(conn: sqlite3.Connection, chapter_id: int, text: str) -> None:
    chapter = get_chapter(conn, chapter_id)
    if chapter is None:
        raise ValueError(f"No chapter with id {chapter_id}.")
    book = get_book(conn, chapter["book_id"])
    conn.execute(
        "UPDATE chapters SET text = ?, updated_at = ? WHERE id = ?",
        (text, _now(), chapter_id),
    )
    conn.commit()
    _log_event(
        conn, book_id=chapter["book_id"], chapter_id=chapter_id,
        book_title=book["title"] if book else "", chapter_title=chapter["title"],
        event_type="text_updated",
        detail="Chapter text updated.",
        word_count=_word_count(text),
    )


def classify_chapter(
    conn: sqlite3.Connection, chapter_id: int, classification: str, note: str = ""
) -> None:
    if classification not in VALID_CLASSIFICATIONS:
        raise ValueError(
            f"'{classification}' is not a valid classification. "
            f"Use one of: {', '.join(VALID_CLASSIFICATIONS)}."
        )
    chapter = get_chapter(conn, chapter_id)
    if chapter is None:
        raise ValueError(f"No chapter with id {chapter_id}.")
    book = get_book(conn, chapter["book_id"])
    conn.execute(
        "UPDATE chapters SET classification = ?, classification_note = ?, updated_at = ? WHERE id = ?",
        (classification, note, _now(), chapter_id),
    )
    conn.commit()
    _log_event(
        conn, book_id=chapter["book_id"], chapter_id=chapter_id,
        book_title=book["title"] if book else "", chapter_title=chapter["title"],
        event_type="classified",
        detail=f"Marked as '{classification}'." + (f" Note: {note}" if note else ""),
        word_count=_word_count(chapter["text"]),
    )


def delete_chapter(conn: sqlite3.Connection, chapter_id: int) -> None:
    chapter = get_chapter(conn, chapter_id)
    if chapter is None:
        raise ValueError(f"No chapter with id {chapter_id}.")
    book = get_book(conn, chapter["book_id"])
    conn.execute("DELETE FROM chapters WHERE id = ?", (chapter_id,))
    conn.commit()
    _log_event(
        conn, book_id=chapter["book_id"], chapter_id=None,
        book_title=book["title"] if book else "", chapter_title=chapter["title"],
        event_type="chapter_deleted",
        detail=f"Chapter '{chapter['title']}' deleted (history retained).",
    )


# ----------------------------------------------------------- audit log --

def get_audit_log(conn: sqlite3.Connection, book_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM audit_log WHERE book_id = ? ORDER BY timestamp ASC, id ASC",
        (book_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def log_custom_event(conn: sqlite3.Connection, book_id: int, event_type: str, detail: str) -> None:
    """Public hook for events that don't fit the CRUD helpers above,
    e.g. reports.py logging a 'report_exported' entry."""
    book = get_book(conn, book_id)
    _log_event(conn, book_id=book_id, event_type=event_type,
               book_title=book["title"] if book else "", detail=detail)


def _word_count(text: str) -> int:
    return len(text.split())
