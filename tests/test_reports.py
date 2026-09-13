import os
import tempfile

from authorledger import database, reports


def make_book_with_chapters(conn):
    book_id = database.create_book(conn, "Test Book")
    c1 = database.create_chapter(conn, book_id, "Ch 1", "one two three four five")
    c2 = database.create_chapter(conn, book_id, "Ch 2", "six seven eight nine ten eleven")
    database.classify_chapter(conn, c1, "human")
    database.classify_chapter(conn, c2, "ai_assisted")
    return book_id


def test_build_report_totals_words_correctly():
    conn = database.connect(":memory:")
    book_id = make_book_with_chapters(conn)
    report = reports.build_report(conn, book_id)
    assert report["total_words"] == 11
    assert report["word_counts_by_classification"]["human"] == 5
    assert report["word_counts_by_classification"]["ai_assisted"] == 6


def test_unclassified_chapters_block_a_clean_suggestion():
    conn = database.connect(":memory:")
    book_id = database.create_book(conn, "Book")
    database.create_chapter(conn, book_id, "Ch 1", "some unclassified words here")
    report = reports.build_report(conn, book_id)
    assert "unclassified" in report["suggested_disclosure"].lower()


def test_ai_generated_content_triggers_disclosure_language():
    conn = database.connect(":memory:")
    book_id = database.create_book(conn, "Book")
    c1 = database.create_chapter(conn, book_id, "Ch 1", "a b c d e f g h i j")
    database.classify_chapter(conn, c1, "ai_generated")
    report = reports.build_report(conn, book_id)
    assert "disclosed" in report["suggested_disclosure"].lower()
    assert "ai-generated" in report["suggested_disclosure"].lower()


def test_fully_human_book_gets_simple_suggestion():
    conn = database.connect(":memory:")
    book_id = database.create_book(conn, "Book")
    c1 = database.create_chapter(conn, book_id, "Ch 1", "a b c d e")
    database.classify_chapter(conn, c1, "human")
    report = reports.build_report(conn, book_id)
    assert "human-written" in report["suggested_disclosure"].lower()


def test_markdown_export_contains_key_sections():
    conn = database.connect(":memory:")
    book_id = make_book_with_chapters(conn)
    report = reports.build_report(conn, book_id)
    markdown = reports.to_markdown(report)
    assert "# AI-Use Compliance Report" in markdown
    assert "Suggested disclosure note" in markdown
    assert "Ch 1" in markdown and "Ch 2" in markdown
    assert report["disclaimer"] in markdown


def test_export_markdown_writes_file_and_logs_event():
    conn = database.connect(":memory:")
    book_id = make_book_with_chapters(conn)
    with tempfile.TemporaryDirectory() as tmp:
        out_path = os.path.join(tmp, "report.md")
        reports.export_markdown(conn, book_id, out_path)
        assert os.path.exists(out_path)
        with open(out_path, encoding="utf-8") as f:
            content = f.read()
        assert "Test Book" in content

    log = database.get_audit_log(conn, book_id)
    assert any(e["event_type"] == "report_exported" for e in log)


def test_narrative_summary_is_none_without_api_key(monkeypatch):
    monkeypatch.delenv("AUTHORLEDGER_ANTHROPIC_API_KEY", raising=False)
    conn = database.connect(":memory:")
    book_id = make_book_with_chapters(conn)
    report = reports.build_report_with_narrative(conn, book_id)
    assert report["narrative_summary"] is None
