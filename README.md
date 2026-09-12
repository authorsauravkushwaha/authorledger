# § AuthorLedger

**An honest paper trail for AI use in your books.**

[![License: MIT](https://img.shields.io/badge/license-MIT-3d6b4a.svg)](LICENSE)
![Python](https://img.shields.io/badge/python-3.9%2B-a1762f.svg)
![Dependencies](https://img.shields.io/badge/dependencies-zero-2f4f3d.svg)

---

## The problem

Amazon now requires KDP authors to disclose it when a published book's text, images, or translations were **AI-generated** — but ordinary **AI-assisted** work, like brainstorming, grammar checking, or editing your own writing, does not need to be disclosed. Amazon has also started reviewing previously published titles against this policy, not just new uploads.

That line between "AI-generated" and "AI-assisted" sounds simple until you're 40 chapters into a series, across several tools, over several months, and someone asks you to account for it. Most authors are keeping that record in their head. That's not a record — it's a guess waiting to happen.

There is currently no free, open-source tool built for this. AuthorLedger is one.

## What it does

- **Log every chapter honestly.** Mark each one Human-written, AI-assisted, or AI-generated, with an optional note about which tool and what it helped with.
- **Keep a real audit trail.** Every classification, edit, and correction is timestamped and kept forever — reclassifying a chapter adds a new entry, it never rewrites history. Delete a book and the ledger still remembers it existed.
- **Export a compliance report** in one click: word counts by classification, percentages, and a plain-language suggested disclosure note for KDP, as a Markdown file you can keep with your manuscript.
- **Get a Writing Pattern Report**, if you want one — sentence-rhythm, word variety, and overused-phrase stats on any chapter, framed as a memory-jogger for your own honest classification, **not** as an AI detector. (More on why, below.)
- **Optionally, ask Claude** to turn your report into a plain-English paragraph, or give you craft feedback on a chapter's pacing and voice. Entirely optional — the rest of the app doesn't know or care whether you turn this on.

## Screenshots

<p>
  <img src="docs/screenshot-ledger.png" alt="AuthorLedger book view showing chapters with human-written, AI-assisted, AI-generated, and unclassified stamps" width="100%">
</p>
<p>
  <img src="docs/screenshot-pattern-report.png" alt="AuthorLedger chapter detail view showing the Writing Pattern Report with flagged phrases and stats" width="100%">
</p>

*(If you're reading this before the screenshots are added: run the app once — `python3 main.py` — and it looks exactly like this. See "For the maintainer" below.)*

## Why it works this way

Two design decisions here are deliberate, not accidental:

1. **The audit log is append-only.** Nothing about your classification history can be edited or deleted, even by AuthorLedger itself — there's no function in the codebase that does it. A compliance record you can quietly rewrite isn't a compliance record.
2. **The Writing Pattern Report never outputs a confidence score, a percentage, or a verdict about whether something "is AI."** No lightweight text-statistics tool can honestly claim that, and one that pretends to is worse than useless — it can talk an author into a wrong answer with false confidence. Only the author knows how a chapter was actually written. This feature exists to jog memory and flag things worth a second look, and it says so on every screen where it appears.

If you're building on this codebase, please keep both of those.

## Quick start

No `pip install` required for the core app — everything runs on Python's standard library.

```bash
git clone https://github.com/authorsauravkushwaha/authorledger.git
cd authorledger
python3 main.py
```

This opens `http://localhost:8420` in your browser. Your data lives in `authorledger.db` (SQLite) in the folder you ran it from — back that file up like you would any manuscript file, since it's your compliance record.

Options:

```bash
python3 main.py --port 9000          # run on a different port
python3 main.py --db my-series.db    # keep a separate ledger per project
python3 main.py --no-browser         # don't auto-open a browser tab
```

### Optional: turn on Claude features

```bash
export AUTHORLEDGER_ANTHROPIC_API_KEY="your-key-here"
python3 main.py
```

Get a key at [console.anthropic.com](https://console.anthropic.com). Without one, AuthorLedger runs fully offline — the compliance ledger, audit trail, and report export don't need it at all.

## How the Writing Pattern Report actually works

In plain terms, for one chapter of text it computes:

- **Burstiness** — how much sentence lengths vary. Human prose tends to be "bursty" (short, then long, then short); very uniform sentence rhythm is a data point, not a verdict.
- **Word variety** (lexical diversity) — unique words as a share of total words.
- **Repeated phrasing** — how often 3-word sequences repeat elsewhere in the same chapter.
- **A curated list of ~25 words and phrases** that generic LLM output leans on heavily (*"delve into," "tapestry," "moreover," "it is important to note,"* and friends), counted per 1,000 words.

That's it. No machine learning model, no black box. You can read the entire thing in [`authorledger/analysis.py`](authorledger/analysis.py) — it's about 150 lines, and reading it is a reasonable way to learn what "burstiness" and "lexical diversity" mean if those are new terms to you (they were to me a few weeks ago).

## Project structure

```
authorledger/
├── main.py                    # entry point — starts the server, opens your browser
├── authorledger/
│   ├── database.py            # SQLite layer + the append-only audit log
│   ├── analysis.py            # the Writing Pattern Report heuristics
│   ├── reports.py             # compliance report + suggested disclosure text
│   ├── llm_assist.py          # optional Claude integration (zero-dependency, via urllib)
│   └── server.py              # stdlib-only HTTP server + JSON API
├── web/                       # vanilla HTML/CSS/JS frontend, no build step
└── tests/                     # 38+ tests covering all of the above
```

## Running the tests

```bash
pip install pytest
python3 -m pytest tests/ -v
```

## Roadmap

- [ ] Import a manuscript directly from `.docx` / `.epub` instead of copy-pasting per chapter
- [ ] Per-book export history (see every report you've ever generated for a title)
- [ ] A packaged desktop build (no terminal required)
- [ ] Multi-language support for the Writing Pattern Report's phrase list

Contributions and issues are welcome — this is early, and built to be extended.

## Disclaimer

AuthorLedger is not legal advice and has no relationship with Amazon or KDP. It generates records and suggestions based entirely on what *you* tell it. Always check Amazon KDP's current content guidelines before publishing: <https://kdp.amazon.com/en_US/help>.

## About

Built by [Saurav Kushwaha](https://github.com/authorsauravkushwaha) — a published author of 90+ books and a first-year Computer Science (AI & ML) student, learning the field by building things he'd actually use. This is his first project that involves real AI/ML work rather than pure logic; feedback from people who've shipped more of these than he has is very welcome.

## License

MIT — see [LICENSE](LICENSE).
