/*
 * app.js — AuthorLedger Writing Studio & Compliance Ledger controller.
 *
 * Runs 100% in the visitor's browser on any static website (GitHub Pages,
 * Arena preview, offline) via AuthorLedgerEngine.BrowserLedgerStore, and
 * also seamlessly connects to the optional Python SQLite server when
 * launched locally via `python3 main.py`.
 */

(function () {
  "use strict";

  const Engine = window.AuthorLedgerEngine;
  const CLASSIFICATION_LABELS = Engine.CLASSIFICATION_BADGE_LABELS;

  const THEME_ORDER = ["ledger", "parchment", "night"];
  const THEME_NAMES = {
    ledger: "Ledger",
    parchment: "Parchment",
    night: "Night Ink",
  };

  const STATUS_LABELS = {
    drafting: "Drafting",
    revising: "Revising",
    final: "Final",
  };

  const state = {
    mode: "browser", // "browser" | "server"
    serverLlmConfigured: false,
    store: new Engine.BrowserLedgerStore(),
    books: [],
    activeBookId: null,
    activeBook: null,
    activeChapterId: null,
    activeChapter: null,
    chapterSearch: "",
    chapterFilterClass: "all",
    autosaveTimer: null,
    dirtyText: false,
    lastReport: null,
    lastReportMarkdown: "",
    findCursor: 0,
    typewriterMode: false,
    lintResult: null,
    bibleModalMode: "manage",
    readAloud: { speaking: false, paused: false, chunks: [], index: 0, utterance: null },
  };

  // --------------------------------------------------- Backend Adapter --

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request to ${path} failed (${res.status}).`);
    }
    return data;
  }

  async function detectBackendMode() {
    const host = window.location.hostname;
    const isLocalhost = host === "127.0.0.1" || host === "localhost";
    if (!isLocalhost || window.location.protocol === "file:") {
      return "browser";
    }
    try {
      // Fetching "./" returns 200 on every static server (never a 404 console error),
      // while allowing us to inspect whether Python's AuthorLedger/1.0 server is running.
      const probe = await fetch("./", { method: "GET", cache: "no-store" });
      const serverHeader = probe.headers.get("Server") || "";
      await probe.text(); // Drain the probe body so its connection can finish.
      if (serverHeader.includes("AuthorLedger")) {
        const status = await api("/api/status");
        state.serverLlmConfigured = Boolean(status.llm_configured);
        return "server";
      }
    } catch {
      // Fall back to pure browser storage silently.
    }
    return "browser";
  }

  // Unified data operations across Browser Store and optional Local Python Server
  const Data = {
    async listBooks() {
      if (state.mode === "server") {
        const { books } = await api("/api/books");
        return books;
      }
      return state.store.listBooks();
    },

    async getBook(bookId) {
      if (state.mode === "server") {
        return api(`/api/books/${bookId}`);
      }
      return state.store.getBook(bookId);
    },

    async createBook(payload) {
      if (state.mode === "server") {
        return api("/api/books", { method: "POST", body: JSON.stringify(payload) });
      }
      return state.store.createBook(payload);
    },

    async updateBook(bookId, payload) {
      if (state.mode === "server") {
        return api(`/api/books/${bookId}`, { method: "PUT", body: JSON.stringify(payload) });
      }
      return state.store.updateBook(bookId, payload);
    },

    async deleteBook(bookId) {
      if (state.mode === "server") {
        return api(`/api/books/${bookId}`, { method: "DELETE" });
      }
      return state.store.deleteBook(bookId);
    },

    async createChapter(bookId, payload) {
      if (state.mode === "server") {
        return api(`/api/books/${bookId}/chapters`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      return state.store.createChapter(bookId, payload);
    },

    async getChapter(chapterId) {
      if (state.mode === "server") {
        return api(`/api/chapters/${chapterId}`);
      }
      return state.store.getChapter(chapterId);
    },

    async updateChapterText(chapterId, text, { logAudit = true } = {}) {
      if (state.mode === "server") {
        return api(`/api/chapters/${chapterId}/text`, {
          method: "PUT",
          body: JSON.stringify({ text, log_audit: logAudit }),
        });
      }
      return state.store.updateChapterText(chapterId, text, { logAudit });
    },

    async updateChapterMeta(chapterId, payload) {
      if (state.mode === "server") {
        return api(`/api/chapters/${chapterId}/meta`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      }
      return state.store.updateChapterMeta(chapterId, payload);
    },

    async reorderChapter(chapterId, direction) {
      if (state.mode === "server") {
        const res = await api(`/api/chapters/${chapterId}/reorder`, {
          method: "POST",
          body: JSON.stringify({ direction }),
        });
        return res.chapters;
      }
      return state.store.reorderChapter(chapterId, direction);
    },

    async classifyChapter(chapterId, classification, note) {
      if (state.mode === "server") {
        return api(`/api/chapters/${chapterId}/classify`, {
          method: "PUT",
          body: JSON.stringify({ classification, note }),
        });
      }
      return state.store.classifyChapter(chapterId, classification, note);
    },

    async deleteChapter(chapterId) {
      if (state.mode === "server") {
        return api(`/api/chapters/${chapterId}`, { method: "DELETE" });
      }
      return state.store.deleteChapter(chapterId);
    },

    async runPatternAnalysis(chapterId, currentText) {
      if (state.mode === "server") {
        return api(`/api/chapters/${chapterId}/analysis`);
      }
      return Engine.analyzeText(currentText);
    },

    async listSnapshots(chapterId) {
      if (state.mode === "server") {
        const { snapshots } = await api(`/api/chapters/${chapterId}/snapshots`);
        return snapshots;
      }
      return state.store.listSnapshots(chapterId);
    },

    async createSnapshot(chapterId, label) {
      if (state.mode === "server") {
        return api(`/api/chapters/${chapterId}/snapshots`, {
          method: "POST",
          body: JSON.stringify({ label }),
        });
      }
      return state.store.createSnapshot(chapterId, label);
    },

    async restoreSnapshot(snapshotId) {
      if (state.mode === "server") {
        return api(`/api/snapshots/${snapshotId}/restore`, { method: "POST" });
      }
      return state.store.restoreSnapshot(snapshotId);
    },

    async getAuditLog(bookId) {
      if (state.mode === "server") {
        const { audit_log } = await api(`/api/books/${bookId}/audit`);
        return audit_log;
      }
      return state.store.getAuditLog(bookId);
    },

    async getGlobalAuditLog() {
      if (state.mode === "server") {
        const { audit_log } = await api("/api/audit");
        return audit_log;
      }
      return state.store.getGlobalAuditLog();
    },

    async listBibleEntries(bookId) {
      if (state.mode === "server") {
        const { entries } = await api(`/api/books/${bookId}/bible`);
        return entries;
      }
      return state.store.listBibleEntries(bookId);
    },

    async saveBibleEntry(bookId, payload) {
      if (state.mode === "server") {
        const path = payload.id
          ? `/api/books/${bookId}/bible/${payload.id}`
          : `/api/books/${bookId}/bible`;
        return api(path, { method: payload.id ? "PUT" : "POST", body: JSON.stringify(payload) });
      }
      return state.store.saveBibleEntry(bookId, payload);
    },

    async deleteBibleEntry(bookId, entryId) {
      if (state.mode === "server") {
        return api(`/api/books/${bookId}/bible/${entryId}`, { method: "DELETE" });
      }
      return state.store.deleteBibleEntry(entryId);
    },

    async getReport(bookId) {
      if (state.mode === "server") {
        return api(`/api/books/${bookId}/report`);
      }
      const book = await state.store.getBook(bookId);
      const report = Engine.buildReport(book, book.chapters);
      const prefs = state.store.getPrefs();
      if (prefs.anthropicApiKey) {
        try {
          const prompt =
            "You are helping a self-published author write a short, plain-English note " +
            "for their own private records, summarizing how much of their book was " +
            "human-written versus AI-assisted versus AI-generated, based on the " +
            "structured data below. Be factual and brief (3-4 sentences), do not add " +
            "any legal advice or claims about Amazon policy beyond what's given, and do " +
            "not speculate about anything not in the data.\n\n" +
            `Book title: ${report.book_title}\n` +
            `Total chapters: ${report.total_chapters}\n` +
            `Word counts by classification: ${JSON.stringify(report.word_counts_by_classification)}\n` +
            `Suggested disclosure note: ${report.suggested_disclosure}\n`;
          report.narrative_summary = await Engine.callClaudeBrowser({
            apiKey: prefs.anthropicApiKey,
            prompt,
            maxTokens: 300,
          });
        } catch {
          report.narrative_summary = null;
        }
      }
      return report;
    },
  };

  // ------------------------------------------------------------- Boot --

  async function boot() {
    applyPreferences();
    wireStaticEvents();
    wireStudioEvents();
    state.mode = await detectBackendMode();
    if (state.mode === "browser") {
      await state.store.init();
      const backupLink = document.getElementById("backup-download-link");
      backupLink.setAttribute("href", "#download-backup");
      backupLink.removeAttribute("download");
    }
    refreshIndicators();
    await refreshBookList();
  }

  function applyPreferences() {
    const prefs = state.store.getPrefs();
    const theme = THEME_ORDER.includes(prefs.theme) ? prefs.theme : "ledger";
    document.documentElement.setAttribute("data-theme", theme);
    document.getElementById("theme-toggle-btn").textContent = `Paper: ${THEME_NAMES[theme]}`;

    const font = ["serif", "sans", "mono"].includes(prefs.editorFont) ? prefs.editorFont : "serif";
    const size = ["small", "medium", "large"].includes(prefs.editorSize) ? prefs.editorSize : "medium";
    document.getElementById("editor-font-select").value = font;
    document.getElementById("editor-size-select").value = size;
    applyEditorTypography(font, size);
    applyTypewriterMode(Boolean(prefs.typewriterMode));
  }

  function applyEditorTypography(font, size) {
    const editor = document.getElementById("chapter-text");
    editor.classList.remove("editor-serif", "editor-sans", "editor-mono");
    editor.classList.remove("editor-small", "editor-medium", "editor-large");
    editor.classList.add(`editor-${font}`, `editor-${size}`);
  }

  function refreshIndicators() {
    const llmBtn = document.getElementById("llm-indicator");
    const prefs = state.store.getPrefs();
    const hasClaude = state.mode === "server"
      ? state.serverLlmConfigured
      : Boolean(prefs.anthropicApiKey);

    if (hasClaude) {
      llmBtn.textContent = "Claude features: on";
      llmBtn.className = "llm-indicator on";
    } else {
      llmBtn.textContent = "Claude features: off (optional)";
      llmBtn.className = "llm-indicator off";
    }

    const storageText = document.getElementById("storage-indicator-text");
    const explain = document.getElementById("settings-storage-explain");
    if (state.mode === "server") {
      storageText.textContent = "Saved to local SQLite (.db)";
      explain.textContent =
        "Connected to your local Python SQLite server (authorledger.db). Use 'Download full backup' on the shelf anytime for a clean snapshot.";
    } else {
      const backendLabel = state.store.storageBackend === "indexeddb"
        ? "Saved in browser (IndexedDB)"
        : "Saved in browser";
      storageText.textContent = backendLabel;
    }
  }

  function setSavingBadge(isSaving, customLabel) {
    const wrap = document.getElementById("storage-indicator");
    const textEl = document.getElementById("storage-indicator-text");
    wrap.classList.toggle("saving", Boolean(isSaving));
    if (customLabel) {
      textEl.textContent = customLabel;
    } else {
      refreshIndicators();
    }
  }

  // ----------------------------------------------- Covers & Dashboard --

  const COVER_TONE_COUNT = 8;

  function coverToneFor(title) {
    const s = String(title || "");
    let hash = 0;
    for (let i = 0; i < s.length; i += 1) {
      hash = (hash * 31 + s.charCodeAt(i)) % 100000;
    }
    return hash % COVER_TONE_COUNT;
  }

  function initialsFor(title) {
    const words = String(title || "")
      .replace(/[^a-z0-9 ]/gi, " ")
      .split(/\s+/)
      .filter(Boolean)
      .filter((w) => !/^(the|a|an|of|and)$/i.test(w));
    if (!words.length) return "§";
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function dayKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // A small CSS-3D book (six faces) used on the dashboard shelf. Pure DOM +
  // CSS transforms; styling lives in style.css under "3D DEPTH LAYER".
  function buildBook3D(tone, initialsText) {
    const toneClass = `cover-tone-${tone}`;
    const book = document.createElement("div");
    book.className = "book3d";
    book.setAttribute("aria-hidden", "true");

    const face = (cls, extra) => {
      const el = document.createElement("div");
      el.className = `b3-face ${cls}${extra ? ` ${extra}` : ""}`;
      return el;
    };

    const front = face("b3-front", toneClass);
    const mark = document.createElement("span");
    mark.className = "dash-book-mark";
    mark.textContent = "§";
    const initials = document.createElement("span");
    initials.className = "dash-book-initials";
    initials.textContent = initialsText;
    front.appendChild(mark);
    front.appendChild(initials);

    book.appendChild(face("b3-back", toneClass));
    book.appendChild(face("b3-spine", toneClass));
    book.appendChild(face("b3-pages"));
    book.appendChild(face("b3-top"));
    book.appendChild(face("b3-bottom"));
    book.appendChild(front);
    return book;
  }

  function renderDashShelf(books) {
    document.getElementById("manuscript-count").textContent = String(books.length);
    const query = document.getElementById("manuscript-search").value.trim().toLowerCase();
    const sort = document.getElementById("manuscript-sort").value;
    const allCount = books.length;
    books = books.filter((book) => `${book.title} ${book.author_name || ""}`.toLowerCase().includes(query));
    books = [...books].sort((a, b) => sort === "title"
      ? a.title.localeCompare(b.title)
      : sort === "words" ? (b.word_count || 0) - (a.word_count || 0)
      : String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
    document.getElementById("shelf-no-results").hidden = !(allCount && !books.length);
    const grid = document.getElementById("dash-shelf");
    const empty = document.getElementById("dash-shelf-empty");
    grid.innerHTML = "";
    if (!books.length) {
      empty.hidden = allCount > 0;
      return;
    }
    empty.hidden = true;

    for (const book of books) {
      const card = document.createElement("article");
      card.className = "dash-book-card";
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-label", `Open ${book.title}`);

      const cover = document.createElement("div");
      cover.className = "dash-book-cover";
      cover.appendChild(buildBook3D(coverToneFor(book.title), initialsFor(book.title)));

      const body = document.createElement("div");
      body.className = "dash-book-body";
      const title = document.createElement("h4");
      title.className = "dash-book-title";
      title.textContent = book.title;
      body.appendChild(title);

      if (book.author_name) {
        const byline = document.createElement("p");
        byline.className = "dash-book-byline";
        byline.textContent = `by ${book.author_name}`;
        body.appendChild(byline);
      }

      const meta = document.createElement("div");
      meta.className = "dash-book-meta";
      const chCount = book.chapter_count ?? 0;
      const wCount = book.word_count ?? 0;
      meta.textContent = `${chCount} ch · ${wCount.toLocaleString()} words · ~${Engine.estimateReadingMinutes(wCount)}m read`;
      body.appendChild(meta);

      const goal = Number(book.word_goal) || 0;
      if (goal > 0) {
        const progress = document.createElement("progress");
        progress.className = "dash-book-progress";
        progress.max = goal;
        progress.value = Math.min(goal, wCount);
        const pct = Math.min(100, Math.round((wCount / goal) * 100));
        progress.title = `${pct}% of goal`;
        body.appendChild(progress);
        const goalLine = document.createElement("div");
        goalLine.className = "dash-book-goal";
        goalLine.textContent = `${pct}% of ${goal.toLocaleString()}w goal`;
        body.appendChild(goalLine);
      }

      card.appendChild(cover);
      card.appendChild(body);
      card.addEventListener("click", async () => {
        await flushPendingAutosave();
        openBook(book.id);
      });
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openBook(book.id);
        }
      });
      grid.appendChild(card);
    }
  }

  function renderHeatmap(auditEntries) {
    const map = new Map();
    for (const entry of auditEntries || []) {
      if (!entry.timestamp) continue;
      const key = dayKey(new Date(entry.timestamp));
      map.set(key, (map.get(key) || 0) + 1);
    }

    const container = document.getElementById("dash-heatmap");
    container.innerHTML = "";

    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 181);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - start.getDay()); // align to Sunday

    const end = new Date(today);
    end.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + (6 - end.getDay())); // complete the week

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = dayKey(d);
      const count = map.get(key) || 0;
      let level = 0;
      if (count >= 7) level = 4;
      else if (count >= 4) level = 3;
      else if (count >= 2) level = 2;
      else if (count >= 1) level = 1;

      const cell = document.createElement("span");
      cell.className = `heat-cell heat-${level}`;
      const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      cell.title = `${label} · ${count} ledger event${count === 1 ? "" : "s"}`;
      container.appendChild(cell);
    }
  }

  function renderDashFeed(auditEntries) {
    const feed = document.getElementById("dash-activity-feed");
    const empty = document.getElementById("dash-feed-empty");
    feed.innerHTML = "";

    const recent = (auditEntries || []).slice().reverse().slice(0, 6);
    if (!recent.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    for (const entry of recent) {
      const li = document.createElement("li");
      li.className = "feed-item";

      const time = document.createElement("span");
      time.className = "feed-time";
      time.textContent = formatTimestamp(entry.timestamp).replace(/,\s*\d{4}/, "");

      const event = document.createElement("span");
      event.className = "feed-event";
      const strong = document.createElement("strong");
      strong.textContent = entry.event_type || "ledger_event";
      event.appendChild(strong);
      const wcSuffix =
        entry.word_count !== null && entry.word_count !== undefined
          ? ` (${Number(entry.word_count).toLocaleString()}w)`
          : "";
      const where = entry.chapter_title
        ? ` · ${entry.chapter_title}${wcSuffix}`
        : entry.book_title
          ? ` · ${entry.book_title}`
          : "";
      event.appendChild(document.createTextNode(`${where}${entry.detail ? " — " + entry.detail : ""}`));

      li.appendChild(time);
      li.appendChild(event);
      feed.appendChild(li);
    }
  }

  async function renderDashboard() {
    try {
      const books = state.books || [];
      const totalChapters = books.reduce((sum, b) => sum + (b.chapter_count || 0), 0);
      const totalWords = books.reduce((sum, b) => sum + (b.word_count || 0), 0);

      document.getElementById("dash-stat-books").textContent = String(books.length);
      document.getElementById("dash-stat-chapters").textContent = totalChapters.toLocaleString();
      document.getElementById("dash-stat-words").textContent = totalWords.toLocaleString();
      document.getElementById("dash-stat-readtime").textContent =
        totalWords > 0 ? `~${Engine.estimateReadingMinutes(totalWords)}m` : "0m";

      let audit = [];
      try {
        audit = await Data.getGlobalAuditLog();
      } catch {
        audit = [];
      }
      document.getElementById("dash-stat-ledger").textContent = (audit.length || 0).toLocaleString();

      renderDashShelf(books);
      renderHeatmap(audit);
      renderDashFeed(audit);
      renderDailyGoal();
    } catch {
      // The dashboard is decoration on top of the studio — never let it break the app.
    }
  }

  async function goStudioHome(scrollTargetId) {
    exitFocusMode();
    await flushPendingAutosave();
    hide("chapter-view");
    hide("book-view");
    hide("book-edit-panel");
    show("empty-desk");
    await renderDashboard();
    setWorkspaceLocation("Overview", "nav-home-btn");
    if (scrollTargetId) {
      const target = document.getElementById(scrollTargetId);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  // ----------------------------------------- Daily practice & focus --

  function setWorkspaceLocation(label, activeId) {
    document.getElementById("workspace-location").textContent = label;
    document.querySelectorAll(".header-nav .nav-btn").forEach((button) => {
      const active = button.id === activeId;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
  }

  function getDailyProgress() {
    const progress = state.store.getPrefs().dailyProgress;
    return progress && progress.date === dayKey(new Date())
      ? { words: Math.max(0, Number(progress.words) || 0) } : { words: 0 };
  }

  function renderDailyGoal() {
    const goal = Math.min(100000, Math.max(1, Number(state.store.getPrefs().dailyWordGoal) || 500));
    const words = getDailyProgress().words;
    document.getElementById("daily-words").textContent = words.toLocaleString();
    document.getElementById("daily-words").title = "Net words added in the editor today on this device, including pasted text. Imports and sample books are not counted.";
    document.getElementById("daily-goal-label").textContent = goal.toLocaleString();
    if (document.getElementById("daily-goal-form").hidden) document.getElementById("daily-goal-input").value = goal;
    document.getElementById("daily-goal-ring").style.strokeDashoffset = String(100 - Math.min(100, words / goal * 100));
    document.getElementById("goal-encouragement").textContent = words >= goal
      ? "You showed up. Your daily intention is complete!"
      : words > 0 ? `${(goal - words).toLocaleString()} more words. You’re making room for your story.`
      : "A blank page is full of possibility.";

    const streakEl = document.getElementById("daily-streak");
    const history = { ...(state.store.getPrefs().dailyHistory || {}) };
    history[dayKey(new Date())] = words;
    const streak = computeWritingStreak(history);
    if (streak >= 2) {
      streakEl.textContent = `${streak}-day writing streak — every one of them counted.`;
      streakEl.classList.add("is-live");
    } else if (words > 0) {
      streakEl.textContent = "Day one of a new streak. Come back tomorrow.";
      streakEl.classList.add("is-live");
    } else {
      streakEl.textContent = "Start a streak today — one word is enough.";
      streakEl.classList.remove("is-live");
    }
  }

  function computeWritingStreak(history) {
    let streak = 0;
    const cursor = new Date();
    if (!((history[dayKey(cursor)] || 0) > 0)) cursor.setDate(cursor.getDate() - 1);
    while ((history[dayKey(cursor)] || 0) > 0) {
      streak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  function recordDailyWords(words) {
    const key = dayKey(new Date());
    const prefs = state.store.getPrefs();
    const history = { ...(prefs.dailyHistory || {}) };
    history[key] = Math.max(0, Number(words) || 0);
    const trimmed = {};
    for (const day of Object.keys(history).sort().slice(-400)) trimmed[day] = history[day];
    state.store.savePrefs({
      dailyProgress: { date: key, words: history[key] },
      dailyHistory: trimmed,
    });
  }

  function wireStudioEvents() {
    const date = new Date();
    const dateEl = document.getElementById("studio-date");
    dateEl.dateTime = dayKey(date);
    dateEl.textContent = date.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    setWorkspaceLocation("Overview", "nav-home-btn");
    const on = (id, event, fn) => document.getElementById(id).addEventListener(event, fn);
    const newManuscript = () => {
      const input = document.getElementById("new-book-title");
      input.scrollIntoView({ behavior: "smooth", block: "center" });
      input.focus({ preventScroll: true });
    };
    on("shelf-create-btn", "click", newManuscript);
    on("focus-new-book-btn", "click", newManuscript);
    on("workspace-settings-btn", "click", () => document.getElementById("llm-indicator").click());
    on("settings-backup-btn", "click", () => document.getElementById("backup-download-link").click());
    on("settings-restore-btn", "click", () => { hide("settings-modal"); document.getElementById("restore-backup-btn").click(); });
    on("settings-import-btn", "click", () => { hide("settings-modal"); show("import-modal"); });
    on("manuscript-search", "input", () => renderDashShelf(state.books));
    on("manuscript-sort", "change", () => renderDashShelf(state.books));
    on("nav-manuscripts-btn", "click", async () => {
      await goStudioHome("dash-shelf-section");
      setWorkspaceLocation("Manuscripts", "nav-manuscripts-btn");
    });
    on("disclosure-open-btn", "click", openGlobalAuditModal);
    on("daily-write-btn", "click", async () => {
      await flushPendingAutosave();
      const bookId = state.activeBookId || state.books[0]?.id;
      if (!bookId) { newManuscript(); return; }
      await openBook(bookId);
      const chapters = state.activeBook.chapters || [];
      if (chapters.length) await openChapter(chapters[chapters.length - 1].id);
      else {
        const chapter = await Data.createChapter(bookId, { title: "Chapter 1" });
        await refreshBookList();
        await openChapter(chapter.id);
      }
      document.getElementById("chapter-text").focus();
    });
    on("edit-daily-goal-btn", "click", () => {
      const form = document.getElementById("daily-goal-form");
      form.hidden = !form.hidden;
      if (!form.hidden) document.getElementById("daily-goal-input").focus();
    });
    on("daily-goal-form", "submit", (e) => {
      e.preventDefault();
      const goal = Number(document.getElementById("daily-goal-input").value);
      if (!Number.isInteger(goal) || goal < 1 || goal > 100000) return;
      state.store.savePrefs({ dailyWordGoal: goal });
      document.getElementById("daily-goal-form").hidden = true;
      renderDailyGoal();
    });
    on("tools-export-btn", "click", async () => {
      await flushPendingAutosave();
      const bookId = state.activeBookId || state.books[0]?.id;
      if (!bookId) { newManuscript(); return; }
      await openBook(bookId);
      show("manuscript-modal");
    });
    on("tools-craft-btn", "click", async () => {
      await flushPendingAutosave();
      const bookId = state.activeBookId || state.books[0]?.id;
      if (!bookId) { newManuscript(); return; }
      await openBook(bookId);
      const chapter = state.activeBook.chapters?.[0];
      if (!chapter) { document.getElementById("new-chapter-title").focus(); return; }
      await openChapter(chapter.id);
      document.getElementById("run-local-craft-btn").click();
      document.getElementById("feedback-results").scrollIntoView({ behavior: "smooth" });
    });
    on("tools-guide-btn", "click", () => document.getElementById("nav-guide-btn").click());

    // Use a deadline, not decrementing ticks, so background tabs stay accurate.
    let timer = state.store.getPrefs().focusTimer || { remaining: 1500, deadline: null };
    let completionAnnounced = false;
    const renderTimer = () => {
      const remaining = timer.deadline ? Math.max(0, Math.ceil((timer.deadline - Date.now()) / 1000)) : timer.remaining;
      document.getElementById("focus-clock").textContent = `${String(Math.floor(remaining / 60)).padStart(2, "0")}:${String(remaining % 60).padStart(2, "0")}`;
      document.getElementById("start-focus-btn").textContent = timer.deadline ? "Ⅱ Pause session" : remaining === 0 ? "▷ Start again" : "▷ Start session";
      if (remaining === 0 && timer.deadline) {
        timer = { remaining: 0, deadline: null };
        state.store.savePrefs({ focusTimer: timer });
        document.getElementById("start-focus-btn").textContent = "▷ Start again";
        document.getElementById("focus-session-note").textContent = "Session complete. Stretch, breathe, and take a break.";
        completionAnnounced = true;
      } else if (!completionAnnounced) {
        document.getElementById("focus-session-note").textContent = timer.deadline ? "Your time. Your story. You’ve got this." : "25 minutes, just for your story.";
      }
    };
    on("start-focus-btn", "click", () => {
      completionAnnounced = false;
      timer = timer.deadline
        ? { remaining: Math.max(0, Math.ceil((timer.deadline - Date.now()) / 1000)), deadline: null }
        : { remaining: timer.remaining || 1500, deadline: Date.now() + (timer.remaining || 1500) * 1000 };
      state.store.savePrefs({ focusTimer: timer });
      renderTimer();
    });
    on("reset-focus-btn", "click", () => {
      timer = { remaining: 1500, deadline: null };
      completionAnnounced = false;
      state.store.savePrefs({ focusTimer: timer });
      renderTimer();
    });
    renderTimer();
    setInterval(() => { renderTimer(); renderDailyGoal(); }, 1000);
  }

  // ------------------------------------------------------- Book Shelf --

  async function refreshBookList() {
    const books = await Data.listBooks();
    state.books = books;

    const totalWords = books.reduce((sum, b) => sum + (b.word_count || 0), 0);
    document.getElementById("shelf-summary").textContent =
      `${books.length} ${books.length === 1 ? "book" : "books"} · ${totalWords.toLocaleString()}w`;

    const list = document.getElementById("book-list");
    list.innerHTML = "";
    for (const book of books) {
      const li = document.createElement("li");
      li.dataset.bookId = book.id;
      li.tabIndex = 0;
      li.setAttribute("role", "button");
      li.setAttribute("aria-label", `Open ${book.title}`);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); li.click(); }
      });
      if (book.id === state.activeBookId) li.classList.add("active");

      const cover = document.createElement("span");
      cover.className = `book-item-cover cover-tone-${coverToneFor(book.title)}`;
      cover.textContent = initialsFor(book.title);

      const main = document.createElement("div");
      main.className = "book-item-main";

      const titleSpan = document.createElement("span");
      titleSpan.className = "book-item-title";
      titleSpan.textContent = book.title;

      const metaSpan = document.createElement("span");
      metaSpan.className = "book-item-meta";
      const chCount = book.chapter_count ?? 0;
      const wCount = book.word_count ?? 0;
      metaSpan.textContent = `${chCount} ch · ${wCount.toLocaleString()} words`;

      main.appendChild(titleSpan);
      main.appendChild(metaSpan);

      const goal = Number(book.word_goal) || 0;
      if (goal > 0) {
        const progress = document.createElement("progress");
        progress.className = "book-item-progress";
        progress.max = goal;
        progress.value = Math.min(goal, wCount);
        const pct = Math.min(100, Math.round((wCount / goal) * 100));
        progress.title = `${pct}% of goal`;
        main.appendChild(progress);
      }

      li.appendChild(cover);
      li.appendChild(main);
      li.addEventListener("click", async () => {
        await flushPendingAutosave();
        openBook(book.id);
      });
      list.appendChild(li);
    }

    await renderDashboard();
  }

  // ----------------------------------------------------- Event Wiring --

  function wireStaticEvents() {
    // Top navigation (studio home / write / ledger / reports / guide)
    document.getElementById("nav-home-btn").addEventListener("click", () => goStudioHome());
    document.getElementById("nav-write-btn").addEventListener("click", async () => {
      if (state.activeBookId) {
        exitFocusMode();
        await flushPendingAutosave();
        await openBook(state.activeBookId);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else if (state.books.length > 0) {
        await flushPendingAutosave();
        await openBook(state.books[0].id);
        window.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        document.getElementById("new-book-title").focus();
      }
    });
    document.getElementById("nav-ledger-btn").addEventListener("click", openGlobalAuditModal);
    document.getElementById("nav-reports-btn").addEventListener("click", async () => {
      if (state.activeBookId) {
        await openReportModal();
      } else if (state.books.length > 0) {
        await flushPendingAutosave();
        await openBook(state.books[0].id);
        await openReportModal();
      } else {
        document.getElementById("report-body").innerHTML =
          '<p class="muted-note">Create or open a book first — the compliance report is generated per manuscript from its chapter stamps.</p>';
        show("report-modal");
      }
    });
    document.getElementById("nav-guide-btn").addEventListener("click", () => {
      document.getElementById("studio-guide").open = true;
      goStudioHome("studio-guide");
    });
    document.getElementById("dash-ledger-btn").addEventListener("click", openGlobalAuditModal);

    // New book creation
    document.getElementById("new-book-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      await flushPendingAutosave();
      const titleInput = document.getElementById("new-book-title");
      const authorInput = document.getElementById("new-book-author");
      const goalInput = document.getElementById("new-book-goal");
      const title = titleInput.value.trim();
      if (!title) return;

      const book = await Data.createBook({
        title,
        author_name: authorInput.value.trim(),
        word_goal: parseInt(goalInput.value, 10) || 0,
      });
      titleInput.value = "";
      authorInput.value = "";
      goalInput.value = "";
      await refreshBookList();
      await openBook(book.id);
    });

    // Empty desk actions

    document.getElementById("load-sample-btn").addEventListener("click", async () => {
      await flushPendingAutosave();
      let book;
      if (state.mode === "browser") {
        book = await state.store.seedSampleBook();
      } else {
        book = await Data.createBook({
          title: "The Glass Cartographer (Sample)",
          author_name: "Demo Manuscript",
          author_note: "Sample novel demonstrating writing, autosave, and KDP disclosure logging.",
          word_goal: 2500,
        });
        await Data.createChapter(book.id, {
          title: "Chapter 1 — Salt on the Astrolabe",
          synopsis: "Mira discovers the missing sea chart before dawn.",
          status: "final",
          classification: "human",
          classification_note: "Drafted by hand.",
          text: "Rain had been promised since Tuesday, and still the harbor smelled only of dry rope and warm brass.\n\nMira unlocked the observatory's side door and saw the ring of salt where the astrolabe usually sat.",
        });
      }
      await refreshBookList();
      await openBook(book.id);
    });

    document.getElementById("empty-import-btn").addEventListener("click", () => show("import-modal"));
    document.getElementById("open-import-btn").addEventListener("click", () => show("import-modal"));
    document.getElementById("close-import-modal").addEventListener("click", () => hide("import-modal"));

    // Theme switcher
    document.getElementById("theme-toggle-btn").addEventListener("click", () => {
      const prefs = state.store.getPrefs();
      const idx = THEME_ORDER.indexOf(prefs.theme);
      const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
      state.store.savePrefs({ theme: next });
      applyPreferences();
    });

    // Settings / Optional Claude key modal
    document.getElementById("llm-indicator").addEventListener("click", () => {
      const prefs = state.store.getPrefs();
      document.getElementById("settings-api-key").value = prefs.anthropicApiKey || "";
      show("settings-modal");
    });
    document.getElementById("close-settings-modal").addEventListener("click", () => hide("settings-modal"));
    document.getElementById("clear-api-key-btn").addEventListener("click", () => {
      document.getElementById("settings-api-key").value = "";
      state.store.savePrefs({ anthropicApiKey: "" });
      refreshIndicators();
    });
    document.getElementById("settings-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const key = document.getElementById("settings-api-key").value.trim();
      state.store.savePrefs({ anthropicApiKey: key });
      refreshIndicators();
      hide("settings-modal");
    });

    // Backup download & restore
    document.getElementById("backup-download-link").addEventListener("click", async (e) => {
      if (state.mode === "server") return; // Let native /api/backup download .db
      e.preventDefault();
      await flushPendingAutosave();
      const bundle = await state.store.exportBackup();
      const stamp = new Date().toISOString().slice(0, 10);
      downloadBlob(
        JSON.stringify(bundle, null, 2),
        "application/json",
        `authorledger-backup-${stamp}.json`
      );
    });

    document.getElementById("restore-backup-btn").addEventListener("click", () => {
      document.getElementById("restore-backup-input").click();
    });

    document.getElementById("restore-backup-input").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      try {
        const raw = await file.text();
        const bundle = JSON.parse(raw);
        if (state.mode === "browser") {
          const { importedBooks } = await state.store.importBackup(bundle);
          await refreshBookList();
          if (state.books.length > 0) {
            await openBook(state.books[0].id);
          }
          alert(`Restored ${importedBooks} book(s) from backup.`);
        } else {
          // Import into server mode book-by-book
          const payload = bundle?.data || bundle;
          let count = 0;
          for (const b of payload.books || []) {
            const created = await Data.createBook({
              title: b.title,
              author_name: b.author_name || "",
              author_note: b.author_note || "",
              word_goal: b.word_goal || 0,
            });
            const chs = (payload.chapters || []).filter((c) => c.book_id === b.id);
            for (const c of chs) {
              await Data.createChapter(created.id, c);
            }
            count += 1;
          }
          await refreshBookList();
          if (state.books.length > 0) await openBook(state.books[0].id);
          alert(`Imported ${count} book(s) into server ledger.`);
        }
      } catch (err) {
        alert(err.message || "Could not read backup JSON file.");
      }
    });

    // Global ledger history across all books (including deleted books)
    document.getElementById("global-audit-btn").addEventListener("click", openGlobalAuditModal);

    // Import manuscript (.md / .txt)
    document.getElementById("import-file-input").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      document.getElementById("import-raw-text").value = text;
      const titleInput = document.getElementById("import-book-title");
      if (!titleInput.value.trim()) {
        const baseName = file.name.replace(/\.(md|markdown|txt)$/i, "").replace(/[-_]+/g, " ");
        const parsed = Engine.parseManuscriptImport(text, baseName);
        titleInput.value = parsed.title;
      }
    });

    document.getElementById("import-manuscript-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const rawText = document.getElementById("import-raw-text").value;
      const rawTitle = document.getElementById("import-book-title").value.trim() || "Imported Manuscript";
      const parsed = Engine.parseManuscriptImport(rawText, rawTitle);
      const book = await Data.createBook({
        title: rawTitle || parsed.title,
        author_note: `Imported manuscript (${parsed.chapters.length} chapter(s)).`,
      });
      for (const ch of parsed.chapters) {
        await Data.createChapter(book.id, { title: ch.title, text: ch.text });
      }
      document.getElementById("import-file-input").value = "";
      document.getElementById("import-book-title").value = "";
      document.getElementById("import-raw-text").value = "";
      hide("import-modal");
      await refreshBookList();
      await openBook(book.id);
    });

    // Book desk actions
    document.getElementById("back-to-book").addEventListener("click", async () => {
      exitFocusMode();
      await flushPendingAutosave();
      await openBook(state.activeBookId);
    });

    document.getElementById("quick-write-btn").addEventListener("click", async () => {
      if (!state.activeBook) return;
      const nextNum = (state.activeBook.chapters?.length || 0) + 1;
      const ch = await Data.createChapter(state.activeBookId, {
        title: `Chapter ${nextNum}`,
      });
      await refreshBookList();
      await openChapter(ch.id);
      document.getElementById("chapter-text").focus();
    });

    document.getElementById("edit-book-btn").addEventListener("click", () => {
      const panel = document.getElementById("book-edit-panel");
      if (!panel.hidden) {
        panel.hidden = true;
        return;
      }
      if (!state.activeBook) return;
      document.getElementById("edit-book-title").value = state.activeBook.title || "";
      document.getElementById("edit-book-author").value = state.activeBook.author_name || "";
      document.getElementById("edit-book-goal").value = state.activeBook.word_goal || "";
      document.getElementById("edit-book-note").value = state.activeBook.author_note || "";
      panel.hidden = false;
    });

    document.getElementById("cancel-edit-book-btn").addEventListener("click", () => {
      hide("book-edit-panel");
    });

    document.getElementById("book-edit-panel").addEventListener("submit", async (e) => {
      e.preventDefault();
      await Data.updateBook(state.activeBookId, {
        title: document.getElementById("edit-book-title").value,
        author_name: document.getElementById("edit-book-author").value,
        word_goal: parseInt(document.getElementById("edit-book-goal").value, 10) || 0,
        author_note: document.getElementById("edit-book-note").value,
      });
      hide("book-edit-panel");
      await refreshBookList();
      await openBook(state.activeBookId);
    });

    document.getElementById("chapter-search").addEventListener("input", (e) => {
      state.chapterSearch = e.target.value;
      if (state.activeBook) renderChapterTable(state.activeBook.chapters);
    });

    document.getElementById("chapter-filter-class").addEventListener("change", (e) => {
      state.chapterFilterClass = e.target.value;
      if (state.activeBook) renderChapterTable(state.activeBook.chapters);
    });

    document.getElementById("add-and-write-btn").addEventListener("click", async () => {
      const input = document.getElementById("new-chapter-title");
      const nextNum = (state.activeBook?.chapters?.length || 0) + 1;
      const title = input.value.trim() || `Chapter ${nextNum}`;
      const ch = await Data.createChapter(state.activeBookId, { title });
      input.value = "";
      await refreshBookList();
      await openChapter(ch.id);
      document.getElementById("chapter-text").focus();
    });

    document.getElementById("delete-book-btn").addEventListener("click", onDeleteBook);
    document.getElementById("view-audit-btn").addEventListener("click", openAuditModal);
    document.getElementById("close-audit").addEventListener("click", () => hide("audit-modal"));
    document.getElementById("export-report-btn").addEventListener("click", openReportModal);
    document.getElementById("close-report").addEventListener("click", () => hide("report-modal"));
    document.getElementById("download-report-btn").addEventListener("click", downloadReport);
    document.getElementById("copy-disclosure-btn").addEventListener("click", copyDisclosureNote);

    // Manuscript export modal
    document.getElementById("export-manuscript-btn").addEventListener("click", () => show("manuscript-modal"));
    document.getElementById("close-manuscript-modal").addEventListener("click", () => hide("manuscript-modal"));
    document.querySelectorAll("[data-export-format]").forEach((btn) => {
      btn.addEventListener("click", () => exportCompiledManuscript(btn.dataset.exportFormat));
    });

    // Chapter Studio events
    const editor = document.getElementById("chapter-text");
    editor.addEventListener("input", onEditorInput);
    editor.addEventListener("keydown", onEditorKeydown);
    ["keyup", "click", "select"].forEach((evt) => {
      editor.addEventListener(evt, () => requestAnimationFrame(centerCaretInEditor));
    });
    editor.addEventListener("input", () => requestAnimationFrame(centerCaretInEditor));

    // Craft layer — story bible, line edit, read aloud, typewriter mode
    document.getElementById("bible-add-btn").addEventListener("click", async () => {
      await openBibleModal();
      openBibleForm(null);
    });
    document.getElementById("bible-search").addEventListener("input", () => renderBibleSection(state.activeBook));
    document.getElementById("bible-filter").addEventListener("change", () => renderBibleSection(state.activeBook));
    document.getElementById("close-bible-modal").addEventListener("click", () => hide("bible-modal"));
    document.getElementById("bible-cancel-btn").addEventListener("click", () => {
      setBibleModalMode("manage");
      renderBibleModalList();
    });
    document.getElementById("bible-new-entry-btn").addEventListener("click", () => openBibleForm(null));
    document.getElementById("bible-export-btn").addEventListener("click", exportStoryBible);
    document.getElementById("bible-form").addEventListener("submit", saveBibleEntry);
    document.getElementById("bible-delete-btn").addEventListener("click", deleteBibleEntryFromForm);
    document.getElementById("editor-bible-btn").addEventListener("click", async () => {
      await openBibleModal({ mode: "pick" });
    });

    document.getElementById("line-edit-btn").addEventListener("click", runLineEdit);
    document.getElementById("line-edit-run-btn").addEventListener("click", runLineEdit);

    document.getElementById("read-aloud-btn").addEventListener("click", () => {
      const bar = document.getElementById("read-aloud-bar");
      bar.hidden = !bar.hidden;
      if (!bar.hidden) {
        document.getElementById("read-aloud-status").textContent = readAloudSupported()
          ? "Reads from your cursor to the end of the chapter, right here on your device."
          : "This browser doesn’t offer on-device speech. Chrome, Edge, and Safari do.";
      }
    });
    document.getElementById("read-toggle-btn").addEventListener("click", toggleReading);
    document.getElementById("read-stop-btn").addEventListener("click", () => stopReading());
    document.getElementById("read-rate-select").addEventListener("change", () => {
      if (state.readAloud.speaking && !state.readAloud.paused) {
        stopReading({ silent: true });
        startReading();
      }
    });
    document.getElementById("typewriter-btn").addEventListener("click", toggleTypewriterMode);

    document.getElementById("save-text-btn").addEventListener("click", () => onSaveText({ explicit: true }));
    document.getElementById("save-checkpoint-quick-btn").addEventListener("click", async () => {
      await flushPendingAutosave();
      await Data.createSnapshot(state.activeChapterId, "Quick checkpoint");
      const status = document.getElementById("save-status");
      status.textContent = "Checkpoint saved.";
      setTimeout(() => {
        if (status.textContent === "Checkpoint saved.") status.textContent = "Saved.";
      }, 2200);
    });

    document.getElementById("prev-chapter-btn").addEventListener("click", () => navigateSiblingChapter(-1));
    document.getElementById("next-chapter-btn").addEventListener("click", () => navigateSiblingChapter(1));

    document.getElementById("focus-mode-btn").addEventListener("click", toggleFocusMode);

    document.getElementById("chapter-status-select").addEventListener("change", async (e) => {
      if (!state.activeChapterId) return;
      state.activeChapter = await Data.updateChapterMeta(state.activeChapterId, {
        status: e.target.value,
      });
    });

    document.getElementById("toggle-chapter-meta-btn").addEventListener("click", () => {
      const panel = document.getElementById("chapter-meta-panel");
      if (!panel.hidden) {
        panel.hidden = true;
        return;
      }
      document.getElementById("edit-chapter-title").value = state.activeChapter?.title || "";
      document.getElementById("edit-chapter-synopsis").value = state.activeChapter?.synopsis || "";
      panel.hidden = false;
    });

    document.getElementById("cancel-chapter-meta-btn").addEventListener("click", () => {
      hide("chapter-meta-panel");
    });

    document.getElementById("chapter-meta-panel").addEventListener("submit", async (e) => {
      e.preventDefault();
      const updated = await Data.updateChapterMeta(state.activeChapterId, {
        title: document.getElementById("edit-chapter-title").value,
        synopsis: document.getElementById("edit-chapter-synopsis").value,
      });
      state.activeChapter = updated;
      renderActiveChapterMeta(updated);
      hide("chapter-meta-panel");
      await refreshBookList();
    });

    // Snapshots modal
    document.getElementById("snapshots-btn").addEventListener("click", openSnapshotsModal);
    document.getElementById("close-snapshots-modal").addEventListener("click", () => hide("snapshots-modal"));
    document.getElementById("new-snapshot-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      await flushPendingAutosave();
      const input = document.getElementById("new-snapshot-label");
      await Data.createSnapshot(state.activeChapterId, input.value.trim());
      input.value = "";
      await renderSnapshotsList();
    });

    document.getElementById("download-chapter-btn").addEventListener("click", async () => {
      await flushPendingAutosave();
      if (!state.activeChapter) return;
      const md = `# ${state.activeChapter.title}\n\n${state.activeChapter.text || ""}\n`;
      const slug = (state.activeChapter.title || "chapter").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
      downloadBlob(md, "text/markdown", `${slug}.md`);
    });

    // Formatting toolbar
    document.querySelectorAll(".tool-btn[data-insert]").forEach((btn) => {
      btn.addEventListener("click", () => applyEditorInsert(btn.dataset.insert));
    });

    document.getElementById("editor-font-select").addEventListener("change", (e) => {
      const prefs = state.store.savePrefs({ editorFont: e.target.value });
      applyEditorTypography(prefs.editorFont, prefs.editorSize);
    });

    document.getElementById("editor-size-select").addEventListener("change", (e) => {
      const prefs = state.store.savePrefs({ editorSize: e.target.value });
      applyEditorTypography(prefs.editorFont, prefs.editorSize);
    });

    // Find & Replace
    document.getElementById("toggle-find-btn").addEventListener("click", () => {
      const bar = document.getElementById("find-replace-bar");
      bar.hidden = !bar.hidden;
      if (!bar.hidden) document.getElementById("find-input").focus();
    });
    document.getElementById("close-find-btn").addEventListener("click", () => hide("find-replace-bar"));
    document.getElementById("find-input").addEventListener("input", updateFindCount);
    document.getElementById("find-next-btn").addEventListener("click", findNextInEditor);
    document.getElementById("replace-all-btn").addEventListener("click", replaceAllInEditor);

    // Classification & Analysis & Coaching
    document.querySelectorAll(".stamp-choice").forEach((btn) => {
      btn.addEventListener("click", () => onClassify(btn.dataset.value));
    });
    document.getElementById("save-note-btn").addEventListener("click", async () => {
      if (!state.activeChapter) return;
      await onClassify(state.activeChapter.classification || "unclassified");
    });

    document.getElementById("run-pattern-btn").addEventListener("click", onRunPattern);
    document.getElementById("run-local-craft-btn").addEventListener("click", onRunLocalCraft);
    document.getElementById("run-feedback-btn").addEventListener("click", onRunFeedback);

    document.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const modal = document.querySelector(".modal-backdrop:not([hidden])");
      if (!modal) return;
      const focusable = [...modal.querySelectorAll("button, a[href], input, select, textarea, [tabindex='0']")]
        .filter(el => !el.disabled && el.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
        e.preventDefault(); last?.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
        e.preventDefault(); first?.focus();
      }
    });

    // Close modals or Focus Mode on Escape + clicking backdrop
    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) hide(backdrop.id);
      });
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (state.readAloud.speaking) stopReading();
        let closedModal = false;
        document.querySelectorAll(".modal-backdrop").forEach((m) => {
          if (!m.hidden) {
            hide(m.id);
            closedModal = true;
          }
        });
        if (!closedModal && document.body.classList.contains("focus-mode")) {
          exitFocusMode();
        }
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        if (!document.getElementById("chapter-view").hidden && state.activeChapterId) {
          e.preventDefault();
          onSaveText({ explicit: true });
        }
      }
    });

    window.addEventListener("beforeunload", () => {
      if (state.readAloud.speaking) stopReading({ silent: true });
      if (state.dirtyText && state.activeChapterId && state.mode === "browser") {
        const text = document.getElementById("chapter-text").value;
        state.store.updateChapterTextSync(state.activeChapterId, text);
      }
    });
  }

  const modalReturnFocus = new Map();
  function hide(id) {
    const element = document.getElementById(id);
    element.hidden = true;
    if (element.classList.contains("modal-backdrop")) {
      const previous = modalReturnFocus.get(id);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      modalReturnFocus.delete(id);
    }
  }
  function show(id) {
    const element = document.getElementById(id);
    if (element.classList.contains("modal-backdrop")) {
      modalReturnFocus.set(id, document.activeElement);
      const dialog = element.querySelector(".modal");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      const heading = dialog.querySelector("h2");
      if (heading) {
        if (!heading.id) heading.id = `${id}-heading`;
        dialog.setAttribute("aria-labelledby", heading.id);
      }
    }
    element.hidden = false;
    if (element.classList.contains("modal-backdrop")) {
      element.querySelector("input:not([type=file]), button, select, textarea")?.focus();
    }
  }

  // --------------------------------------------------------- Book View --

  async function openBook(bookId) {
    setWorkspaceLocation("Manuscripts", "nav-manuscripts-btn");
    state.activeBookId = Number(bookId);
    state.activeChapterId = null;
    state.activeChapter = null;

    const book = await Data.getBook(state.activeBookId);
    state.activeBook = book;

    document.querySelectorAll("#book-list li").forEach((li) => {
      li.classList.toggle("active", Number(li.dataset.bookId) === state.activeBookId);
    });

    hide("empty-desk");
    hide("chapter-view");
    hide("book-edit-panel");
    show("book-view");

    document.getElementById("bible-search").value = "";
    document.getElementById("bible-filter").value = "all";
    document.getElementById("book-title").textContent = book.title;

    const bylineEl = document.getElementById("book-byline");
    if (book.author_name) {
      bylineEl.textContent = `by ${book.author_name}`;
      bylineEl.hidden = false;
    } else {
      bylineEl.hidden = true;
    }

    const noteEl = document.getElementById("book-note-display");
    if (book.author_note) {
      noteEl.textContent = book.author_note;
      noteEl.hidden = false;
    } else {
      noteEl.hidden = true;
    }

    // Generated cover + live manuscript stats
    const coverEl = document.getElementById("book-cover");
    coverEl.className = `book-cover-lg cover-tone-${coverToneFor(book.title)}`;
    document.getElementById("book-cover-initials").textContent = initialsFor(book.title);

    const chapters = book.chapters || [];
    const totalWords = chapters.reduce((sum, ch) => sum + Engine.countWords(ch.text), 0);
    const chCount = chapters.length;
    document.getElementById("book-stat-chapters").textContent = String(chCount);
    document.getElementById("book-stat-words").textContent = totalWords.toLocaleString();
    document.getElementById("book-stat-avg").textContent =
      chCount ? Math.round(totalWords / chCount).toLocaleString() : "0";
    document.getElementById("book-stat-readtime").textContent =
      `~${Engine.estimateReadingMinutes(totalWords)}m`;
    document.getElementById("book-stat-updated").textContent =
      book.updated_at ? formatTimestamp(book.updated_at).split(",")[0] : "—";

    renderGoalStrip(book, book.chapters);
    renderTallyStrip(book.chapters);
    renderManuscriptHealth(book);
    renderBibleSection(book);
    renderChapterTable(book.chapters);
  }

  function renderGoalStrip(book, chapters) {
    const goalStrip = document.getElementById("goal-strip");
    const totalWords = chapters.reduce((sum, ch) => sum + Engine.countWords(ch.text), 0);
    const goal = Number(book.word_goal) || 0;

    if (goal <= 0) {
      goalStrip.hidden = true;
      return;
    }
    const pct = Math.min(100, Math.round((totalWords / goal) * 100));
    document.getElementById("goal-progress-label").textContent =
      `Manuscript goal: ${totalWords.toLocaleString()} / ${goal.toLocaleString()} words (${pct}%)`;
    document.getElementById("goal-reading-label").textContent =
      totalWords > 0 ? `~${Engine.estimateReadingMinutes(totalWords)} min read` : "Ready to draft";
    const bar = document.getElementById("goal-progress-bar");
    bar.max = goal;
    bar.value = Math.min(goal, totalWords);
    goalStrip.hidden = false;
  }

  function renderTallyStrip(chapters) {
    const totals = { human: 0, ai_assisted: 0, ai_generated: 0, unclassified: 0 };
    for (const ch of chapters) {
      const words = Engine.countWords(ch.text);
      const cls = CLASSIFICATION_LABELS[ch.classification] ? ch.classification : "unclassified";
      totals[cls] = (totals[cls] || 0) + words;
    }
    const totalWords = Object.values(totals).reduce((a, b) => a + b, 0);
    const strip = document.getElementById("tally-strip");
    const parts = [];
    if (totalWords > 0) {
      parts.push(`<span><strong>${totalWords.toLocaleString()}</strong> total words</span>`);
    }
    for (const [key, words] of Object.entries(totals)) {
      if (words > 0) {
        parts.push(
          `<span><strong>${words.toLocaleString()}</strong> ${CLASSIFICATION_LABELS[key].toLowerCase()}</span>`
        );
      }
    }
    strip.innerHTML = parts.length ? parts.join("") : "<span>No chapter text yet — add a chapter below and start writing.</span>";
  }

  function renderChapterTable(chapters) {
    const tbody = document.getElementById("chapter-rows");
    tbody.innerHTML = "";

    const q = state.chapterSearch.trim().toLowerCase();
    const filtered = chapters.filter((ch) => {
      if (state.chapterFilterClass !== "all" && ch.classification !== state.chapterFilterClass) {
        return false;
      }
      if (!q) return true;
      return (
        (ch.title || "").toLowerCase().includes(q) ||
        (ch.synopsis || "").toLowerCase().includes(q) ||
        (ch.text || "").toLowerCase().includes(q)
      );
    });

    const isFiltered = Boolean(q) || state.chapterFilterClass !== "all";

    filtered.forEach((ch, idx) => {
      const words = Engine.countWords(ch.text);
      const statusKey = STATUS_LABELS[ch.status] ? ch.status : "drafting";
      const clsKey = CLASSIFICATION_LABELS[ch.classification] ? ch.classification : "unclassified";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="col-index">${idx + 1}</td>
        <td>
          <div class="chapter-cell-title">${escapeHtml(ch.title)}</div>
          ${ch.synopsis ? `<div class="chapter-cell-synopsis">${escapeHtml(ch.synopsis)}</div>` : ""}
        </td>
        <td><span class="status-pill status-pill-${statusKey}">${STATUS_LABELS[statusKey]}</span></td>
        <td><span class="stamp stamp-${clsKey}">${CLASSIFICATION_LABELS[clsKey]}</span></td>
        <td class="num mono">${words.toLocaleString()}</td>
        <td class="mono">${formatTimestamp(ch.updated_at)}</td>
        <td class="col-actions">
          <div class="row-action-group">
            <button type="button" class="icon-btn move-chapter-btn" data-dir="up" data-chapter-id="${ch.id}" title="Move up" ${isFiltered || idx === 0 ? "disabled" : ""}>&uarr;</button>
            <button type="button" class="icon-btn move-chapter-btn" data-dir="down" data-chapter-id="${ch.id}" title="Move down" ${isFiltered || idx === filtered.length - 1 ? "disabled" : ""}>&darr;</button>
            <button type="button" class="btn btn-ghost btn-compact delete-chapter-btn" data-chapter-id="${ch.id}">Delete</button>
          </div>
        </td>
      `;

      tr.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        openChapter(ch.id);
      });
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".move-chapter-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await Data.reorderChapter(Number(btn.dataset.chapterId), btn.dataset.dir);
        await openBook(state.activeBookId);
      });
    });

    tbody.querySelectorAll(".delete-chapter-btn").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this chapter? (The audit trail keeps a record even after deletion.)")) return;
        await Data.deleteChapter(Number(btn.dataset.chapterId));
        await refreshBookList();
        await openBook(state.activeBookId);
      });
    });

    document.getElementById("new-chapter-form").onsubmit = async (e) => {
      e.preventDefault();
      const input = document.getElementById("new-chapter-title");
      const title = input.value.trim();
      if (!title) return;
      await Data.createChapter(state.activeBookId, { title });
      input.value = "";
      await refreshBookList();
      await openBook(state.activeBookId);
    };
  }

  async function onDeleteBook() {
    if (!state.activeBookId) return;
    if (!confirm("Delete this whole book? Its chapters go with it — the audit log stays.")) return;
    await Data.deleteBook(state.activeBookId);
    state.activeBookId = null;
    state.activeBook = null;
    hide("book-view");
    show("empty-desk");
    await refreshBookList();
  }

  // ------------------------------------------------ Chapter Studio View --

  async function openChapter(chapterId) {
    await flushPendingAutosave();
    setWorkspaceLocation("Writing studio", "nav-write-btn");
    state.activeChapterId = Number(chapterId);

    // Ensure state.activeBook has latest chapter list for Prev/Next navigation
    if (state.activeBookId) {
      state.activeBook = await Data.getBook(state.activeBookId);
    }
    const chapter = await Data.getChapter(state.activeChapterId);
    state.activeChapter = chapter;
    state.dirtyText = false;
    state.findCursor = 0;

    hide("book-view");
    hide("chapter-meta-panel");
    hide("find-replace-bar");
    show("chapter-view");

    renderActiveChapterMeta(chapter);

    const editor = document.getElementById("chapter-text");
    editor.value = chapter.text || "";
    state.lastEditorWordCount = Engine.countWords(editor.value);
    updateLiveWritingStats(editor.value);

    document.getElementById("classify-note").value = chapter.classification_note || "";
    document.getElementById("save-status").textContent = "All changes saved";
    document.getElementById("pattern-results").innerHTML = "";
    document.getElementById("feedback-results").innerHTML = "";
    document.getElementById("line-edit-results").innerHTML = "";
    document.getElementById("line-edit-summary").textContent = "Run the scan to see what a pencil would circle.";
    state.lintResult = null;
    stopReading({ silent: true });

    updateStampButtons(chapter.classification || "unclassified");
    updateChapterNavButtons();
  }

  function renderActiveChapterMeta(chapter) {
    document.getElementById("chapter-title").textContent = chapter.title;
    const synEl = document.getElementById("chapter-synopsis-preview");
    if (chapter.synopsis) {
      synEl.textContent = chapter.synopsis;
      synEl.hidden = false;
    } else {
      synEl.hidden = true;
    }
    document.getElementById("chapter-status-select").value = chapter.status || "drafting";

    if (state.activeBook) {
      const chapters = state.activeBook.chapters || [];
      const idx = chapters.findIndex((c) => c.id === chapter.id);
      const posText = idx >= 0 ? `Chapter ${idx + 1} of ${chapters.length}` : "";
      document.getElementById("chapter-breadcrumb").textContent =
        `${state.activeBook.title}${posText ? " · " + posText : ""}`;
    }
  }

  function updateChapterNavButtons() {
    const chapters = state.activeBook?.chapters || [];
    const idx = chapters.findIndex((c) => c.id === state.activeChapterId);
    document.getElementById("prev-chapter-btn").disabled = idx <= 0;
    document.getElementById("next-chapter-btn").disabled = idx === -1 || idx >= chapters.length - 1;
  }

  async function navigateSiblingChapter(delta) {
    const chapters = state.activeBook?.chapters || [];
    const idx = chapters.findIndex((c) => c.id === state.activeChapterId);
    const target = chapters[idx + delta];
    if (target) {
      await openChapter(target.id);
    }
  }

  function updateLiveWritingStats(text) {
    const words = Engine.countWords(text);
    const chars = String(text || "").length;
    const paras = Engine.countParagraphs(text);
    const mins = Engine.estimateReadingMinutes(words);

    document.getElementById("live-word-count").textContent = words.toLocaleString();
    document.getElementById("live-char-count").textContent = chars.toLocaleString();
    document.getElementById("live-para-count").textContent = paras.toLocaleString();
    document.getElementById("live-read-time").textContent = words > 0 ? `~${mins} min read` : "0 min read";
  }

  function onEditorInput() {
    const text = document.getElementById("chapter-text").value;
    updateLiveWritingStats(text);
    const count = Engine.countWords(text);
    const daily = getDailyProgress();
    recordDailyWords(Math.max(0, daily.words + count - (state.lastEditorWordCount || 0)));
    state.lastEditorWordCount = count;
    renderDailyGoal();
    state.dirtyText = true;

    if (state.mode === "browser" && state.activeChapterId) {
      // Immediate synchronous mirror write so even sudden tab close preserves every word
      state.store.updateChapterTextSync(state.activeChapterId, text);
    }

    document.getElementById("save-status").textContent = "Saving…";
    setSavingBadge(true, "Autosaving…");

    if (state.autosaveTimer) clearTimeout(state.autosaveTimer);
    state.autosaveTimer = setTimeout(() => {
      onSaveText({ explicit: false });
    }, 650);
  }

  async function flushPendingAutosave() {
    if (state.autosaveTimer) {
      clearTimeout(state.autosaveTimer);
      state.autosaveTimer = null;
    }
    if (state.dirtyText && state.activeChapterId) {
      const text = document.getElementById("chapter-text").value;
      await Data.updateChapterText(state.activeChapterId, text, { logAudit: true });
      state.dirtyText = false;
      setSavingBadge(false);
    }
  }

  async function onSaveText({ explicit = true } = {}) {
    if (!state.activeChapterId) return;
    if (state.autosaveTimer) {
      clearTimeout(state.autosaveTimer);
      state.autosaveTimer = null;
    }
    const text = document.getElementById("chapter-text").value;
    const updated = await Data.updateChapterText(state.activeChapterId, text, {
      logAudit: explicit,
    });
    state.activeChapter = updated;
    state.dirtyText = false;
    setSavingBadge(false);

    const status = document.getElementById("save-status");
    status.textContent = explicit ? "Saved." : "Auto-saved";
    await refreshBookList();
  }

  // ----------------------------------------- Writer Formatting & Find --

  function onEditorKeydown(e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
      e.preventDefault();
      applyEditorInsert("bold");
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
      e.preventDefault();
      applyEditorInsert("italic");
    } else if (e.key === "Tab") {
      e.preventDefault();
      insertAroundSelection("    ", "");
    }
  }

  function insertAroundSelection(prefix, suffix, placeholder = "") {
    const editor = document.getElementById("chapter-text");
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    const val = editor.value;
    const selected = val.slice(start, end) || placeholder;
    const replacement = `${prefix}${selected}${suffix}`;
    editor.value = val.slice(0, start) + replacement + val.slice(end);
    editor.focus();
    const cursorStart = start + prefix.length;
    const cursorEnd = cursorStart + selected.length;
    editor.setSelectionRange(cursorStart, cursorEnd);
    onEditorInput();
  }

  function applyEditorInsert(kind) {
    if (kind === "bold") insertAroundSelection("**", "**", "bold text");
    else if (kind === "italic") insertAroundSelection("*", "*", "italic text");
    else if (kind === "heading") insertAroundSelection("\n## ", "\n", "Scene heading");
    else if (kind === "quote") insertAroundSelection("\n> ", "\n", "Quoted line");
    else if (kind === "emdash") insertAroundSelection("—", "");
    else if (kind === "scenebreak") insertAroundSelection("\n\n* * *\n\n", "");
  }

  function updateFindCount() {
    const query = document.getElementById("find-input").value;
    const countEl = document.getElementById("find-count");
    if (!query) {
      countEl.textContent = "";
      return;
    }
    const text = document.getElementById("chapter-text").value.toLowerCase();
    const q = query.toLowerCase();
    let count = 0;
    let pos = 0;
    while (true) {
      const idx = text.indexOf(q, pos);
      if (idx === -1) break;
      count += 1;
      pos = idx + q.length;
    }
    countEl.textContent = `${count} match${count === 1 ? "" : "es"}`;
  }

  function findNextInEditor() {
    const query = document.getElementById("find-input").value;
    if (!query) return;
    const editor = document.getElementById("chapter-text");
    const hay = editor.value.toLowerCase();
    const needle = query.toLowerCase();
    let idx = hay.indexOf(needle, state.findCursor);
    if (idx === -1 && state.findCursor > 0) {
      idx = hay.indexOf(needle, 0);
    }
    if (idx !== -1) {
      editor.focus();
      editor.setSelectionRange(idx, idx + query.length);
      state.findCursor = idx + query.length;
    }
    updateFindCount();
  }

  function replaceAllInEditor() {
    const findVal = document.getElementById("find-input").value;
    const replaceVal = document.getElementById("replace-input").value;
    if (!findVal) return;
    const editor = document.getElementById("chapter-text");
    const parts = editor.value.split(findVal);
    const replacements = parts.length - 1;
    if (replacements <= 0) return;
    editor.value = parts.join(replaceVal);
    onEditorInput();
    document.getElementById("find-count").textContent = `Replaced ${replacements}`;
  }

  function toggleFocusMode() {
    const active = document.body.classList.toggle("focus-mode");
    document.getElementById("focus-mode-btn").textContent = active ? "Exit focus" : "Focus mode";
  }

  function exitFocusMode() {
    document.body.classList.remove("focus-mode");
    document.getElementById("focus-mode-btn").textContent = "Focus mode";
  }

  // ---------------------------------------------------- Snapshots UI --

  async function openSnapshotsModal() {
    await flushPendingAutosave();
    await renderSnapshotsList();
    show("snapshots-modal");
  }

  async function renderSnapshotsList() {
    const snapshots = await Data.listSnapshots(state.activeChapterId);
    const list = document.getElementById("snapshots-list");
    if (!snapshots.length) {
      list.innerHTML = '<li class="muted-note">No saved snapshots for this chapter yet.</li>';
      return;
    }
    list.innerHTML = "";
    for (const snap of snapshots) {
      const li = document.createElement("li");
      const info = document.createElement("div");
      info.innerHTML = `
        <strong>${escapeHtml(snap.label)}</strong>
        <span class="audit-time">${formatTimestamp(snap.created_at)} &middot; ${(snap.word_count || 0).toLocaleString()} words</span>
      `;
      const restoreBtn = document.createElement("button");
      restoreBtn.type = "button";
      restoreBtn.className = "btn btn-ghost btn-compact";
      restoreBtn.textContent = "Restore this draft";
      restoreBtn.addEventListener("click", async () => {
        if (!confirm(`Restore '${snap.label}'? Your current text will first be saved as an automatic checkpoint.`)) return;
        await Data.createSnapshot(state.activeChapterId, "Auto-backup before restore");
        const restored = await Data.restoreSnapshot(snap.id);
        state.activeChapter = restored;
        document.getElementById("chapter-text").value = restored.text || "";
        updateLiveWritingStats(restored.text || "");
        document.getElementById("save-status").textContent = "Snapshot restored.";
        hide("snapshots-modal");
        await refreshBookList();
      });
      li.appendChild(info);
      li.appendChild(restoreBtn);
      list.appendChild(li);
    }
  }

  // ----------------------------------------- Classify, Pattern, Craft --

  function updateStampButtons(selectedValue) {
    document.querySelectorAll(".stamp-choice").forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.value === selectedValue);
    });
  }

  async function onClassify(value) {
    await flushPendingAutosave();
    const note = document.getElementById("classify-note").value;
    const updated = await Data.classifyChapter(state.activeChapterId, value, note);
    state.activeChapter = updated;
    updateStampButtons(value);
    const status = document.getElementById("save-status");
    status.textContent = `Stamped: ${CLASSIFICATION_LABELS[value]}`;
  }

  async function onRunPattern() {
    await flushPendingAutosave();
    const results = document.getElementById("pattern-results");
    results.innerHTML = '<p class="muted-note">Running…</p>';
    const currentText = document.getElementById("chapter-text").value;
    const report = await Data.runPatternAnalysis(state.activeChapterId, currentText);

    const stats = [
      ["Words", report.word_count],
      ["Sentences", report.sentence_count],
      ["Avg sentence length", report.avg_sentence_length],
      ["Sentence rhythm (burstiness)", report.burstiness ?? "n/a"],
      ["Word variety", report.lexical_diversity],
      ["Em dashes / 1000 words", report.em_dash_per_1000_words],
      ["Repeated 3-word phrases", `${Math.round(report.repeated_trigram_rate * 100)}%`],
    ];

    let html = '<div class="pattern-stats">';
    for (const [label, value] of stats) {
      html += `<div class="pattern-stat"><div class="label">${label}</div><div class="value">${value}</div></div>`;
    }
    html += "</div>";

    if (report.flagged_phrases.length) {
      html +=
        "<div>" +
        report.flagged_phrases
          .map((f) => `<span class="flagged-phrase">"${escapeHtml(f.phrase)}" &times;${f.count}</span>`)
          .join("") +
        "</div>";
    }

    html +=
      '<ul class="pattern-notes">' +
      report.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("") +
      "</ul>";
    results.innerHTML = html;
  }

  async function onRunLocalCraft() {
    await flushPendingAutosave();
    const text = document.getElementById("chapter-text").value;
    const craft = Engine.analyzeCraft(text);
    const results = document.getElementById("feedback-results");

    if (!craft.bullets.length) {
      results.innerHTML = `<p class="muted-note">${escapeHtml(craft.summary)}</p>`;
      return;
    }

    results.innerHTML = `
      <div class="craft-card">
        <div class="craft-card-header">${escapeHtml(craft.summary)}</div>
        <ul class="pattern-notes">
          ${craft.bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}
        </ul>
      </div>
    `;
  }

  async function onRunFeedback() {
    await flushPendingAutosave();
    const results = document.getElementById("feedback-results");
    results.innerHTML = '<p class="muted-note">Asking Claude…</p>';

    if (state.mode === "server") {
      const data = await api(`/api/chapters/${state.activeChapterId}/feedback`, { method: "POST" });
      if (data.feedback) {
        results.innerHTML = `<div class="feedback-text">${escapeHtml(data.feedback)}</div>`;
      } else {
        results.innerHTML = `<p class="muted-note">${escapeHtml(data.message || "No feedback available.")}</p>`;
      }
      return;
    }

    const text = document.getElementById("chapter-text").value.trim();
    if (!text) {
      results.innerHTML = '<p class="muted-note">Write or paste chapter text first before requesting feedback.</p>';
      return;
    }

    const prefs = state.store.getPrefs();
    if (!prefs.anthropicApiKey) {
      results.innerHTML =
        '<p class="muted-note">Live Claude feedback is optional — click "Claude features: off (optional)" in the top right to add your own API key, or click "Instant craft check" right above for immediate offline pacing &amp; rhythm notes.</p>';
      return;
    }

    try {
      const excerpt = text.slice(0, 6000);
      const prompt =
        "You are a supportive, direct writing coach. Read the excerpt below and give " +
        "3-5 short bullet points of craft feedback: things like pacing, voice " +
        "consistency, repetitive phrasing, or sentence-rhythm variety. Do not comment " +
        "on whether the text seems AI-written or not — that's not your job here, only " +
        "the craft.\n\n" +
        `--- Excerpt ---\n${excerpt}\n--- End excerpt ---`;
      const feedback = await Engine.callClaudeBrowser({
        apiKey: prefs.anthropicApiKey,
        prompt,
        maxTokens: 500,
      });
      results.innerHTML = feedback
        ? `<div class="feedback-text">${escapeHtml(feedback)}</div>`
        : '<p class="muted-note">No feedback returned.</p>';
    } catch (err) {
      results.innerHTML = `<p class="muted-note">${escapeHtml(err.message || "Could not reach Claude API.")}</p>`;
    }
  }

  // -------------------------------------------------------- Audit Log --

  async function openAuditModal() {
    document.getElementById("audit-modal-title").textContent = "Audit trail";
    const auditLog = await Data.getAuditLog(state.activeBookId);
    renderAuditEntries(auditLog, false);
    show("audit-modal");
  }

  async function openGlobalAuditModal() {
    await flushPendingAutosave();
    document.getElementById("audit-modal-title").textContent = "All-books ledger history";
    const auditLog = await Data.getGlobalAuditLog();
    renderAuditEntries(auditLog, true);
    show("audit-modal");
  }

  function renderAuditEntries(auditLog, showBookTitle) {
    const list = document.getElementById("audit-list");
    if (!auditLog.length) {
      list.innerHTML = '<li class="muted-note">No ledger events recorded yet.</li>';
      return;
    }
    list.innerHTML = auditLog
      .slice()
      .reverse()
      .map((entry) => {
        const bookPrefix = showBookTitle && entry.book_title ? `[${escapeHtml(entry.book_title)}] ` : "";
        const wcSuffix = entry.word_count !== null && entry.word_count !== undefined
          ? ` (${Number(entry.word_count).toLocaleString()}w)`
          : "";
        return `
          <li>
            <span class="audit-time">${formatTimestamp(entry.timestamp)} &middot; ${escapeHtml(entry.event_type)}${wcSuffix}</span>
            ${bookPrefix}${escapeHtml(entry.chapter_title || "")} ${escapeHtml(entry.detail)}
          </li>
        `;
      })
      .join("");
  }

  // ----------------------------------------- Reports & Manuscript Out --

  async function openReportModal() {
    const report = await Data.getReport(state.activeBookId);
    state.lastReport = report;
    state.lastReportMarkdown = Engine.reportToMarkdown(report);

    const rows = Object.entries(report.word_counts_by_classification)
      .filter(([, words]) => words > 0)
      .map(
        ([key, words]) => `
        <tr>
          <td>${escapeHtml(Engine.CLASSIFICATION_LABELS[key] || key)}</td>
          <td>${words.toLocaleString()}</td>
          <td>${report.percentages_by_classification[key]}%</td>
        </tr>
      `
      )
      .join("");

    const chapterBreakdown = (report.chapters || [])
      .map(
        (ch) => `
        <tr>
          <td>${escapeHtml(ch.title)}</td>
          <td>${escapeHtml(ch.classification_label || CLASSIFICATION_LABELS[ch.classification] || ch.classification)}</td>
          <td>${(ch.word_count || 0).toLocaleString()}</td>
          <td>${escapeHtml(ch.note || "")}</td>
        </tr>
      `
      )
      .join("");

    document.getElementById("report-body").innerHTML = `
      <h3>Suggested disclosure note</h3>
      <p>${escapeHtml(report.suggested_disclosure)}</p>
      ${report.narrative_summary ? `<h3>Claude's plain-English summary</h3><p>${escapeHtml(report.narrative_summary)}</p>` : ""}
      <h3>Word counts</h3>
      <table>
        <thead><tr><th>Classification</th><th>Words</th><th>%</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3">No words logged yet.</td></tr>'}</tbody>
      </table>
      ${
        chapterBreakdown
          ? `<h3>Chapter breakdown</h3>
             <table>
               <thead><tr><th>Chapter</th><th>Classification</th><th>Words</th><th>Note</th></tr></thead>
               <tbody>${chapterBreakdown}</tbody>
             </table>`
          : ""
      }
      <p class="muted-note">${escapeHtml(report.disclaimer)}</p>
    `;
    show("report-modal");
  }

  async function downloadReport() {
    if (state.mode === "browser" && state.activeBookId) {
      await state.store.logCustomEvent(
        state.activeBookId,
        "report_exported",
        "Compliance report downloaded as Markdown."
      );
    }
    const slug = (state.activeBook?.title || "book").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    downloadBlob(state.lastReportMarkdown, "text/markdown", `${slug}-ai-disclosure-report.md`);
  }

  async function copyDisclosureNote() {
    if (!state.lastReport) return;
    const btn = document.getElementById("copy-disclosure-btn");
    try {
      await navigator.clipboard.writeText(state.lastReport.suggested_disclosure);
      btn.textContent = "Copied!";
      setTimeout(() => (btn.textContent = "Copy disclosure note"), 1800);
    } catch {
      btn.textContent = "Select text above to copy";
    }
  }

  async function exportCompiledManuscript(format) {
    if (!state.activeBookId) return;
    const book = await Data.getBook(state.activeBookId);
    const content = Engine.compileManuscript(book, book.chapters || [], format);
    const slug = (book.title || "manuscript").replace(/[^a-z0-9]+/gi, "-").toLowerCase();

    const extMap = { markdown: "md", txt: "txt", html: "html" };
    const mimeMap = {
      markdown: "text/markdown",
      txt: "text/plain",
      html: "text/html",
    };

    if (state.mode === "browser") {
      await state.store.logCustomEvent(
        book.id,
        "manuscript_exported",
        `Compiled manuscript downloaded as .${extMap[format] || "md"}.`
      );
    }
    downloadBlob(content, mimeMap[format] || "text/plain", `${slug}.${extMap[format] || "md"}`);
    hide("manuscript-modal");
  }

  // ------------------------------------------- Manuscript Health UI --

  function renderManuscriptHealth(book) {
    const health = Engine.computeManuscriptHealth(book.chapters || []);
    const badge = document.getElementById("health-badge");
    const allStamped = health.chapter_count > 0 && health.unclassified_chapter_count === 0;

    if (!health.chapter_count) {
      badge.textContent = "No chapters yet";
    } else if (allStamped) {
      badge.textContent = "Report ready";
    } else {
      badge.textContent = `${health.unclassified_chapter_count} unstamped`;
    }
    badge.classList.toggle("is-warning", health.chapter_count > 0 && !allStamped);

    document.getElementById("health-next-step").textContent = health.next_step;

    const chart = document.getElementById("chapter-pace-chart");
    chart.innerHTML = "";
    chart.classList.toggle("is-empty", health.chapter_count === 0);
    if (!health.chapter_count) {
      chart.textContent = "Add a chapter and the shape of your book will appear here.";
    } else {
      const max = Math.max(1, ...health.distribution.map((chapter) => chapter.words));
      const outlierIds = new Set(
        [...health.thin_chapters, ...health.bloated_chapters].map((chapter) => chapter.id)
      );
      for (const chapter of health.distribution) {
        const bar = document.createElement("button");
        bar.type = "button";
        bar.className = "pace-bar";
        if (!chapter.words) bar.classList.add("is-empty");
        if (outlierIds.has(chapter.id)) bar.classList.add("is-outlier");
        bar.title = `${chapter.title} · ${chapter.words.toLocaleString()} words`;
        bar.setAttribute("aria-label", `Open ${chapter.title} — ${chapter.words} words`);
        bar.addEventListener("click", () => openChapter(chapter.id));

        const fill = document.createElement("span");
        fill.className = "pace-bar-fill";
        fill.style.height = `${Math.max(3, Math.round((chapter.words / max) * 100))}%`;
        bar.appendChild(fill);
        chart.appendChild(bar);
      }
    }

    const notes = document.getElementById("health-notes");
    notes.innerHTML = "";
    for (const note of health.notes) {
      const li = document.createElement("li");
      li.textContent = note;
      notes.appendChild(li);
    }
  }

  // ----------------------------------------------- Story Bible (UI) --

  async function refreshActiveBook() {
    if (!state.activeBookId) return null;
    state.activeBook = await Data.getBook(state.activeBookId);
    return state.activeBook;
  }

  function renderBibleSection(book) {
    const entries = (book && book.bible) || [];
    const grid = document.getElementById("bible-grid");
    const empty = document.getElementById("bible-empty");
    const query = document.getElementById("bible-search").value.trim().toLowerCase();
    const kind = document.getElementById("bible-filter").value;

    const filtered = entries.filter((entry) => {
      if (kind !== "all" && entry.kind !== kind) return false;
      if (!query) return true;
      return `${entry.name} ${entry.description} ${entry.tags}`.toLowerCase().includes(query);
    });

    grid.innerHTML = "";
    empty.hidden = entries.length > 0;

    if (!filtered.length) {
      if (entries.length) {
        const note = document.createElement("p");
        note.className = "bible-grid-empty";
        note.textContent = "No entries match that search yet.";
        grid.appendChild(note);
      }
      return;
    }

    for (const entry of filtered) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "bible-card";
      card.addEventListener("click", () => openBibleModal({ mode: "manage", entryId: entry.id }));

      const chip = document.createElement("span");
      chip.className = "bible-kind-chip";
      chip.dataset.kind = entry.kind;
      chip.textContent = Engine.BIBLE_KIND_LABELS[entry.kind] || "Note";
      card.appendChild(chip);

      const name = document.createElement("span");
      name.className = "bible-card-name";
      name.textContent = entry.name;
      card.appendChild(name);

      if (entry.description) {
        const desc = document.createElement("span");
        desc.className = "bible-card-desc";
        desc.textContent = entry.description;
        card.appendChild(desc);
      }
      if (entry.tags) {
        const tags = document.createElement("span");
        tags.className = "bible-card-tags";
        tags.textContent = entry.tags;
        card.appendChild(tags);
      }
      grid.appendChild(card);
    }
  }

  function setBibleModalMode(mode) {
    state.bibleModalMode = mode;
    const list = document.getElementById("bible-modal-list");
    const form = document.getElementById("bible-form");
    const actions = document.getElementById("bible-picker-actions");
    const hint = document.getElementById("bible-list-hint");
    const newBtn = document.getElementById("bible-new-entry-btn");
    const title = document.getElementById("bible-modal-title");
    const note = document.getElementById("bible-modal-note");

    list.hidden = mode === "edit";
    form.hidden = mode !== "edit";
    actions.hidden = mode === "edit";

    if (mode === "pick") {
      title.textContent = "Story bible — insert a name";
      note.textContent = "Click an entry to insert its name at your cursor, so spellings never drift mid-draft.";
      newBtn.hidden = true;
      hint.hidden = true;
    } else {
      title.textContent = "Story bible";
      note.textContent = "Characters, places, lore and plot beats for this book. Craft notes only — they never enter the compliance ledger.";
      newBtn.hidden = false;
      hint.hidden = false;
      hint.textContent = "Pick any entry to edit it.";
    }
  }

  function renderBibleModalList() {
    const list = document.getElementById("bible-modal-list");
    list.innerHTML = "";
    const entries = (state.activeBook && state.activeBook.bible) || [];

    if (!entries.length) {
      const note = document.createElement("p");
      note.className = "bible-grid-empty";
      note.textContent = "Nothing here yet. Start with your protagonist, the place they can’t leave, and the rule of the world that will cause trouble.";
      list.appendChild(note);
      return;
    }

    for (const entry of entries) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "bible-list-item";
      item.title = state.bibleModalMode === "pick"
        ? `Insert “${entry.name}” at your cursor`
        : `Edit “${entry.name}”`;

      const chip = document.createElement("span");
      chip.className = "bible-kind-chip";
      chip.dataset.kind = entry.kind;
      chip.textContent = Engine.BIBLE_KIND_LABELS[entry.kind] || "Note";
      item.appendChild(chip);

      const name = document.createElement("span");
      name.className = "bible-list-name";
      name.textContent = entry.name;
      item.appendChild(name);

      if (entry.description) {
        const desc = document.createElement("span");
        desc.className = "bible-list-desc";
        desc.textContent = entry.description;
        item.appendChild(desc);
      }

      item.addEventListener("click", () => {
        if (state.bibleModalMode === "pick") {
          insertTextAtCursor(entry.name);
          hide("bible-modal");
        } else {
          openBibleForm(entry);
        }
      });
      list.appendChild(item);
    }
  }

  async function openBibleModal({ mode = "manage", entryId = null } = {}) {
    await flushPendingAutosave();
    if (!state.activeBookId) {
      alert("Open a manuscript first — the story bible belongs to a book.");
      return;
    }
    if (!state.activeBook || state.activeBook.id !== state.activeBookId || !Array.isArray(state.activeBook.bible)) {
      await refreshActiveBook();
    }
    setBibleModalMode(mode);
    renderBibleModalList();
    if (entryId !== null) {
      const entry = (state.activeBook.bible || []).find((item) => item.id === Number(entryId));
      if (entry) openBibleForm(entry);
    }
    show("bible-modal");
  }

  function openBibleForm(entry = null) {
    setBibleModalMode("edit");
    const filterKind = document.getElementById("bible-filter").value;
    document.getElementById("bible-entry-id").value = entry ? String(entry.id) : "";
    document.getElementById("bible-kind").value = entry
      ? entry.kind
      : filterKind !== "all" ? filterKind : "character";
    document.getElementById("bible-name").value = entry ? entry.name : "";
    document.getElementById("bible-description").value = entry ? entry.description : "";
    document.getElementById("bible-tags").value = entry ? entry.tags : "";
    document.getElementById("bible-delete-btn").hidden = !entry;
    document.getElementById("bible-modal-title").textContent = entry
      ? `Edit — ${entry.name}`
      : "New story-bible entry";
    document.getElementById("bible-modal-note").textContent = entry
      ? "Changes stay with this book and travel inside your JSON backup."
      : "A name, what they want, and what they’re hiding is usually enough to start.";
    document.getElementById("bible-name").focus();
  }

  function exportStoryBible() {
    const book = state.activeBook;
    const entries = (book && book.bible) || [];
    if (!entries.length) {
      alert("There’s nothing in this story bible to export yet.");
      return;
    }
    const lines = [`# ${book.title} — Story Bible`, ""];
    let currentKind = null;
    for (const entry of entries) {
      if (entry.kind !== currentKind) {
        currentKind = entry.kind;
        lines.push("", `## ${Engine.BIBLE_KIND_LABELS[currentKind] || "Notes"}`, "");
      }
      lines.push(`### ${entry.name}`, "");
      if (entry.description) lines.push(entry.description, "");
      if (entry.tags) lines.push(`*Tags: ${entry.tags}*`, "");
    }
    lines.push("", "---", "", `Exported from AuthorLedger on ${new Date().toLocaleDateString()}.`);
    const slug = (book.title || "book").replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "");
    downloadBlob(lines.join("\n"), "text/markdown", `${slug || "book"}-story-bible.md`);
  }

  async function saveBibleEntry(e) {
    e.preventDefault();
    if (!state.activeBookId) return;
    const entryId = document.getElementById("bible-entry-id").value;
    const payload = {
      kind: document.getElementById("bible-kind").value,
      name: document.getElementById("bible-name").value.trim(),
      description: document.getElementById("bible-description").value,
      tags: document.getElementById("bible-tags").value,
    };
    if (!payload.name) {
      document.getElementById("bible-name").focus();
      return;
    }
    if (entryId) payload.id = Number(entryId);

    try {
      await Data.saveBibleEntry(state.activeBookId, payload);
    } catch (err) {
      alert(err.message || "Could not save that story-bible entry.");
      return;
    }
    await refreshActiveBook();
    if (!entryId) {
      document.getElementById("bible-search").value = "";
      document.getElementById("bible-filter").value = "all";
    }
    renderBibleSection(state.activeBook);
    setBibleModalMode("manage");
    renderBibleModalList();
  }

  async function deleteBibleEntryFromForm() {
    const entryId = Number(document.getElementById("bible-entry-id").value);
    if (!entryId || !state.activeBookId) return;
    if (!confirm("Delete this story-bible entry? Chapter text is untouched.")) return;
    try {
      await Data.deleteBibleEntry(state.activeBookId, entryId);
    } catch (err) {
      alert(err.message || "Could not delete that entry.");
      return;
    }
    await refreshActiveBook();
    renderBibleSection(state.activeBook);
    setBibleModalMode("manage");
    renderBibleModalList();
  }

  function insertTextAtCursor(text) {
    const editor = document.getElementById("chapter-text");
    if (!editor) return;
    const start = editor.selectionStart ?? editor.value.length;
    const end = editor.selectionEnd ?? start;
    editor.value = editor.value.slice(0, start) + text + editor.value.slice(end);
    const caret = start + text.length;
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(caret, caret);
    onEditorInput();
  }

  // ------------------------------------------------------ Line Edit UI --

  function runLineEdit() {
    // Results live below the editor, so leaving focus mode keeps them visible.
    exitFocusMode();
    const text = document.getElementById("chapter-text").value;
    state.lintResult = Engine.lintProse(text);
    renderLineEdit(state.lintResult);
    document.getElementById("line-edit-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function highlightMatch(snippet, match) {
    const html = escapeHtml(snippet || "");
    const needle = String(match || "");
    if (!needle) return html;
    const at = html.toLowerCase().indexOf(escapeHtml(needle).toLowerCase());
    if (at === -1) return html;
    const length = escapeHtml(needle).length;
    return `${html.slice(0, at)}<mark>${html.slice(at, at + length)}</mark>${html.slice(at + length)}`;
  }

  function buildLintCategory(category) {
    const wrap = document.createElement("div");
    wrap.className = "lint-category";

    const head = document.createElement("div");
    head.className = "lint-category-head";
    const title = document.createElement("span");
    title.className = "lint-category-title";
    title.textContent = category.label;
    const count = document.createElement("span");
    count.className = "lint-count";
    count.textContent = `${category.count}${category.capped ? "+" : ""}`;
    head.appendChild(title);
    head.appendChild(count);
    wrap.appendChild(head);

    const note = document.createElement("p");
    note.className = "lint-note";
    note.textContent = category.note;
    wrap.appendChild(note);

    if (category.key === "adverbs" && category.rate_per_1000 !== undefined) {
      const rate = document.createElement("p");
      rate.className = "lint-note";
      rate.textContent = `${category.rate_per_1000} -ly words per 1,000 words.`;
      wrap.appendChild(rate);
    }

    const list = document.createElement("ul");
    list.className = "lint-examples";
    for (const example of category.examples) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lint-example";

      const context = document.createElement("span");
      context.innerHTML = highlightMatch(example.context || example.match, example.match);
      button.appendChild(context);

      if (category.key === "repeated_openers" && example.count) {
        const meta = document.createElement("span");
        meta.className = "lint-example-context";
        meta.textContent = `${example.count} sentences begin this way`;
        button.appendChild(meta);
      }

      if (typeof example.index === "number" && example.index >= 0) {
        button.addEventListener("click", () => jumpToEditorIndex(example.index, example.match));
      } else {
        button.disabled = true;
      }
      li.appendChild(button);
      list.appendChild(li);
    }
    wrap.appendChild(list);
    return wrap;
  }

  function renderLineEdit(result) {
    const summary = document.getElementById("line-edit-summary");
    const results = document.getElementById("line-edit-results");
    results.innerHTML = "";
    summary.textContent = result.summary;

    if (!result.categories.length) return;

    const flagged = result.categories.filter((category) => category.count > 0);
    const clean = result.categories.filter((category) => category.count === 0);

    if (!flagged.length) {
      const note = document.createElement("p");
      note.className = "lint-clean-note";
      note.textContent = "Nothing on this checklist needs a second look — a genuinely clean pass. Read it once more for the things only you can hear.";
      results.appendChild(note);
    } else {
      for (const category of flagged) results.appendChild(buildLintCategory(category));
    }

    if (clean.length) {
      const note = document.createElement("p");
      note.className = "lint-clean-note";
      note.textContent = `Clear in this pass: ${clean.map((category) => category.label).join(", ")}.`;
      results.appendChild(note);
    }
  }

  function jumpToEditorIndex(index, match) {
    const editor = document.getElementById("chapter-text");
    const value = editor.value;
    const start = Math.max(0, Math.min(Number(index) || 0, value.length));
    const length = Math.max(0, Math.min(String(match || "").length, value.length - start));
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(start, start + length);
    const maxScroll = Math.max(0, editor.scrollHeight - editor.clientHeight);
    editor.scrollTop = value.length ? (start / value.length) * maxScroll : 0;
  }

  // ------------------------------------------------------ Read Aloud --

  function readAloudSupported() {
    return typeof window !== "undefined" &&
      "speechSynthesis" in window &&
      typeof window.SpeechSynthesisUtterance === "function";
  }

  function chunkForSpeech(text, maxLength = 240) {
    const pieces = String(text || "").match(/[^.!?\n]+[.!?]*/g) || [];
    const chunks = [];
    let buffer = "";
    for (const piece of pieces) {
      const clean = piece.replace(/\s+/g, " ").trim();
      if (!clean) continue;
      if (buffer && (buffer.length + clean.length + 1) > maxLength) {
        chunks.push(buffer);
        buffer = clean;
      } else {
        buffer = buffer ? `${buffer} ${clean}` : clean;
      }
    }
    if (buffer) chunks.push(buffer);
    return chunks;
  }

  function stopReading({ silent = false } = {}) {
    const reading = state.readAloud;
    reading.speaking = false;
    reading.paused = false;
    reading.chunks = [];
    reading.index = 0;
    reading.utterance = null;
    if (readAloudSupported()) window.speechSynthesis.cancel();
    const bar = document.getElementById("read-aloud-bar");
    if (bar) bar.classList.remove("is-reading");
    const toggle = document.getElementById("read-toggle-btn");
    if (toggle) toggle.textContent = "▷ Start reading";
    if (!silent) {
      document.getElementById("read-aloud-status").textContent =
        "Stopped. Your place in the draft is untouched.";
    }
  }

  function startReading() {
    if (!readAloudSupported()) {
      document.getElementById("read-aloud-status").textContent =
        "This browser doesn’t offer on-device speech. Chrome, Edge, and Safari do.";
      return;
    }
    const editor = document.getElementById("chapter-text");
    const from = Number(editor.selectionStart) || 0;
    const chunks = chunkForSpeech(editor.value.slice(from));
    if (!chunks.length) {
      document.getElementById("read-aloud-status").textContent =
        "There’s nothing after your cursor to read yet.";
      return;
    }
    stopReading({ silent: true });
    const reading = state.readAloud;
    reading.chunks = chunks;
    reading.index = 0;
    reading.speaking = true;
    reading.paused = false;
    document.getElementById("read-aloud-bar").classList.add("is-reading");
    document.getElementById("read-toggle-btn").textContent = "Ⅱ Pause";
    speakChunk();
  }

  function speakChunk() {
    const reading = state.readAloud;
    if (!reading.speaking) return;
    if (reading.index >= reading.chunks.length) {
      stopReading({ silent: true });
      document.getElementById("read-aloud-status").textContent =
        "Finished the chapter. Take a breath, then read it once on the page.";
      return;
    }

    const utterance = new SpeechSynthesisUtterance(reading.chunks[reading.index]);
    utterance.rate = Number(document.getElementById("read-rate-select").value) || 1;
    utterance.pitch = 1;
    utterance.onend = () => {
      if (!state.readAloud.speaking) return;
      state.readAloud.index += 1;
      speakChunk();
    };
    utterance.onerror = (event) => {
      if (event.error === "interrupted" || event.error === "canceled") return;
      stopReading({ silent: true });
      document.getElementById("read-aloud-status").textContent =
        "Speech stopped early — this device may not have a voice installed for on-device reading.";
    };
    reading.utterance = utterance;
    document.getElementById("read-aloud-status").textContent =
      `Reading… part ${reading.index + 1} of ${reading.chunks.length}.`;
    window.speechSynthesis.speak(utterance);
  }

  function toggleReading() {
    const reading = state.readAloud;
    if (!reading.speaking) {
      startReading();
      return;
    }
    if (reading.paused) {
      window.speechSynthesis.resume();
      reading.paused = false;
      document.getElementById("read-toggle-btn").textContent = "Ⅱ Pause";
      document.getElementById("read-aloud-status").textContent = "Reading…";
    } else {
      window.speechSynthesis.pause();
      reading.paused = true;
      document.getElementById("read-toggle-btn").textContent = "▷ Resume";
      document.getElementById("read-aloud-status").textContent = "Paused. Your place is kept.";
    }
  }

  // --------------------------------------------------- Typewriter Mode --

  function applyTypewriterMode(enabled) {
    state.typewriterMode = Boolean(enabled);
    document.body.classList.toggle("typewriter-mode", state.typewriterMode);
    const button = document.getElementById("typewriter-btn");
    if (button) button.setAttribute("aria-pressed", String(state.typewriterMode));
    if (state.typewriterMode) centerCaretInEditor();
  }

  function toggleTypewriterMode() {
    const next = !state.typewriterMode;
    state.store.savePrefs({ typewriterMode: next });
    applyTypewriterMode(next);
    document.getElementById("save-status").textContent = next
      ? "Typewriter mode on — the page stays still under your eyes."
      : "Typewriter mode off.";
  }

  function centerCaretInEditor() {
    if (!state.typewriterMode) return;
    const editor = document.getElementById("chapter-text");
    if (!editor || !editor.value) return;
    const style = getComputedStyle(editor);
    const lineHeight = parseFloat(style.lineHeight) || (parseFloat(style.fontSize) || 18) * 1.6;
    const fontSize = parseFloat(style.fontSize) || 18;
    const usableWidth = Math.max(120, editor.clientWidth - 56);
    const charsPerLine = Math.max(18, Math.floor(usableWidth / (fontSize * 0.52)));
    const before = editor.value.slice(0, editor.selectionStart || 0);
    let visualLines = 0;
    for (const line of before.split("\n")) {
      visualLines += Math.max(1, Math.ceil(line.length / charsPerLine));
    }
    const caretY = Math.max(0, visualLines - 1) * lineHeight;
    editor.scrollTop = Math.max(0, caretY - editor.clientHeight / 2 + lineHeight / 2);
  }

  // ---------------------------------------------------------- Helpers --

  function downloadBlob(content, mimeType, filename) {
    const blob = new Blob([content], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
  }

  function formatTimestamp(iso) {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return iso;
    }
  }

  boot();
})();
