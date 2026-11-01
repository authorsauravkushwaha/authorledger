# § AuthorLedger

**Write your books, save your work in the browser, and keep an honest paper trail for AI use.**

[![License: MIT](https://img.shields.io/badge/license-MIT-3d6b4a.svg)](LICENSE)
![Web Studio](https://img.shields.io/badge/web%20studio-GitHub%20Pages%20ready-2f4f3d.svg)
![Python](https://img.shields.io/badge/python-3.9%2B%20optional-a1762f.svg)
![Dependencies](https://img.shields.io/badge/dependencies-zero-2f4f3d.svg)

**Live Website:** <https://authorsauravkushwaha.github.io/authorledger/>

---

## The problem

Amazon now requires KDP authors to disclose it when a published book's text, images, or translations were **AI-generated** — but ordinary **AI-assisted** work, like brainstorming, grammar checking, or editing your own writing, does not need to be disclosed. Amazon has also started reviewing previously published titles against this policy, not just new uploads.

That line between "AI-generated" and "AI-assisted" sounds simple until you're 40 chapters into a series, across several tools, over several months, and someone asks you to account for it. Most authors are keeping that record in their head. That's not a record — it's a guess waiting to happen.

AuthorLedger gives you a calm, distraction-free **writing studio and compliance ledger right on the website** — so you can write your chapters, save your work automatically in your browser, export manuscripts anytime, and keep a permanent, honest record as you go.

## What you can do right on the website

- **Open on a full studio dashboard.** Live workspace statistics (books, chapters, words written, reading time, ledger entries), a 26-week writing-activity heatmap, your shelf with generated covers and word-goal progress, a recent-activity feed from your own ledger, a complete feature tour, and a plain-language FAQ — the whole studio explained at a glance.
- **Write and save directly in your browser.** Create books and chapters, set word-count goals, write in **Focus Mode** with customizable typography (`Serif`, `Sans`, `Mono`) and paper themes (`Ledger`, `Parchment`, `Night Ink`), use Find & Replace, reorder chapters, and save named **version snapshots** before rewrites. Everything saves automatically to your browser (`IndexedDB` + synchronous `localStorage` mirror) with zero account or server required.
- **Own your manuscript & backups.** Download your compiled book anytime as **Markdown (`.md`)**, **Plain Text (`.txt`)**, or **Print-ready Typeset HTML / PDF (`.html`)**. Import existing `.md` or `.txt` manuscripts (automatically split into chapters) and export/restore full `.json` workspace backups across devices.
- **Log every chapter honestly.** Stamp each chapter **Human-written**, **AI-assisted**, or **AI-generated**, with an optional note about which tool and what it helped with.
- **Keep a real append-only audit trail.** Every classification, edit milestone, snapshot, and correction is timestamped and kept forever — reclassifying a chapter adds a new entry, it never rewrites history. Delete a chapter or an entire book and the global ledger still remembers it existed.
- **Export a KDP compliance report** in one click: word counts by classification, percentages, chapter breakdown, and a plain-language suggested disclosure note for KDP, downloadable as Markdown.
- **Run a Writing Pattern Report**, if you want one — sentence-rhythm (burstiness), word variety, repeated trigrams, and overused-phrase stats on any chapter, framed as a memory-jogger for your own honest classification, **not** as an AI detector.
- **Check craft & pacing offline (or optionally ask Claude).** Run an instant, offline craft check (paragraph pacing, sentence rhythm, modifier density, dialogue balance), or optionally add your own Anthropic API key in browser settings for live Claude feedback.

## Why it works this way

Two design decisions here are deliberate, not accidental:

1. **The audit log is append-only.** Nothing about your classification history can be edited or deleted, even by AuthorLedger itself. A compliance record you can quietly rewrite isn't a compliance record.
2. **The Writing Pattern Report never outputs a confidence score, a percentage, or a verdict about whether something "is AI."** No lightweight text-statistics tool can honestly claim that, and one that pretends to is worse than useless — it can talk an author into a wrong answer with false confidence. Only the author knows how a chapter was actually written. This feature exists to jog memory and flag things worth a second look, and it says so on every screen where it appears.

If you're building on this codebase, please keep both of those.

## Two ways to use AuthorLedger

### 1. Directly on the website (no install required)

Open **<https://authorsauravkushwaha.github.io/authorledger/>** in any modern browser and start writing. Your books, chapters, snapshots, and audit trail persist automatically in your browser on your device, and you can export `.json` backups and `.md` / `.txt` / `.html` manuscripts whenever you like.

### 2. Local Python + SQLite server (optional)

Prefer storing your ledger in a local `.db` file on disk? Zero `pip install` is required — everything runs on Python's standard library:

```bash
git clone https://github.com/authorsauravkushwaha/authorledger.git
cd authorledger
python3 main.py
```

This opens `http://localhost:8420` in your browser and stores everything in `authorledger.db` (SQLite).

Options:

```bash
python3 main.py --port 9000          # run on a different port
python3 main.py --db my-series.db    # keep a separate ledger per project
python3 main.py --no-browser         # don't auto-open a browser tab
```

Optional server-side Claude key:

```bash
export AUTHORLEDGER_ANTHROPIC_API_KEY="your-key-here"
python3 main.py
```

## Project structure

```
authorledger/
├── web/                       # standalone browser studio (deployed to GitHub Pages)
│   ├── index.html             # full writing & compliance workspace markup
│   ├── engine.js              # browser IndexedDB store, pattern analysis, reports, manuscript compiler
│   ├── app.js                 # UI controller (autosave, focus mode, snapshots, exports)
│   └── style.css              # ledger/parchment/night paper themes & layout
├── main.py                    # optional local Python entry point
├── authorledger/              # optional stdlib-only Python + SQLite backend
│   ├── database.py            # SQLite layer + append-only audit log + snapshots
│   ├── analysis.py            # Writing Pattern Report heuristics
│   ├── reports.py             # compliance report + suggested disclosure text
│   ├── llm_assist.py          # optional Claude integration via urllib
│   └── server.py              # stdlib HTTP server + JSON API
└── tests/                     # Python + browser engine automated tests
```

## Running the tests

```bash
python3 -m pytest tests/ -v
```

## Disclaimer

AuthorLedger is not legal advice and has no relationship with Amazon or KDP. It generates records and suggestions based entirely on what *you* tell it. Always check Amazon KDP's current content guidelines before publishing: <https://kdp.amazon.com/en_US/help>.

## About

Built by [Saurav Kushwaha](https://github.com/authorsauravkushwaha) — a published author of 90+ books and a first-year Computer Science (AI & ML) student, learning the field by building things he'd actually use.

## License

MIT — see [LICENSE](LICENSE).
