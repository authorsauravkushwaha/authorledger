import sqlite3

import pytest

from authorledger import database


@pytest.fixture
def conn():
    c = database.connect(":memory:")
    yield c
    c.close()


def test_create_and_get_book(conn):
    book_id = database.create_book(conn, "  My Novel  ", "test note")
    book = database.get_book(conn, book_id)
    assert book["title"] == "My Novel"
    assert book["author_note"] == "test note"


def test_create_book_requires_title(conn):
    with pytest.raises(ValueError):
        database.create_book(conn, "   ")


def test_book_creation_is_logged(conn):
    book_id = database.create_book(conn, "Ledger Test")
    log = database.get_audit_log(conn, book_id)
    assert len(log) == 1
    assert log[0]["event_type"] == "book_created"


def test_create_chapter_and_list_order(conn):
    book_id = database.create_book(conn, "Book")
    c1 = database.create_chapter(conn, book_id, "Chapter 1", "hello world")
    c2 = database.create_chapter(conn, book_id, "Chapter 2", "more text here")
    chapters = database.list_chapters(conn, book_id)
    assert [c["id"] for c in chapters] == [c1, c2]
    assert chapters[0]["classification"] == "unclassified"


def test_update_chapter_text_logs_word_count(conn):
    book_id = database.create_book(conn, "Book")
    chapter_id = database.create_chapter(conn, book_id, "Ch 1")
    database.update_chapter_text(conn, chapter_id, "one two three four five")
    chapter = database.get_chapter(conn, chapter_id)
    assert chapter["text"] == "one two three four five"
    log = database.get_audit_log(conn, book_id)
    text_events = [e for e in log if e["event_type"] == "text_updated"]
    assert text_events[-1]["word_count"] == 5


def test_classify_chapter_rejects_invalid_value(conn):
    book_id = database.create_book(conn, "Book")
    chapter_id = database.create_chapter(conn, book_id, "Ch 1")
    with pytest.raises(ValueError):
        database.classify_chapter(conn, chapter_id, "definitely_written_by_a_ghost")


def test_classify_chapter_writes_audit_entry(conn):
    book_id = database.create_book(conn, "Book")
    chapter_id = database.create_chapter(conn, book_id, "Ch 1")
    database.classify_chapter(conn, chapter_id, "ai_assisted", note="Used for brainstorming")
    chapter = database.get_chapter(conn, chapter_id)
    assert chapter["classification"] == "ai_assisted"
    log = database.get_audit_log(conn, book_id)
    classify_events = [e for e in log if e["event_type"] == "classified"]
    assert len(classify_events) == 1
    assert "ai_assisted" in classify_events[0]["detail"]
    assert "brainstorming" in classify_events[0]["detail"]


def test_reclassifying_appends_rather_than_overwrites_history(conn):
    book_id = database.create_book(conn, "Book")
    chapter_id = database.create_chapter(conn, book_id, "Ch 1")
    database.classify_chapter(conn, chapter_id, "ai_generated")
    database.classify_chapter(conn, chapter_id, "human")  # author corrects themselves
    log = database.get_audit_log(conn, book_id)
    classify_events = [e for e in log if e["event_type"] == "classified"]
    assert len(classify_events) == 2, "both the original and the correction must survive"
    assert database.get_chapter(conn, chapter_id)["classification"] == "human"


def test_deleting_book_preserves_audit_log(conn):
    book_id = database.create_book(conn, "Doomed Book")
    chapter_id = database.create_chapter(conn, book_id, "Ch 1")
    database.classify_chapter(conn, chapter_id, "ai_generated")
    entries_before = len(database.get_audit_log(conn, book_id))

    database.delete_book(conn, book_id)

    assert database.get_book(conn, book_id) is None
    log_after = database.get_audit_log(conn, book_id)
    # every prior entry plus the new "book_deleted" entry must still be there
    assert len(log_after) == entries_before + 1
    assert log_after[-1]["event_type"] == "book_deleted"


def test_deleting_chapter_preserves_audit_log(conn):
    book_id = database.create_book(conn, "Book")
    chapter_id = database.create_chapter(conn, book_id, "Ch 1")
    database.delete_chapter(conn, chapter_id)
    assert database.get_chapter(conn, chapter_id) is None
    log = database.get_audit_log(conn, book_id)
    assert any(e["event_type"] == "chapter_deleted" for e in log)


def test_operating_on_missing_ids_raises(conn):
    with pytest.raises(ValueError):
        database.create_chapter(conn, 999, "Ch")
    with pytest.raises(ValueError):
        database.update_chapter_text(conn, 999, "text")
    with pytest.raises(ValueError):
        database.classify_chapter(conn, 999, "human")
    with pytest.raises(ValueError):
        database.delete_book(conn, 999)
