/*
 * app.js — all of AuthorLedger's frontend behaviour.
 *
 * Deliberately plain JavaScript: no React, no bundler, no npm install.
 * Everything talks to the Python backend through fetch() calls to the
 * /api/... routes defined in authorledger/server.py. If you're new to
 * this style of app, the pattern to notice is:
 *
 *   1. call the API
 *   2. get JSON back
 *   3. build/replace a chunk of HTML with it
 *
 * ...over and over. That's most of what a "frontend" is.
 */

const state = {
  books: [],
  activeBookId: null,
  activeBook: null,
  activeChapterId: null,
};

const CLASSIFICATION_LABELS = {
  human: "Human-written",
  ai_assisted: "AI-assisted",
  ai_generated: "AI-generated",
  unclassified: "Unclassified",
};

// ---------------------------------------------------------------- API --

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

// ------------------------------------------------------------- boot up --

async function boot() {
  wireStaticEvents();
  await refreshStatus();
  await refreshBookList();
}

async function refreshStatus() {
  const el = document.getElementById("llm-indicator");
  try {
    const status = await api("/api/status");
    if (status.llm_configured) {
      el.textContent = "Claude features: on";
      el.className = "llm-indicator on";
    } else {
      el.textContent = "Claude features: off (optional)";
      el.className = "llm-indicator off";
    }
  } catch {
    el.textContent = "Backend unreachable";
  }
}

// ------------------------------------------------------------ book list --

async function refreshBookList() {
  const { books } = await api("/api/books");
  state.books = books;
  const list = document.getElementById("book-list");
  list.innerHTML = "";
  for (const book of books) {
    const li = document.createElement("li");
    li.textContent = book.title;
    li.dataset.bookId = book.id;
    if (book.id === state.activeBookId) li.classList.add("active");
    li.addEventListener("click", () => openBook(book.id));
    list.appendChild(li);
  }
}

function wireStaticEvents() {
  document.getElementById("new-book-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("new-book-title");
    const title = input.value.trim();
    if (!title) return;
    const book = await api("/api/books", { method: "POST", body: JSON.stringify({ title }) });
    input.value = "";
    await refreshBookList();
    openBook(book.id);
  });

  document.getElementById("back-to-book").addEventListener("click", () => openBook(state.activeBookId));
  document.getElementById("delete-book-btn").addEventListener("click", onDeleteBook);
  document.getElementById("view-audit-btn").addEventListener("click", openAuditModal);
  document.getElementById("close-audit").addEventListener("click", () => hide("audit-modal"));
  document.getElementById("export-report-btn").addEventListener("click", openReportModal);
  document.getElementById("close-report").addEventListener("click", () => hide("report-modal"));
  document.getElementById("download-report-btn").addEventListener("click", downloadReport);
  document.getElementById("save-text-btn").addEventListener("click", onSaveText);
  document.getElementById("run-pattern-btn").addEventListener("click", onRunPattern);
  document.getElementById("run-feedback-btn").addEventListener("click", onRunFeedback);

  document.querySelectorAll(".stamp-choice").forEach((btn) => {
    btn.addEventListener("click", () => onClassify(btn.dataset.value));
  });
}

function hide(id) { document.getElementById(id).hidden = true; }
function show(id) { document.getElementById(id).hidden = false; }

// -------------------------------------------------------------- book view --

async function openBook(bookId) {
  state.activeBookId = bookId;
  state.activeChapterId = null;
  const book = await api(`/api/books/${bookId}`);
  state.activeBook = book;

  document.querySelectorAll("#book-list li").forEach((li) => {
    li.classList.toggle("active", Number(li.dataset.bookId) === bookId);
  });

  hide("empty-desk");
  hide("chapter-view");
  show("book-view");

  document.getElementById("book-title").textContent = book.title;
  renderTallyStrip(book.chapters);
  renderChapterTable(book.chapters);
}

function renderTallyStrip(chapters) {
  const totals = { human: 0, ai_assisted: 0, ai_generated: 0, unclassified: 0 };
  for (const ch of chapters) {
    const words = (ch.text || "").trim() ? ch.text.trim().split(/\s+/).length : 0;
    totals[ch.classification] = (totals[ch.classification] || 0) + words;
  }
  const strip = document.getElementById("tally-strip");
  strip.innerHTML = Object.entries(totals)
    .filter(([, words]) => words > 0)
    .map(([key, words]) => `<span><strong>${words.toLocaleString()}</strong> ${CLASSIFICATION_LABELS[key].toLowerCase()}</span>`)
    .join("");
  if (!strip.innerHTML) strip.innerHTML = "<span>No chapter text yet.</span>";
}

function renderChapterTable(chapters) {
  const tbody = document.getElementById("chapter-rows");
  tbody.innerHTML = "";
  for (const ch of chapters) {
    const words = (ch.text || "").trim() ? ch.text.trim().split(/\s+/).length : 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(ch.title)}</td>
      <td><span class="stamp stamp-${ch.classification}">${CLASSIFICATION_LABELS[ch.classification]}</span></td>
      <td class="num mono">${words.toLocaleString()}</td>
      <td class="mono">${formatTimestamp(ch.updated_at)}</td>
      <td><button class="btn btn-ghost delete-chapter-btn" data-chapter-id="${ch.id}">Delete</button></td>
    `;
    tr.addEventListener("click", (e) => {
      if (e.target.closest(".delete-chapter-btn")) return;
      openChapter(ch.id);
    });
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll(".delete-chapter-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this chapter? (The audit trail keeps a record even after deletion.)")) return;
      await api(`/api/chapters/${btn.dataset.chapterId}`, { method: "DELETE" });
      await openBook(state.activeBookId);
    });
  });

  document.getElementById("new-chapter-form").onsubmit = async (e) => {
    e.preventDefault();
    const input = document.getElementById("new-chapter-title");
    const title = input.value.trim();
    if (!title) return;
    await api(`/api/books/${state.activeBookId}/chapters`, {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    input.value = "";
    await openBook(state.activeBookId);
  };
}

async function onDeleteBook() {
  if (!state.activeBookId) return;
  if (!confirm("Delete this whole book? Its chapters go with it — the audit log stays.")) return;
  await api(`/api/books/${state.activeBookId}`, { method: "DELETE" });
  state.activeBookId = null;
  hide("book-view");
  show("empty-desk");
  await refreshBookList();
}

// ----------------------------------------------------------- chapter view --

async function openChapter(chapterId) {
  state.activeChapterId = chapterId;
  const chapter = await api(`/api/chapters/${chapterId}`);

  hide("book-view");
  show("chapter-view");

  document.getElementById("chapter-title").textContent = chapter.title;
  document.getElementById("chapter-text").value = chapter.text || "";
  document.getElementById("classify-note").value = chapter.classification_note || "";
  document.getElementById("save-status").textContent = "";
  document.getElementById("pattern-results").innerHTML = "";
  document.getElementById("feedback-results").innerHTML = "";

  document.querySelectorAll(".stamp-choice").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.value === chapter.classification);
  });
}

async function onSaveText() {
  const text = document.getElementById("chapter-text").value;
  await api(`/api/chapters/${state.activeChapterId}/text`, {
    method: "PUT",
    body: JSON.stringify({ text }),
  });
  const status = document.getElementById("save-status");
  status.textContent = "Saved.";
  setTimeout(() => (status.textContent = ""), 2000);
}

async function onClassify(value) {
  const note = document.getElementById("classify-note").value;
  await api(`/api/chapters/${state.activeChapterId}/classify`, {
    method: "PUT",
    body: JSON.stringify({ classification: value, note }),
  });
  document.querySelectorAll(".stamp-choice").forEach((btn) => {
    btn.classList.toggle("selected", btn.dataset.value === value);
  });
}

async function onRunPattern() {
  const results = document.getElementById("pattern-results");
  results.innerHTML = "<p class=\"muted-note\">Running…</p>";
  const report = await api(`/api/chapters/${state.activeChapterId}/analysis`);

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
    html += "<div>" + report.flagged_phrases
      .map((f) => `<span class="flagged-phrase">"${escapeHtml(f.phrase)}" &times;${f.count}</span>`)
      .join("") + "</div>";
  }

  html += '<ul class="pattern-notes">' + report.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("") + "</ul>";
  results.innerHTML = html;
}

async function onRunFeedback() {
  const results = document.getElementById("feedback-results");
  results.innerHTML = "<p class=\"muted-note\">Asking Claude…</p>";
  const data = await api(`/api/chapters/${state.activeChapterId}/feedback`, { method: "POST" });
  if (data.feedback) {
    results.innerHTML = `<div class="feedback-text">${escapeHtml(data.feedback)}</div>`;
  } else {
    results.innerHTML = `<p class="muted-note">${escapeHtml(data.message || "No feedback available.")}</p>`;
  }
}

// -------------------------------------------------------------- audit log --

async function openAuditModal() {
  const { audit_log } = await api(`/api/books/${state.activeBookId}/audit`);
  const list = document.getElementById("audit-list");
  list.innerHTML = audit_log
    .slice()
    .reverse()
    .map((entry) => `
      <li>
        <span class="audit-time">${formatTimestamp(entry.timestamp)} &middot; ${entry.event_type}</span>
        ${escapeHtml(entry.chapter_title || "")} ${escapeHtml(entry.detail)}
      </li>
    `)
    .join("");
  show("audit-modal");
}

// ---------------------------------------------------------------- report --

let lastReportMarkdown = "";

async function openReportModal() {
  const report = await api(`/api/books/${state.activeBookId}/report`);
  lastReportMarkdown = buildMarkdown(report);

  const rows = Object.entries(report.word_counts_by_classification)
    .filter(([, words]) => words > 0)
    .map(([key, words]) => `
      <tr><td>${CLASSIFICATION_LABELS[key]}</td><td>${words.toLocaleString()}</td>
      <td>${report.percentages_by_classification[key]}%</td></tr>
    `).join("");

  document.getElementById("report-body").innerHTML = `
    <h3>Suggested disclosure note</h3>
    <p>${escapeHtml(report.suggested_disclosure)}</p>
    ${report.narrative_summary ? `<h3>Claude's plain-English summary</h3><p>${escapeHtml(report.narrative_summary)}</p>` : ""}
    <h3>Word counts</h3>
    <table><thead><tr><th>Classification</th><th>Words</th><th>%</th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted-note">${escapeHtml(report.disclaimer)}</p>
  `;
  show("report-modal");
}

function buildMarkdown(report) {
  const lines = [
    `# AI-Use Compliance Report — ${report.book_title}`,
    "",
    `_Generated ${report.generated_at} by AuthorLedger._`,
    "",
    "## Suggested disclosure note",
    "",
    report.suggested_disclosure,
    "",
    "## Word counts by classification",
    "",
    "| Classification | Words | % of book |",
    "|---|---|---|",
  ];
  for (const [key, label] of Object.entries(CLASSIFICATION_LABELS)) {
    const words = report.word_counts_by_classification[key] || 0;
    if (!words) continue;
    lines.push(`| ${label} | ${words} | ${report.percentages_by_classification[key]}% |`);
  }
  lines.push("", `**Total words:** ${report.total_words}`, "", "---", "", `_${report.disclaimer}_`);
  return lines.join("\n");
}

function downloadReport() {
  const blob = new Blob([lastReportMarkdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(state.activeBook?.title || "book").replace(/[^a-z0-9]+/gi, "-")}-ai-disclosure-report.md`;
  a.click();
  URL.revokeObjectURL(url);
}

// --------------------------------------------------------------- helpers --

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
      year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

boot();
