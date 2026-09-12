"""
reports.py — turns a book's chapter classifications into the actual thing
an author needs: a clean compliance record and a plain-language suggested
disclosure note.

Nothing here is legal advice, and the output says so, twice. It reflects
Amazon's own published distinction as of 2026 — AI-*generated* content
(text, images, translations produced by AI) needs disclosure; ordinary
AI-*assisted* work (brainstorming, grammar help, editing your own writing)
does not — but policies change, so every report tells the author to check
KDP's current guidelines before relying on it.
"""

from __future__ import annotations

from datetime import datetime, timezone

from . import database, llm_assist

CLASSIFICATION_LABELS = {
    "human": "Human-written",
    "ai_assisted": "AI-assisted",
    "ai_generated": "AI-generated",
    "unclassified": "Not yet classified",
}


def _word_count(text: str) -> int:
    return len(text.split())


def build_report(conn, book_id: int) -> dict:
    book = database.get_book(conn, book_id)
    if book is None:
        raise ValueError(f"No book with id {book_id}.")
    chapters = database.list_chapters(conn, book_id)

    word_counts = {"human": 0, "ai_assisted": 0, "ai_generated": 0, "unclassified": 0}
    chapter_rows = []
    for ch in chapters:
        wc = _word_count(ch["text"])
        word_counts[ch["classification"]] = word_counts.get(ch["classification"], 0) + wc
        chapter_rows.append({
            "title": ch["title"],
            "classification": ch["classification"],
            "classification_label": CLASSIFICATION_LABELS[ch["classification"]],
            "word_count": wc,
            "note": ch["classification_note"],
            "updated_at": ch["updated_at"],
        })

    total_words = sum(word_counts.values())
    percentages = {
        key: (round(count / total_words * 100, 1) if total_words else 0.0)
        for key, count in word_counts.items()
    }

    suggested_disclosure = _suggest_disclosure(word_counts, total_words)

    report = {
        "book_title": book["title"],
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "total_chapters": len(chapters),
        "total_words": total_words,
        "word_counts_by_classification": word_counts,
        "percentages_by_classification": percentages,
        "chapters": chapter_rows,
        "suggested_disclosure": suggested_disclosure,
        "disclaimer": (
            "This report is generated from the classifications you entered yourself. "
            "AuthorLedger has no way to verify how any chapter was actually written — "
            "that's information only you have. This is not legal advice; always check "
            "Amazon KDP's current content guidelines before publishing."
        ),
    }
    return report


def _suggest_disclosure(word_counts: dict, total_words: int) -> str:
    if total_words == 0:
        return "No chapter text yet — nothing to report."
    if word_counts.get("unclassified", 0) > 0:
        return (
            f"{word_counts['unclassified']} of {total_words} words are still "
            "unclassified. Classify every chapter before relying on this report."
        )
    if word_counts.get("ai_generated", 0) > 0:
        pct = round(word_counts["ai_generated"] / total_words * 100, 1)
        return (
            f"This book contains AI-generated text ({pct}% by word count). "
            "Per Amazon KDP's guidelines, AI-generated text must be disclosed in the "
            "AI content declaration when you publish or update this title."
        )
    if word_counts.get("ai_assisted", 0) > 0:
        return (
            "This book was human-written with AI-assisted support (e.g. brainstorming, "
            "grammar and editing help). Per Amazon KDP's guidelines, AI-assisted work "
            "generally does not require disclosure — but this record is worth keeping "
            "in case that policy changes or you're ever asked to show your process."
        )
    return "This book is entirely human-written, based on your classifications."


def to_markdown(report: dict) -> str:
    lines = [
        f"# AI-Use Compliance Report — {report['book_title']}",
        "",
        f"_Generated {report['generated_at']} by AuthorLedger._",
        "",
        "## Suggested disclosure note",
        "",
        report["suggested_disclosure"],
        "",
        "## Word counts by classification",
        "",
        "| Classification | Words | % of book |",
        "|---|---|---|",
    ]
    for key, label in CLASSIFICATION_LABELS.items():
        words = report["word_counts_by_classification"].get(key, 0)
        pct = report["percentages_by_classification"].get(key, 0.0)
        if words == 0:
            continue
        lines.append(f"| {label} | {words} | {pct}% |")
    lines += ["", f"**Total words:** {report['total_words']}", "", "## Chapter-by-chapter", ""]
    lines.append("| Chapter | Classification | Words | Last updated | Note |")
    lines.append("|---|---|---|---|---|")
    for ch in report["chapters"]:
        note = ch["note"].replace("|", "/") if ch["note"] else ""
        lines.append(
            f"| {ch['title']} | {ch['classification_label']} | {ch['word_count']} | "
            f"{ch['updated_at']} | {note} |"
        )
    lines += ["", "---", "", f"_{report['disclaimer']}_"]
    return "\n".join(lines)


def export_markdown(conn, book_id: int, out_path: str) -> str:
    report = build_report(conn, book_id)
    markdown = to_markdown(report)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(markdown)
    database.log_custom_event(
        conn, book_id, "report_exported", f"Compliance report exported to {out_path}."
    )
    return markdown


def build_report_with_narrative(conn, book_id: int) -> dict:
    """Same as build_report, plus an optional Claude-written plain-English
    summary paragraph if an API key is configured. Falls back silently."""
    report = build_report(conn, book_id)
    report["narrative_summary"] = llm_assist.summarize_report_narrative(report)
    return report
