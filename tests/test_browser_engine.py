"""
test_browser_engine.py

Executes web/engine.js in Node.js to verify:
  1. Exact metric & disclosure parity between Python and the standalone
     browser engine (analysis.py / reports.py vs web/engine.js).
  2. Browser storage persistence across reloads (writing, autosaving,
     reordering, snapshots, backups, manuscript import/export).
  3. Strict append-only audit log preservation across chapter and book
     deletions.
"""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from authorledger import analysis, database, reports

ENGINE_PATH = Path(__file__).resolve().parent.parent / "web" / "engine.js"


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js required to test browser engine")
def test_js_analysis_matches_python_analysis():
    sample_texts = [
        "",
        "Hello world. This is a test. Short one.",
        "We need to delve into this. Let's delve into it further, and delve into it once more.",
        (
            "Moreover, we must delve into the tapestry of this unwavering testament — "
            "and another thought--interrupted. Furthermore, the quick brown fox jumps over "
            "the lazy dog and the quick brown fox jumps over the lazy dog."
        ),
    ]

    node_script = """
    const Engine = require(process.argv[1]);
    const samples = JSON.parse(process.argv[2]);
    console.log(JSON.stringify(samples.map(t => Engine.analyzeText(t))));
    """
    proc = subprocess.run(
        ["node", "-e", node_script, str(ENGINE_PATH), json.dumps(sample_texts)],
        check=True,
        capture_output=True,
        text=True,
    )
    js_results = json.loads(proc.stdout)

    for text, js_rep in zip(sample_texts, js_results):
        py_rep = analysis.analyze_text(text).to_dict()
        assert js_rep["word_count"] == py_rep["word_count"]
        assert js_rep["sentence_count"] == py_rep["sentence_count"]
        assert js_rep["avg_sentence_length"] == py_rep["avg_sentence_length"]
        assert js_rep["burstiness"] == py_rep["burstiness"]
        assert js_rep["lexical_diversity"] == py_rep["lexical_diversity"]
        assert js_rep["em_dash_per_1000_words"] == py_rep["em_dash_per_1000_words"]
        assert js_rep["repeated_trigram_rate"] == py_rep["repeated_trigram_rate"]
        assert js_rep["flagged_phrases"] == py_rep["flagged_phrases"]
        assert js_rep["notes"] == py_rep["notes"]


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js required to test browser engine")
def test_js_compliance_report_matches_python_report():
    conn = database.connect(":memory:")
    b_id = database.create_book(conn, "Parity Novel")
    c1 = database.create_chapter(conn, b_id, "Ch 1", "one two three four")
    c2 = database.create_chapter(conn, b_id, "Ch 2", "five six seven eight nine ten")
    database.classify_chapter(conn, c1, "human", "handwritten")
    database.classify_chapter(conn, c2, "ai_generated", "drafted scene")
    py_report = reports.build_report(conn, b_id)

    node_script = """
    const Engine = require(process.argv[1]);
    const report = Engine.buildReport(
      { title: "Parity Novel", author_name: "Author" },
      [
        { title: "Ch 1", text: "one two three four", classification: "human", classification_note: "handwritten", updated_at: "2026-11-01" },
        { title: "Ch 2", text: "five six seven eight nine ten", classification: "ai_generated", classification_note: "drafted scene", updated_at: "2026-11-01" }
      ]
    );
    console.log(JSON.stringify({ report, md: Engine.reportToMarkdown(report) }));
    """
    proc = subprocess.run(
        ["node", "-e", node_script, str(ENGINE_PATH)],
        check=True,
        capture_output=True,
        text=True,
    )
    out = json.loads(proc.stdout)
    js_report = out["report"]
    assert js_report["total_words"] == py_report["total_words"]
    assert js_report["word_counts_by_classification"] == py_report["word_counts_by_classification"]
    assert js_report["percentages_by_classification"] == py_report["percentages_by_classification"]
    assert js_report["suggested_disclosure"] == py_report["suggested_disclosure"]
    assert "# AI-Use Compliance Report — Parity Novel" in out["md"]


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js required to test browser engine")
def test_browser_store_persistence_backups_snapshots_and_append_only_audit():
    node_script = """
    const assert = require("assert");
    const Engine = require(process.argv[1]);

    // Simulate persistent browser localStorage across reloads
    const disk = new Map();
    const fakeLocalStorage = {
      getItem: (k) => (disk.has(k) ? disk.get(k) : null),
      setItem: (k, v) => disk.set(k, String(v)),
      removeItem: (k) => disk.delete(k),
    };

    (async () => {
      // Session 1: Create book, write chapters, reorder, snapshot, classify
      const store1 = new Engine.BrowserLedgerStore({ localStorage: fakeLocalStorage, indexedDB: null });
      await store1.init();

      const book = await store1.createBook({
        title: "Harbour Lights",
        author_name: "Saurav",
        word_goal: 40000,
      });
      const ch1 = await store1.createChapter(book.id, { title: "Opening", text: "First draft words here." });
      const ch2 = await store1.createChapter(book.id, { title: "Second Scene", text: "More words follow." });

      // Save checkpoint, then rewrite, then restore
      const snap = await store1.createSnapshot(ch1.id, "Original opening");
      await store1.updateChapterText(ch1.id, "Completely rewritten text that we might revert.");
      const restored = await store1.restoreSnapshot(snap.id);
      assert.strictEqual(restored.text, "First draft words here.");

      // Reorder ch2 up before ch1
      const reordered = await store1.reorderChapter(ch2.id, "up");
      assert.strictEqual(reordered[0].id, ch2.id);

      // Classify and reclassify (both must stay in audit log)
      await store1.classifyChapter(ch1.id, "ai_assisted", "Grammar check");
      await store1.classifyChapter(ch1.id, "human", "Wrote myself");

      // Session 2: Simulate closing tab and reopening website
      const store2 = new Engine.BrowserLedgerStore({ localStorage: fakeLocalStorage, indexedDB: null });
      await store2.init();
      const loadedBook = await store2.getBook(book.id);
      assert.strictEqual(loadedBook.title, "Harbour Lights");
      assert.strictEqual(loadedBook.chapters.length, 2);
      assert.strictEqual(loadedBook.chapters[0].title, "Second Scene");

      // Test manuscript compilation (.md, .txt, .html) and import parser
      const compiledMd = Engine.compileManuscript(loadedBook, loadedBook.chapters, "markdown");
      assert(compiledMd.includes("# Harbour Lights"));
      assert(compiledMd.includes("## Second Scene"));
      const compiledHtml = Engine.compileManuscript(loadedBook, loadedBook.chapters, "html");
      assert(compiledHtml.includes("<!doctype html>"));

      const imported = Engine.parseManuscriptImport("# New Draft\\n\\n## Chapter 1\\nAlpha beta.\\n\\n## Chapter 2\\nGamma delta.");
      assert.strictEqual(imported.title, "New Draft");
      assert.strictEqual(imported.chapters.length, 2);
      assert.strictEqual(imported.chapters[0].title, "Chapter 1");

      // Offline craft coach
      const craft = Engine.analyzeCraft("Short sentence. Another crisp beat here! \\"Wait,\\" she said quietly.");
      assert(craft.bullets.length >= 2);

      // Export backup before deletion
      const backup = await store2.exportBackup();

      // Delete book — audit trail MUST survive!
      await store2.deleteBook(book.id);
      const remainingBooks = await store2.listBooks();
      assert.strictEqual(remainingBooks.length, 0);
      const globalAudit = await store2.getGlobalAuditLog();
      const types = globalAudit.map(e => e.event_type);
      assert(types.includes("book_created"));
      assert(types.includes("classified"));
      assert(types.includes("book_deleted"));
      assert.strictEqual(globalAudit.filter(e => e.event_type === "classified").length, 2);

      // Restore backup into fresh store
      const store3 = new Engine.BrowserLedgerStore({ localStorage: { getItem: () => null, setItem: () => {} }, indexedDB: null });
      const res = await store3.importBackup(backup);
      assert.strictEqual(res.importedBooks, 1);
      const restoredBooks = await store3.listBooks();
      assert.strictEqual(restoredBooks[0].title, "Harbour Lights");

      console.log("ALL_BROWSER_ENGINE_CHECKS_PASSED");
    })().catch(err => {
      console.error(err);
      process.exit(1);
    });
    """
    proc = subprocess.run(
        ["node", "-e", node_script, str(ENGINE_PATH)],
        check=True,
        capture_output=True,
        text=True,
    )
    assert "ALL_BROWSER_ENGINE_CHECKS_PASSED" in proc.stdout
