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
      if (book.id === state.activeBookId) li.classList.add("active");

      const titleSpan = document.createElement("span");
      titleSpan.className = "book-item-title";
      titleSpan.textContent = book.title;

      const metaSpan = document.createElement("span");
      metaSpan.className = "book-item-meta";
      const chCount = book.chapter_count ?? 0;
      const wCount = book.word_count ?? 0;
      metaSpan.textContent = `${chCount} ch · ${wCount.toLocaleString()} words`;

      li.appendChild(titleSpan);
      li.appendChild(metaSpan);
      li.addEventListener("click", async () => {
        await flushPendingAutosave();
        openBook(book.id);
      });
      list.appendChild(li);
    }
  }

  // ----------------------------------------------------- Event Wiring --

  function wireStaticEvents() {
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
    document.getElementById("focus-new-book-btn").addEventListener("click", () => {
      document.getElementById("new-book-title").focus();
    });

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

    // Close modals or Focus Mode on Escape + clicking backdrop
    document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) backdrop.hidden = true;
      });
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        let closedModal = false;
        document.querySelectorAll(".modal-backdrop").forEach((m) => {
          if (!m.hidden) {
            m.hidden = true;
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
      if (state.dirtyText && state.activeChapterId && state.mode === "browser") {
        const text = document.getElementById("chapter-text").value;
        state.store.updateChapterTextSync(state.activeChapterId, text);
      }
    });
  }

  function hide(id) { document.getElementById(id).hidden = true; }
  function show(id) { document.getElementById(id).hidden = false; }

  // --------------------------------------------------------- Book View --

  async function openBook(bookId) {
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

    renderGoalStrip(book, book.chapters);
    renderTallyStrip(book.chapters);
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
    updateLiveWritingStats(editor.value);

    document.getElementById("classify-note").value = chapter.classification_note || "";
    document.getElementById("save-status").textContent = "All changes saved";
    document.getElementById("pattern-results").innerHTML = "";
    document.getElementById("feedback-results").innerHTML = "";

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
