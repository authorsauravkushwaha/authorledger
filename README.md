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

- **A calm, author-first workspace.** An editorial dashboard with a dedicated manuscript shelf, persistent studio navigation, an illustrated welcome, live writing statistics, and a 26-week ledger-activity heatmap. Search manuscripts by title or author, sort by recent activity, title, or word count, and open them with the keyboard.
- **Make a daily writing practice.** Set your own daily word goal and see net words added in the editor on this device today. A 25-minute focus timer supports pause, reset, and reload recovery, using a real deadline so background-tab throttling doesn't lose time. Sample books and manuscript imports don't inflate your daily writing count.
- **A clearer next step.** Jump into your latest chapter, export a manuscript, run offline craft feedback, or explore the studio guide. Backup and restore are available in workspace settings on mobile as well as the desktop sidebar. All statistics start with your real data, not fabricated activity.
- **Keep a story bible with the book.** Every character, place, rule of the world, and plot beat lives beside the manuscript — searchable, taggable, exportable as Markdown, and insertable into the draft at the cursor with one click, so spellings and details never drift between chapters.
- **Line-edit like an editor would.** A one-click offline copy-editing pass marks filter words, intensifiers, `-ly` adverbs, rough passive constructions, worn phrases, repeated sentence openers, and pacing outliers. Every mark jumps to the exact sentence. It never scores your prose and never guesses how it was written.
- **Hear the book, and keep the page still.** Read any chapter aloud from your cursor using your device's own voice, and switch on **typewriter mode** so the line you're writing stays put while the page moves around it.
- **See the shape of the manuscript.** A manuscript-health panel charts words per chapter, flags chapters that are far shorter or longer than the rest, tracks how much of the book is still unstamped, and tells you the one honest next step.
- **Make a daily practice that remembers.** Streaks, daily word goals, and a focus timer — all computed from your real writing on this device, never from fabricated activity.
- **Write and save directly in your browser.** Create books and chapters, set word-count goals, write in **Focus Mode** with customizable typography (`Serif`, `Sans`, `Mono`) and paper themes (`Ledger`, `Parchment`, `Night Ink`), use Find & Replace, reorder chapters, and save named **version snapshots** before rewrites. Everything saves automatically to your browser (`IndexedDB` + synchronous `localStorage` mirror) with zero account or server required.
- **Own your manuscript & backups.** Download your compiled book anytime as **Markdown (`.md`)**, **Plain Text (`.txt`)**, or **Print-ready Typeset HTML / PDF (`.html`)**. Import existing `.md` or `.txt` manuscripts (automatically split into chapters) and export/restore full `.json` workspace backups across devices.
- **Log every chapter honestly.** Stamp each chapter **Human-written**, **AI-assisted**, or **AI-generated**, with an optional note about which tool and what it helped with.
- **Keep a real append-only audit trail.** Every classification, edit milestone, snapshot, and correction is timestamped and kept forever — reclassifying a chapter adds a new entry, it never rewrites history. Delete a chapter or an entire book and the global ledger still remembers it existed.
- **Export a KDP compliance report** in one click: word counts by classification, percentages, chapter breakdown, and a plain-language suggested disclosure note for KDP, downloadable as Markdown.
- **Run a Writing Pattern Report**, if you want one — sentence-rhythm (burstiness), word variety, repeated trigrams, and overused-phrase stats on any chapter, framed as a memory-jogger for your own honest classification, **not** as an AI detector.
- **Check craft & pacing offline (or optionally ask Claude).** Run an instant, offline craft check (paragraph pacing, sentence rhythm, modifier density, dialogue balance), or optionally add your own Anthropic API key in browser settings for live Claude feedback.

## The craft layer: built for the writing, not the feed

Most writing platforms are built to keep you scrolling. AuthorLedger is built to get the book finished. There is no feed, no algorithm, no follower count, and no account to grow — which is exactly why the tools can afford to be honest:

- **A story bible that belongs to the book.** Characters, places, lore, and plot beats are stored per manuscript, searchable, and exportable. Insert a character's name into a scene at the cursor so continuity survives a 40-chapter series.
- **A line edit, not a lecture.** The scanner is a pencil, not a judge: it points at the tics editors circle and gets out of the way. No scores, no grades, no "AI likelihood", and every mark is one click from the actual sentence.
- **Read aloud, on your device.** Your browser's own speech engine reads from your cursor to the end of the chapter. Nothing is uploaded, and nothing is synthesized anywhere but locally.
- **Typewriter mode.** The page moves under your eyes; the line you're writing stays in the middle of the screen.
- **Manuscript health.** Chapter-length distribution, pacing outliers, unstamped chapters, and a single, specific next step — measured from your real text, not from a checklist.
- **A streak with a memory.** Daily words are recorded on this device so "I wrote yesterday" is a fact you can check, not a feeling.

All of it works offline, all of it is free, and none of it asks you to publish in public to be useful.

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
│   ├── engine.js              # browser IndexedDB store, line edit, manuscript health, analysis, reports, compiler
│   ├── depth.js               # 3D layer: hero book scene, card tilt/glare, scroll reveal (no libraries)
│   ├── app.js                 # UI controller (autosave, story bible, read aloud, focus mode, snapshots, exports)
│   └── style.css              # responsive studio shell, paper themes & book covers
├── main.py                    # optional local Python entry point
├── authorledger/              # optional stdlib-only Python + SQLite backend
│   ├── database.py            # SQLite layer + append-only audit log + snapshots + story bible
│   ├── analysis.py            # Writing Pattern Report heuristics
│   ├── reports.py             # compliance report + suggested disclosure text
│   ├── llm_assist.py          # optional Claude integration via urllib
│   └── server.py              # stdlib HTTP server + JSON API (incl. story-bible routes)
└── tests/                     # Python, server API, browser-engine and studio UI tests
```

## Running the tests

```bash
python3 -m pytest tests/ -v
```

Optional real-browser checks cover responsive layouts, manuscript search and
sorting, autosave persistence, daily goals, timer recovery, keyboard navigation,
mobile backups, manuscript export, and the craft layer (story bible, line edit,
typewriter mode, read-aloud controls, manuscript health):

```bash
python3 -m pip install playwright
python3 -m playwright install chromium
python3 -m pytest tests/test_studio_browser.py -v
```

If Chromium is already installed elsewhere, set
`AUTHORLEDGER_CHROMIUM_EXECUTABLE=/path/to/chromium`. Browser tests skip cleanly
when Playwright or its browser is not installed.

## Disclaimer

AuthorLedger is not legal advice and has no relationship with Amazon or KDP. It generates records and suggestions based entirely on what *you* tell it. Always check Amazon KDP's current content guidelines before publishing: <https://kdp.amazon.com/en_US/help>.

## About

Built by [Saurav Kushwaha](https://github.com/authorsauravkushwaha) — a published author of 90+ books and a first-year Computer Science (AI & ML) student, learning the field by building things he'd actually use.

## License

MIT — see [LICENSE](LICENSE).
