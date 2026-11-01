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
VALID_CHAPTER_STATUSES = ("drafting", "revising", "final")

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    author_name TEXT NOT NULL DEFAULT '',
    author_note TEXT NOT NULL DEFAULT '',
    word_goal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    synopsis TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'drafting',
    text TEXT NOT NULL DEFAULT '',
    classification TEXT NOT NULL DEFAULT 'unclassified',
    classification_note TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chapter_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chapter_id INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    label TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    word_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
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


def _migrate_columns(conn: sqlite3.Connection) -> None:
    """Safely add newer studio columns when opening an older database file."""
    book_cols = {r["name"] for r in conn.execute("PRAGMA table_info(books)").fetchall()}
    if "author_name" not in book_cols:
        conn.execute("ALTER TABLE books ADD COLUMN author_name TEXT NOT NULL DEFAULT ''")
    if "word_goal" not in book_cols:
        conn.execute("ALTER TABLE books ADD COLUMN word_goal INTEGER NOT NULL DEFAULT 0")

    chapter_cols = {r["name"] for r in conn.execute("PRAGMA table_info(chapters)").fetchall()}
    if "synopsis" not in chapter_cols:
        conn.execute("ALTER TABLE chapters ADD COLUMN synopsis TEXT NOT NULL DEFAULT ''")
    if "status" not in chapter_cols:
        conn.execute("ALTER TABLE chapters ADD COLUMN status TEXT NOT NULL DEFAULT 'drafting'")


def connect(db_path: str | Path) -> sqlite3.Connection:
    """Open (and if needed, create) the AuthorLedger database file."""
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.executescript(SCHEMA)
    _migrate_columns(conn)
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

def create_book(
    conn: sqlite3.Connection,
    title: str,
    author_note: str = "",
    *,
    author_name: str = "",
    word_goal: int = 0,
) -> int:
    title = title.strip()
    if not title:
        raise ValueError("A book needs a title.")
    goal = max(0, int(word_goal or 0))
    cur = conn.execute(
        """INSERT INTO books (title, author_name, author_note, word_goal, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (title, author_name.strip(), author_note.strip(), goal, _now()),
    )
    conn.commit()
    book_id = cur.lastrowid
    _log_event(conn, book_id=book_id, event_type="book_created",
               book_title=title, detail=f"Book '{title}' created.")
    return book_id


def update_book(
    conn: sqlite3.Connection,
    book_id: int,
    *,
    title: str | None = None,
    author_name: str | None = None,
    author_note: str | None = None,
    word_goal: int | None = None,
) -> dict:
    book = get_book(conn, book_id)
    if book is None:
        raise ValueError(f"No book with id {book_id}.")
    new_title = book["title"] if title is None else title.strip()
    if not new_title:
        raise ValueError("A book needs a title.")
    new_author = book["author_name"] if author_name is None else author_name.strip()
    new_note = book["author_note"] if author_note is None else author_note.strip()
    new_goal = book["word_goal"] if word_goal is None else max(0, int(word_goal or 0))

    conn.execute(
        """UPDATE books
           SET title = ?, author_name = ?, author_note = ?, word_goal = ?
           WHERE id = ?""",
        (new_title, new_author, new_note, new_goal, book_id),
    )
    conn.commit()
    _log_event(
        conn, book_id=book_id, event_type="book_updated",
        book_title=new_title,
        detail=f"Book details updated for '{new_title}'.",
    )
    return get_book(conn, book_id)


def list_books(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute("SELECT * FROM books ORDER BY created_at DESC, id DESC").fetchall()
    books = []
    for r in rows:
        item = dict(r)
        chapters = conn.execute(
            "SELECT text FROM chapters WHERE book_id = ?", (item["id"],)
        ).fetchall()
        item["chapter_count"] = len(chapters)
        item["word_count"] = sum(_word_count(c["text"]) for c in chapters)
        books.append(item)
    return books


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

def create_chapter(
    conn: sqlite3.Connection,
    book_id: int,
    title: str,
    text: str = "",
    *,
    synopsis: str = "",
    status: str = "drafting",
) -> int:
    book = get_book(conn, book_id)
    if book is None:
        raise ValueError(f"No book with id {book_id}.")
    title = title.strip() or "Untitled chapter"
    clean_status = status if status in VALID_CHAPTER_STATUSES else "drafting"
    pos_row = conn.execute(
        "SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM chapters WHERE book_id = ?",
        (book_id,),
    ).fetchone()
    now = _now()
    cur = conn.execute(
        """INSERT INTO chapters
           (book_id, title, synopsis, status, text, classification,
            classification_note, position, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'unclassified', '', ?, ?, ?)""",
        (book_id, title, synopsis.strip(), clean_status, text, pos_row["next_pos"], now, now),
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
        "SELECT * FROM chapters WHERE book_id = ? ORDER BY position ASC, id ASC",
        (book_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_chapter(conn: sqlite3.Connection, chapter_id: int) -> dict | None:
    row = conn.execute("SELECT * FROM chapters WHERE id = ?", (chapter_id,)).fetchone()
    return dict(row) if row else None


def update_chapter_text(
    conn: sqlite3.Connection, chapter_id: int, text: str, *, log_audit: bool = True
) -> None:
    chapter = get_chapter(conn, chapter_id)
    if chapter is None:
        raise ValueError(f"No chapter with id {chapter_id}.")
    book = get_book(conn, chapter["book_id"])
    conn.execute(
        "UPDATE chapters SET text = ?, updated_at = ? WHERE id = ?",
        (text, _now(), chapter_id),
    )
    conn.commit()
    if log_audit:
        _log_event(
            conn, book_id=chapter["book_id"], chapter_id=chapter_id,
            book_title=book["title"] if book else "", chapter_title=chapter["title"],
            event_type="text_updated",
            detail="Chapter text updated.",
            word_count=_word_count(text),
        )


def update_chapter_meta(
    conn: sqlite3.Connection,
    chapter_id: int,
    *,
    title: str | None = None,
    synopsis: str | None = None,
    status: str | None = None,
) -> dict:
    chapter = get_chapter(conn, chapter_id)
    if chapter is None:
        raise ValueError(f"No chapter with id {chapter_id}.")
    book = get_book(conn, chapter["book_id"])
    new_title = chapter["title"] if title is None else (title.strip() or "Untitled chapter")
    new_synopsis = chapter["synopsis"] if synopsis is None else synopsis.strip()
    new_status = chapter["status"] if status is None else status
    if new_status not in VALID_CHAPTER_STATUSES:
        raise ValueError(f"Invalid chapter status '{new_status}'.")
    conn.execute(
        """UPDATE chapters
           SET title = ?, synopsis = ?, status = ?, updated_at = ?
           WHERE id = ?""",
        (new_title, new_synopsis, new_status, _now(), chapter_id),
    )
    conn.commit()
    if new_title != chapter["title"]:
        _log_event(
            conn, book_id=chapter["book_id"], chapter_id=chapter_id,
            book_title=book["title"] if book else "", chapter_title=new_title,
            event_type="chapter_renamed",
            detail=f"Chapter renamed from '{chapter['title']}' to '{new_title}'.",
            word_count=_word_count(chapter["text"]),
        )
    return get_chapter(conn, chapter_id)


def reorder_chapter(conn: sqlite3.Connection, chapter_id: int, direction: str) -> list[dict]:
    chapter = get_chapter(conn, chapter_id)
    if chapter is None:
        raise ValueError(f"No chapter with id {chapter_id}.")
    chapters = list_chapters(conn, chapter["book_id"])
    idx = next((i for i, c in enumerate(chapters) if c["id"] == chapter_id), -1)
    if idx == -1:
        return chapters
    swap_idx = idx - 1 if direction == "up" else idx + 1 if direction == "down" else idx
    if 0 <= swap_idx < len(chapters) and swap_idx != idx:
        chapters[idx], chapters[swap_idx] = chapters[swap_idx], chapters[idx]
        for pos, ch in enumerate(chapters):
            conn.execute("UPDATE chapters SET position = ? WHERE id = ?", (pos, ch["id"]))
        conn.commit()
    return list_chapters(conn, chapter["book_id"])


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


# ------------------------------------------------------------ snapshots --

def create_snapshot(conn: sqlite3.Connection, chapter_id: int, label: str = "") -> dict:
    chapter = get_chapter(conn, chapter_id)
    if chapter is None:
        raise ValueError(f"No chapter with id {chapter_id}.")
    book = get_book(conn, chapter["book_id"])
    clean_label = label.strip() or "Draft checkpoint"
    wc = _word_count(chapter["text"])
    now = _now()
    cur = conn.execute(
        """INSERT INTO chapter_snapshots (chapter_id, label, text, word_count, created_at)
           VALUES (?, ?, ?, ?, ?)""",
        (chapter_id, clean_label, chapter["text"], wc, now),
    )
    conn.commit()
    _log_event(
        conn, book_id=chapter["book_id"], chapter_id=chapter_id,
        book_title=book["title"] if book else "", chapter_title=chapter["title"],
        event_type="snapshot_saved",
        detail=f"Saved snapshot '{clean_label}'.",
        word_count=wc,
    )
    row = conn.execute("SELECT * FROM chapter_snapshots WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


def list_snapshots(conn: sqlite3.Connection, chapter_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM chapter_snapshots WHERE chapter_id = ? ORDER BY created_at DESC, id DESC",
        (chapter_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def restore_snapshot(conn: sqlite3.Connection, snapshot_id: int) -> dict:
    snap = conn.execute("SELECT * FROM chapter_snapshots WHERE id = ?", (snapshot_id,)).fetchone()
    if snap is None:
        raise ValueError(f"No snapshot with id {snapshot_id}.")
    chapter = get_chapter(conn, snap["chapter_id"])
    if chapter is None:
        raise ValueError("Chapter no longer exists.")
    book = get_book(conn, chapter["book_id"])
    conn.execute(
        "UPDATE chapters SET text = ?, updated_at = ? WHERE id = ?",
        (snap["text"], _now(), chapter["id"]),
    )
    conn.commit()
    _log_event(
        conn, book_id=chapter["book_id"], chapter_id=chapter["id"],
        book_title=book["title"] if book else "", chapter_title=chapter["title"],
        event_type="snapshot_restored",
        detail=f"Restored snapshot '{snap['label']}' ({snap['created_at']}).",
        word_count=_word_count(snap["text"]),
    )
    return get_chapter(conn, chapter["id"])


# ----------------------------------------------------------- audit log --

def get_audit_log(conn: sqlite3.Connection, book_id: int) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM audit_log WHERE book_id = ? ORDER BY timestamp ASC, id ASC",
        (book_id,),
    ).fetchall()
    return [dict(r) for r in rows]


def get_all_audit_logs(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT * FROM audit_log ORDER BY timestamp ASC, id ASC"
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
