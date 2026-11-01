/*
 * engine.js — AuthorLedger's standalone browser engine.
 *
 * Powers the entire AuthorLedger Writing & Compliance Studio directly in
 * the visitor's browser with zero backend required (ready for static
 * hosting such as GitHub Pages, offline work, and instant autosave).
 *
 * Includes:
 *   1. Persistent BrowserLedgerStore (IndexedDB + localStorage mirror)
 *      with a strictly append-only audit trail.
 *   2. Writing Pattern Report heuristics (1-to-1 port of analysis.py).
 *   3. Offline Craft & Pacing Coach + optional BYO-key Claude helper.
 *   4. KDP AI-Use Compliance Report & Markdown builder (port of reports.py).
 *   5. Manuscript compiler (.md / .txt / print-ready .html) & importer.
 */

(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.AuthorLedgerEngine = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const VALID_CLASSIFICATIONS = ["human", "ai_assisted", "ai_generated", "unclassified"];
  const VALID_CHAPTER_STATUSES = ["drafting", "revising", "final"];

  const CLASSIFICATION_LABELS = {
    human: "Human-written",
    ai_assisted: "AI-assisted",
    ai_generated: "AI-generated",
    unclassified: "Not yet classified",
  };

  const CLASSIFICATION_BADGE_LABELS = {
    human: "Human-written",
    ai_assisted: "AI-assisted",
    ai_generated: "AI-generated",
    unclassified: "Unclassified",
  };

  const WATCHED_PHRASES = [
    "delve into", "delve", "tapestry", "boundless", "unwavering",
    "testament to", "navigate the complexities", "it is important to note",
    "it's important to note", "in today's fast-paced world", "moreover",
    "furthermore", "in conclusion", "seamless", "seamlessly", "elevate",
    "unleash", "game-changer", "let's dive in", "in summary",
    "a beacon of", "rich tapestry", "underscores", "underscore",
    "plays a pivotal role", "when it comes to", "in the realm of",
    "stands as a", "serves as a reminder",
  ];

  // ---- Story Bible ---------------------------------------------------
  // The story bible is craft data, not compliance data: it never touches
  // the append-only audit log, because a character note is not a fact
  // about how a chapter was written.
  const BIBLE_KINDS = ["character", "place", "lore", "plot"];
  const BIBLE_KIND_LABELS = {
    character: "Character",
    place: "Place",
    lore: "Lore",
    plot: "Plot beat",
  };

  // ---- Line Edit heuristics ------------------------------------------
  // Deliberately named "style marks", never "errors" or "AI signals".
  const LINT_FILTER_WORDS = [
    "felt", "feel", "saw", "see", "heard", "hear", "noticed", "realized",
    "realised", "seemed", "seem", "watched", "looked", "thought", "knew",
    "wondered", "wonder", "decided", "began to", "started to", "could see",
    "could hear", "could feel",
  ];

  const LINT_INTENSIFIERS = [
    "very", "really", "quite", "rather", "somewhat", "just", "actually",
    "basically", "literally", "suddenly", "immediately", "simply", "totally",
    "definitely", "truly", "extremely", "completely", "absolutely",
  ];

  const LINT_ADVERB_EXCEPTIONS = new Set([
    "only", "family", "early", "belly", "holy", "reply", "apply", "supply",
    "likely", "lovely", "lonely", "friendly", "silly", "ugly", "daily",
    "weekly", "monthly", "yearly", "ally", "rally", "jelly", "rely", "fly",
    "multiply", "imply", "comply", "supply", "assembly", "anomaly", "italy",
    "july", "polly", "sally", "molly", "dolly", "monopoly", "melancholy",
  ]);

  const LINT_PAST_PARTICIPLES = [
    "seen", "taken", "given", "made", "done", "known", "shown", "held",
    "told", "brought", "written", "found", "kept", "left", "sent", "built",
    "broken", "chosen", "driven", "eaten", "fallen", "forgotten", "gotten",
    "hidden", "lost", "paid", "said", "sold", "spent", "stolen", "struck",
    "thrown", "understood", "woken", "worn", "heard", "felt", "thought",
    "caught", "taught", "bought", "fought", "sought", "begun", "drunk",
    "rung", "sung", "swum", "torn", "sworn", "born", "shut", "cut", "put",
  ];

  const LINT_CLICHES = [
    "at the end of the day", "little did she know", "little did he know",
    "heart pounded", "heart skipped a beat", "let out a breath",
    "let out a sigh", "a shiver ran down", "time seemed to slow",
    "eyes widened", "butterflies in her stomach", "butterflies in his stomach",
    "calm before the storm", "only time will tell", "as luck would have it",
    "dead of night", "pale as a ghost", "quiet as a mouse", "sharp as a tack",
    "white as snow", "cold as ice", "in the nick of time",
    "breath she didn't know she was holding", "breath he didn't know he was holding",
    "all hell broke loose", "avoid like the plague", "light at the end of the tunnel",
    "tip of the iceberg", "raining cats and dogs", "bated breath",
  ];

  const LINT_FANCY_TAGS = [
    "exclaimed", "declared", "interjected", "opined", "retorted", "chortled",
    "hissed", "growled", "breathed", "ejaculated", "vociferated", "posited",
    "interposed", "effused", "spat",
  ];

  const DB_NAME = "authorledger_studio_v1";
  const DB_VERSION = 1;
  const MIRROR_KEY = "authorledger_mirror_v1";
  const PREFS_KEY = "authorledger_prefs_v1";

  function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  }

  function sortBibleEntries(entries) {
    const kindOrder = new Map(BIBLE_KINDS.map((kind, index) => [kind, index]));
    return entries
      .slice()
      .sort((a, b) =>
        (kindOrder.get(a.kind) ?? 99) - (kindOrder.get(b.kind) ?? 99) ||
        String(a.name || "").localeCompare(String(b.name || "")) ||
        a.id - b.id
      );
  }

  function countWords(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
  }

  function countParagraphs(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return 0;
    return trimmed.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean).length;
  }

  function estimateReadingMinutes(wordCount) {
    if (!wordCount || wordCount <= 0) return 0;
    return Math.max(1, Math.ceil(wordCount / 230));
  }

  function roundTo(num, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round((num + Number.EPSILON) * factor) / factor;
  }

  // --------------------------------------------------- Pattern Analysis --

  function tokenizeWords(text) {
    const matches = String(text || "").match(/[A-Za-z']+/g);
    return matches ? matches.map((w) => w.toLowerCase()) : [];
  }

  function splitSentences(text) {
    const trimmed = String(text || "").trim();
    if (!trimmed) return [];
    return trimmed
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function mean(values) {
    if (!values.length) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
  }

  function pstdev(values) {
    if (values.length <= 1) return 0;
    const avg = mean(values);
    const variance = values.reduce((sum, v) => sum + Math.pow(v - avg, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  function computeBurstiness(sentenceLengths) {
    if (sentenceLengths.length < 3) return null;
    const avg = mean(sentenceLengths);
    const sd = pstdev(sentenceLengths);
    if (avg + sd === 0) return 0.0;
    return (sd - avg) / (sd + avg);
  }

  function computeRepeatedTrigramRate(words) {
    if (words.length < 6) return 0.0;
    const total = words.length - 2;
    const seen = new Set();
    let repeats = 0;
    for (let i = 0; i < total; i++) {
      const key = `${words[i]}\u0000${words[i + 1]}\u0000${words[i + 2]}`;
      if (seen.has(key)) repeats += 1;
      seen.add(key);
    }
    return repeats / total;
  }

  function countSubstring(haystack, needle) {
    if (!needle) return 0;
    let count = 0;
    let idx = 0;
    while (true) {
      const found = haystack.indexOf(needle, idx);
      if (found === -1) break;
      count += 1;
      idx = found + needle.length;
    }
    return count;
  }

  function findFlaggedPhrases(text, wordCount) {
    const lowered = String(text || "").toLowerCase();
    const found = [];
    for (const phrase of WATCHED_PHRASES) {
      const count = countSubstring(lowered, phrase);
      if (count === 0) continue;
      const per1000 = wordCount ? (count / wordCount) * 1000 : 0.0;
      found.push({
        phrase,
        count,
        per_1000_words: roundTo(per1000, 2),
      });
    }
    found.sort((a, b) => b.per_1000_words - a.per_1000_words);
    return found;
  }

  function analyzeText(rawText) {
    const text = String(rawText || "");
    const words = tokenizeWords(text);
    const sentences = splitSentences(text);
    const sentenceLengths = sentences.length
      ? sentences.map((s) => tokenizeWords(s).length)
      : [0];

    const wordCount = words.length;
    const uniqueWords = new Set(words).size;
    const lexicalDiversity = wordCount ? uniqueWords / wordCount : 0.0;

    const emDashCount = countSubstring(text, "—") + countSubstring(text, "--");
    const emDashPer1000 = wordCount ? (emDashCount / wordCount) * 1000 : 0.0;

    const avgSentenceLen = sentenceLengths.length ? mean(sentenceLengths) : 0.0;
    const stdevSentenceLen = sentenceLengths.length > 1 ? pstdev(sentenceLengths) : 0.0;
    const rawBurstiness = sentences.length ? computeBurstiness(sentenceLengths) : null;
    const repeatedTrigramRate = computeRepeatedTrigramRate(words);
    const flaggedPhrases = findFlaggedPhrases(text, wordCount);

    const notes = [];
    if (rawBurstiness !== null && rawBurstiness < 0.05) {
      notes.push(
        "Sentence lengths are quite uniform in this chapter. That can happen with " +
        "generated text, but plenty of deliberate, controlled human prose reads this " +
        "way too — it's a data point, not evidence."
      );
    }
    if (lexicalDiversity < 0.35 && wordCount > 200) {
      notes.push(
        "Word variety is on the lower side for this length. Could be repetition worth " +
        "a look, could just be a technical or list-heavy passage."
      );
    }
    if (repeatedTrigramRate > 0.05) {
      notes.push("A noticeable share of three-word phrases repeat elsewhere in this chapter.");
    }
    if (flaggedPhrases.length > 0) {
      const top = flaggedPhrases[0].phrase;
      notes.push(
        `Contains phrasing often associated with generic AI output (e.g. "${top}"). ` +
        "Many careful human writers use these words too — this is a memory-jogger, " +
        "not proof of anything."
      );
    }
    if (notes.length === 0) {
      notes.push("Nothing unusual stood out in these stats.");
    }

    return {
      word_count: wordCount,
      sentence_count: sentences.length,
      avg_sentence_length: roundTo(avgSentenceLen, 1),
      sentence_length_stdev: roundTo(stdevSentenceLen, 1),
      burstiness: rawBurstiness === null ? null : roundTo(rawBurstiness, 2),
      lexical_diversity: roundTo(lexicalDiversity, 3),
      em_dash_per_1000_words: roundTo(emDashPer1000, 1),
      repeated_trigram_rate: roundTo(repeatedTrigramRate, 3),
      flagged_phrases: flaggedPhrases,
      notes,
    };
  }

  // ----------------------------------------------- Offline Craft Coach --

  function analyzeCraft(rawText) {
    const text = String(rawText || "").trim();
    if (!text) {
      return {
        summary: "Write or paste a scene first to see pacing and rhythm notes.",
        metrics: { words: 0, paragraphs: 0, reading_minutes: 0, dialogue_share: 0 },
        bullets: [],
      };
    }

    const words = tokenizeWords(text);
    const wordCount = words.length;
    const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const sentences = splitSentences(text);
    const sentenceLengths = sentences.map((s) => tokenizeWords(s).length).filter((n) => n > 0);

    const shortSentences = sentenceLengths.filter((n) => n <= 8).length;
    const longSentences = sentenceLengths.filter((n) => n >= 26).length;
    const longParagraphs = paragraphs.filter((p) => countWords(p) > 180).length;

    const dialogueParagraphs = paragraphs.filter((p) => /["“”']/.test(p)).length;
    const dialogueShare = paragraphs.length ? Math.round((dialogueParagraphs / paragraphs.length) * 100) : 0;

    const lyAdverbs = words.filter(
      (w) => w.length > 4 && w.endsWith("ly") && !["family", "only", "early", "belly", "holy", "reply", "apply", "supply", "likely"].includes(w)
    );
    const adverbPer1000 = wordCount ? roundTo((lyAdverbs.length / wordCount) * 1000, 1) : 0;

    let repeatedOpenings = 0;
    for (let i = 1; i < sentences.length; i++) {
      const prevFirst = (tokenizeWords(sentences[i - 1])[0] || "");
      const currFirst = (tokenizeWords(sentences[i])[0] || "");
      if (prevFirst && prevFirst === currFirst) repeatedOpenings += 1;
    }

    const bullets = [];
    if (sentenceLengths.length >= 4) {
      const avg = roundTo(mean(sentenceLengths), 1);
      if (shortSentences === 0) {
        bullets.push(
          `Sentence pacing averages ${avg} words with no short beats (8 words or under). Dropping in an occasional crisp 3–6 word sentence can sharpen tension and give long passages room to breathe.`
        );
      } else if (longSentences > sentenceLengths.length * 0.35) {
        bullets.push(
          `Over a third of your sentences run 26+ words (average ${avg}). Read those longer passages aloud to make sure clauses land cleanly without losing momentum.`
        );
      } else {
        bullets.push(
          `Good sentence-length cadence: ${shortSentences} short beat(s) and ${longSentences} extended sentence(s) around a ${avg}-word average.`
        );
      }
    }

    if (longParagraphs > 0) {
      bullets.push(
        `${longParagraphs} paragraph(s) run past 180 words. Consider breaking on a turn of thought, gesture, or image so the page stays inviting to the eye.`
      );
    } else if (paragraphs.length >= 2) {
      bullets.push(
        `Paragraph pacing looks balanced across ${paragraphs.length} paragraphs (~${Math.round(wordCount / paragraphs.length)} words per paragraph).`
      );
    }

    if (repeatedOpenings >= 2) {
      bullets.push(
        `Consecutive sentences start with the same opening word ${repeatedOpenings} times — check whether that repetition is deliberate anaphora or an easy spot to vary syntax.`
      );
    }

    if (adverbPer1000 > 18) {
      bullets.push(
        `-ly modifiers appear at ${adverbPer1000} per 1,000 words (${lyAdverbs.length} total). Scanning a few to see where a stronger verb could carry the weight may tighten the voice.`
      );
    } else {
      bullets.push(
        `Modifier density is restrained (${adverbPer1000} -ly words per 1,000 words), keeping the prose direct.`
      );
    }

    bullets.push(
      dialogueShare > 0
        ? `Roughly ${dialogueShare}% of paragraphs include quoted dialogue or speech cues — a helpful mix of scene and interiority.`
        : "This passage reads purely as narration/exposition with no quoted dialogue — make sure that matches the dramatic distance you want for this chapter."
    );

    return {
      summary: `Offline craft check · ${wordCount.toLocaleString()} words · ~${estimateReadingMinutes(wordCount)} min read`,
      metrics: {
        words: wordCount,
        paragraphs: paragraphs.length,
        reading_minutes: estimateReadingMinutes(wordCount),
        dialogue_share: dialogueShare,
        adverbs_per_1000: adverbPer1000,
      },
      bullets,
    };
  }

  // ------------------------------------------------ Line Edit (prose) --
  //
  // A plain-language copy-editing pass: the kinds of tics a good
  // developmental editor circles in pencil. It is explicitly NOT a
  // detector and never produces a score or verdict about authorship.

  const LINT_MAX_EXAMPLES = 6;
  const LINT_MAX_SCANNED = 400;

  function escapeRegex(literal) {
    return String(literal).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function sentenceContext(text, index, length) {
    const before = [
      text.lastIndexOf(".", Math.max(0, index - 1)),
      text.lastIndexOf("!", Math.max(0, index - 1)),
      text.lastIndexOf("?", Math.max(0, index - 1)),
      text.lastIndexOf("\n", Math.max(0, index - 1)),
    ];
    const start = Math.max(0, Math.max(...before) + 1);
    let end = text.length;
    for (const mark of [".", "!", "?", "\n"]) {
      const at = text.indexOf(mark, index + length);
      if (at !== -1 && at + 1 < end) end = at + 1;
    }
    const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
    if (snippet.length <= 190) return snippet;
    const relative = Math.max(0, index - start);
    const from = Math.max(0, relative - 70);
    return `${from > 0 ? "…" : ""}${snippet.slice(from, from + 180).trim()}${from + 180 < snippet.length ? "…" : ""}`;
  }

  function scanPattern(text, regex) {
    const findings = [];
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (findings.length >= LINT_MAX_SCANNED) break;
      findings.push({
        match: match[0],
        index: match.index,
        context: sentenceContext(text, match.index, match[0].length),
      });
      if (regex.lastIndex === match.index) regex.lastIndex += 1;
    }
    return findings;
  }

  function phraseRegex(phrases) {
    const ordered = phrases.slice().sort((a, b) => b.length - a.length);
    return new RegExp(`\\b(?:${ordered.map(escapeRegex).join("|")})\\b`, "gi");
  }

  function lintAdverbs(text) {
    const regex = /\b[A-Za-z]{4,}ly\b/g;
    const findings = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      const word = match[0].toLowerCase();
      if (LINT_ADVERB_EXCEPTIONS.has(word)) continue;
      findings.push({
        match: match[0],
        index: match.index,
        context: sentenceContext(text, match.index, match[0].length),
      });
      if (findings.length >= LINT_MAX_SCANNED) break;
    }
    return findings;
  }

  function lintRepeatedOpeners(text, sentences) {
    const groups = new Map();
    let cursor = 0;
    for (const sentence of sentences) {
      const at = text.indexOf(sentence, cursor);
      if (at !== -1) cursor = at + sentence.length;
      const first = (tokenizeWords(sentence)[0] || "");
      if (!first || first.length < 2) continue;
      const entry = groups.get(first) || { count: 0, index: at === -1 ? null : at };
      entry.count += 1;
      groups.set(first, entry);
    }
    return [...groups.entries()]
      .filter(([, entry]) => entry.count >= 3)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8)
      .map(([word, entry]) => ({
        match: word,
        index: entry.index,
        count: entry.count,
        context: `${entry.count} sentences begin with “${word}”`,
      }));
  }

  function lintLongSentences(text, sentences) {
    const findings = [];
    let cursor = 0;
    for (const sentence of sentences) {
      const at = text.indexOf(sentence, cursor);
      if (at !== -1) cursor = at + sentence.length;
      const length = countWords(sentence);
      if (length < 45) continue;
      findings.push({
        match: sentence.length > 90 ? `${sentence.slice(0, 88).trim()}…` : sentence,
        index: at === -1 ? null : at,
        word_count: length,
        context: `${length} words in one sentence`,
      });
    }
    return findings.sort((a, b) => b.word_count - a.word_count).slice(0, 12);
  }

  function lintLongParagraphs(text) {
    const regex = /[^\n]+(?:\n(?!\n)[^\n]+)*/g;
    const findings = [];
    let match;
    while ((match = regex.exec(text)) !== null) {
      const block = match[0].trim();
      if (!block) continue;
      const length = countWords(block);
      if (length < 180) continue;
      findings.push({
        match: block.length > 90 ? `${block.slice(0, 88).replace(/\s+/g, " ")}…` : block,
        index: match.index,
        context: `${length} words in one paragraph`,
      });
    }
    return findings;
  }

  function lintProse(rawText) {
    const text = String(rawText || "");
    if (!text.trim()) {
      return {
        word_count: 0,
        sentence_count: 0,
        paragraph_count: 0,
        style_marks: 0,
        structure_marks: 0,
        adverb_rate_per_1000: 0,
        categories: [],
        summary: "Write or paste some prose first — then the line edit will read it back to you.",
      };
    }

    const wordCount = countWords(text);
    const sentences = splitSentences(text);
    const paragraphCount = countParagraphs(text);

    const filterWords = scanPattern(text, phraseRegex(LINT_FILTER_WORDS));
    const intensifiers = scanPattern(text, phraseRegex(LINT_INTENSIFIERS));
    const adverbs = lintAdverbs(text);
    const passive = scanPattern(
      text,
      new RegExp(
        `\\b(?:was|were|is|are|been|being|be|am)\\s+(?:(?:\\w+ed)|(?:${LINT_PAST_PARTICIPLES.join("|")}))\\b`,
        "gi"
      )
    );
    const dialogueTags = scanPattern(text, phraseRegex(LINT_FANCY_TAGS)).concat(
      scanPattern(
        text,
        /\b(?:said|asked|replied|answered|shouted|whispered|muttered|murmured|exclaimed|declared|announced|insisted|snapped|hissed|growled|laughed|smiled|nodded|shrugged)\s+\w+ly\b/gi
      )
    ).sort((a, b) => a.index - b.index);
    const cliches = scanPattern(text, phraseRegex(LINT_CLICHES));
    const repeatedOpeners = lintRepeatedOpeners(text, sentences);
    const longSentences = lintLongSentences(text, sentences);
    const longParagraphs = lintLongParagraphs(text);

    const adverbRate = wordCount ? roundTo((adverbs.length / wordCount) * 1000, 1) : 0;

    const category = (key, label, group, note, findings, extra = {}) => ({
      key,
      label,
      group,
      note,
      count: findings.length,
      examples: findings.slice(0, LINT_MAX_EXAMPLES),
      capped: findings.length >= LINT_MAX_SCANNED,
      ...extra,
    });

    const categories = [
      category(
        "filter_words", "Filter words", "style",
        "Words like “felt”, “saw”, and “noticed” put a pane of glass between the reader and the moment. Often you can cut straight to what was felt.",
        filterWords
      ),
      category(
        "intensifiers", "Intensifiers", "style",
        "“Very”, “really”, “suddenly”: each one asks the adjective or verb to work harder. The strongest version is usually the one without them.",
        intensifiers
      ),
      category(
        "adverbs", "-ly adverbs", "style",
        "Adverbs aren’t banned — but a cluster of them often marks a verb that could be sharper.",
        adverbs,
        { rate_per_1000: adverbRate }
      ),
      category(
        "passive_voice", "Possible passive voice", "style",
        "A rough pattern match, not a grammar checker. Some passive sentences are exactly right; check each one rather than fixing blindly.",
        passive
      ),
      category(
        "dialogue_tags", "Dialogue tags", "style",
        "Fancy tags and adverbs after “said” pull focus from the line itself. Plain “said” disappears, which is usually the point.",
        dialogueTags
      ),
      category(
        "cliches", "Worn phrases", "style",
        "Phrases readers have met a thousand times. Sometimes the familiar beat is what you want — often it’s a placeholder for a fresher image.",
        cliches
      ),
      category(
        "repeated_openers", "Repeated sentence openers", "structure",
        "Several sentences starting the same way can read as rhythm… or as a rut. Worth a look either way.",
        repeatedOpeners
      ),
      category(
        "long_sentences", "Very long sentences", "structure",
        "Sentences past 45 words ask a lot of a reader. Read them aloud — if you run out of breath, so do they.",
        longSentences
      ),
      category(
        "long_paragraphs", "Dense paragraphs", "structure",
        "Paragraphs past 180 words become a wall on the page. A break at a turn of thought or image keeps the page inviting.",
        longParagraphs
      ),
    ];

    const styleMarks = categories
      .filter((c) => c.group === "style")
      .reduce((sum, c) => sum + c.count, 0);
    const structureMarks = categories
      .filter((c) => c.group === "structure")
      .reduce((sum, c) => sum + c.count, 0);

    const summary = styleMarks + structureMarks === 0
      ? `Clean pass: ${wordCount.toLocaleString()} words, ${sentences.length} sentences, no marks from this checklist.`
      : `${wordCount.toLocaleString()} words scanned · ${styleMarks} style mark${styleMarks === 1 ? "" : "s"} and ${structureMarks} pacing note${structureMarks === 1 ? "" : "s"} across ${sentences.length} sentences.`;

    return {
      word_count: wordCount,
      sentence_count: sentences.length,
      paragraph_count: paragraphCount,
      style_marks: styleMarks,
      structure_marks: structureMarks,
      adverb_rate_per_1000: adverbRate,
      categories,
      summary,
    };
  }

  // --------------------------------------------- Manuscript Health -----
  //
  // A whole-book view of shape and readiness: chapter length, pacing
  // outliers, and how much of the manuscript still needs an honest stamp.

  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function computeManuscriptHealth(chapters) {
    const list = (chapters || []).map((chapter) => ({
      id: chapter.id,
      title: chapter.title || "Untitled chapter",
      words: countWords(chapter.text),
      status: VALID_CHAPTER_STATUSES.includes(chapter.status) ? chapter.status : "drafting",
      classification: VALID_CLASSIFICATIONS.includes(chapter.classification)
        ? chapter.classification
        : "unclassified",
    }));

    const totalWords = list.reduce((sum, c) => sum + c.words, 0);
    const written = list.filter((c) => c.words > 0);
    const lengths = written.map((c) => c.words);
    const average = written.length ? Math.round(totalWords / written.length) : 0;
    const medianWords = Math.round(median(lengths));

    let longest = null;
    let shortest = null;
    for (const chapter of written) {
      if (!longest || chapter.words > longest.words) longest = chapter;
      if (!shortest || chapter.words < shortest.words) shortest = chapter;
    }

    const thinThreshold = Math.max(500, Math.round(medianWords * 0.4));
    const bloatedThreshold = Math.max(4000, Math.round(medianWords * 2.2));
    // Outlier checks only make sense once there are at least two written
    // chapters to compare — a lone chapter is not "short for this book".
    const thinChapters = written.length >= 2
      ? written.filter((c) => c.words < thinThreshold)
      : [];
    const bloatedChapters = written.length >= 2
      ? written.filter((c) => c.words > bloatedThreshold)
      : [];
    const emptyChapters = list.filter((c) => c.words === 0);

    const classificationWords = { human: 0, ai_assisted: 0, ai_generated: 0, unclassified: 0 };
    for (const chapter of list) {
      classificationWords[chapter.classification] += chapter.words;
    }
    const unclassifiedChapters = list.filter((c) => c.classification === "unclassified");
    const unclassifiedWords = classificationWords.unclassified;

    const finalChapters = list.filter((c) => c.status === "final").length;
    const revisingChapters = list.filter((c) => c.status === "revising").length;

    const distribution = list.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      words: chapter.words,
      share: totalWords ? roundTo(chapter.words / totalWords, 3) : 0,
      status: chapter.status,
      classification: chapter.classification,
    }));

    const notes = [];
    if (!list.length) {
      notes.push("No chapters yet. Health shows up once there is shape to measure.");
    } else {
      notes.push(
        `${list.length} chapter${list.length === 1 ? "" : "s"} · ${totalWords.toLocaleString()} words · ${average.toLocaleString()} average, ${medianWords.toLocaleString()} median.`
      );
      if (thinChapters.length) {
        notes.push(
          `${thinChapters.length} chapter${thinChapters.length === 1 ? " is" : "s are"} much shorter than the rest of the book (under ${thinThreshold.toLocaleString()} words). Sometimes that’s a deliberate beat; sometimes it’s a scene that wanted more room.`
        );
      }
      if (bloatedChapters.length) {
        notes.push(
          `${bloatedChapters.length} chapter${bloatedChapters.length === 1 ? " runs" : "s run"} far longer than the others. Check whether it’s one chapter or two wearing a trench coat.`
        );
      }
      if (emptyChapters.length) {
        notes.push(
          `${emptyChapters.length} chapter${emptyChapters.length === 1 ? " has" : "s have"} no text yet — placeholders are fine, but they’ll read as gaps in a draft export.`
        );
      }
      if (!thinChapters.length && !bloatedChapters.length && !emptyChapters.length && written.length > 1) {
        notes.push("Chapter lengths are consistent — pacing should feel steady for a reader moving straight through.");
      }
      if (unclassifiedChapters.length) {
        notes.push(
          `${unclassifiedChapters.length} chapter${unclassifiedChapters.length === 1 ? " is" : "s are"} still unclassified (${unclassifiedWords.toLocaleString()} words). The compliance report can’t be complete until every chapter has an honest stamp.`
        );
      } else {
        notes.push("Every chapter has an honest classification — the compliance report is ready to export.");
      }
    }

    let nextStep = "Add a chapter and start drafting.";
    if (list.length) {
      if (emptyChapters.length) {
        nextStep = `Write “${emptyChapters[0].title}” — it’s the only thing standing between you and a complete draft.`;
      } else if (unclassifiedChapters.length) {
        nextStep = `Stamp “${unclassifiedChapters[0].title}” as human-written, AI-assisted, or AI-generated.`;
      } else if (finalChapters < list.length) {
        nextStep = `${list.length - finalChapters} chapter${list.length - finalChapters === 1 ? " isn’t" : "s aren’t"} marked final yet. Revise, then set the status so your own progress is honest.`;
      } else {
        nextStep = "Every chapter is final and stamped. Export the manuscript, then the compliance report.";
      }
    }

    return {
      chapter_count: list.length,
      total_words: totalWords,
      average_words: average,
      median_words: medianWords,
      longest,
      shortest,
      thin_chapters: thinChapters.map((c) => ({ id: c.id, title: c.title, words: c.words })),
      bloated_chapters: bloatedChapters.map((c) => ({ id: c.id, title: c.title, words: c.words })),
      empty_chapters: emptyChapters.map((c) => ({ id: c.id, title: c.title })),
      unclassified_chapter_count: unclassifiedChapters.length,
      unclassified_words: unclassifiedWords,
      classification_words: classificationWords,
      final_chapter_count: finalChapters,
      revising_chapter_count: revisingChapters,
      distribution,
      notes,
      next_step: nextStep,
    };
  }

  // ------------------------------------------------ Compliance Reports --

  function suggestDisclosure(wordCounts, totalWords) {
    if (totalWords === 0) {
      return "No chapter text yet — nothing to report.";
    }
    if ((wordCounts.unclassified || 0) > 0) {
      return (
        `${wordCounts.unclassified} of ${totalWords} words are still ` +
        "unclassified. Classify every chapter before relying on this report."
      );
    }
    if ((wordCounts.ai_generated || 0) > 0) {
      const pct = roundTo((wordCounts.ai_generated / totalWords) * 100, 1);
      const pctStr = Number.isInteger(pct) ? pct.toFixed(1) : String(pct);
      return (
        `This book contains AI-generated text (${pctStr}% by word count). ` +
        "Per Amazon KDP's guidelines, AI-generated text must be disclosed in the " +
        "AI content declaration when you publish or update this title."
      );
    }
    if ((wordCounts.ai_assisted || 0) > 0) {
      return (
        "This book was human-written with AI-assisted support (e.g. brainstorming, " +
        "grammar and editing help). Per Amazon KDP's guidelines, AI-assisted work " +
        "generally does not require disclosure — but this record is worth keeping " +
        "in case that policy changes or you're ever asked to show your process."
      );
    }
    return "This book is entirely human-written, based on your classifications.";
  }

  function buildReport(book, chapters) {
    const wordCounts = { human: 0, ai_assisted: 0, ai_generated: 0, unclassified: 0 };
    const chapterRows = [];

    for (const ch of chapters) {
      const wc = countWords(ch.text);
      const cls = VALID_CLASSIFICATIONS.includes(ch.classification) ? ch.classification : "unclassified";
      wordCounts[cls] = (wordCounts[cls] || 0) + wc;
      chapterRows.push({
        title: ch.title,
        classification: cls,
        classification_label: CLASSIFICATION_LABELS[cls],
        word_count: wc,
        note: ch.classification_note || "",
        updated_at: ch.updated_at || "",
      });
    }

    const totalWords = Object.values(wordCounts).reduce((a, b) => a + b, 0);
    const percentages = {};
    for (const [key, count] of Object.entries(wordCounts)) {
      percentages[key] = totalWords ? roundTo((count / totalWords) * 100, 1) : 0.0;
    }

    return {
      book_title: book.title,
      author_name: book.author_name || "",
      generated_at: nowIso(),
      total_chapters: chapters.length,
      total_words: totalWords,
      word_counts_by_classification: wordCounts,
      percentages_by_classification: percentages,
      chapters: chapterRows,
      suggested_disclosure: suggestDisclosure(wordCounts, totalWords),
      narrative_summary: null,
      disclaimer:
        "This report is generated from the classifications you entered yourself. " +
        "AuthorLedger has no way to verify how any chapter was actually written — " +
        "that's information only you have. This is not legal advice; always check " +
        "Amazon KDP's current content guidelines before publishing.",
    };
  }

  function reportToMarkdown(report) {
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
      const words = (report.word_counts_by_classification || {})[key] || 0;
      const pct = (report.percentages_by_classification || {})[key] || 0;
      if (!words) continue;
      lines.push(`| ${label} | ${words} | ${pct}% |`);
    }
    lines.push("", `**Total words:** ${report.total_words}`, "");
    if (Array.isArray(report.chapters) && report.chapters.length > 0) {
      lines.push("## Chapter-by-chapter", "");
      lines.push("| Chapter | Classification | Words | Last updated | Note |");
      lines.push("|---|---|---|---|---|");
      for (const ch of report.chapters) {
        const safeTitle = String(ch.title || "").replace(/\|/g, "/");
        const safeNote = String(ch.note || "").replace(/\|/g, "/");
        const label = ch.classification_label || CLASSIFICATION_LABELS[ch.classification] || ch.classification;
        lines.push(`| ${safeTitle} | ${label} | ${ch.word_count} | ${ch.updated_at || ""} | ${safeNote} |`);
      }
      lines.push("");
    }
    lines.push("---", "", `_${report.disclaimer}_`);
    return lines.join("\n");
  }

  // ---------------------------------------- Manuscript Export & Import --

  function escapeHtmlString(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderProseHtml(text) {
    const paragraphs = String(text || "").trim().split(/\n\s*\n/);
    return paragraphs
      .map((para) => {
        const trimmed = para.trim();
        if (!trimmed) return "";
        if (/^(\*\s*\*\s*\*|-{3,}|~{3,})$/.test(trimmed)) {
          return '<hr class="scene-break">';
        }
        if (trimmed.startsWith("## ")) {
          return `<h3>${escapeHtmlString(trimmed.slice(3))}</h3>`;
        }
        if (trimmed.startsWith("# ")) {
          return `<h3>${escapeHtmlString(trimmed.slice(2))}</h3>`;
        }
        if (trimmed.startsWith("> ")) {
          return `<blockquote>${escapeHtmlString(trimmed.slice(2))}</blockquote>`;
        }
        let html = escapeHtmlString(trimmed);
        html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
        html = html.replace(/\n/g, "<br>");
        return `<p>${html}</p>`;
      })
      .filter(Boolean)
      .join("\n");
  }

  function compileManuscript(book, chapters, format = "markdown") {
    const totalWords = chapters.reduce((sum, c) => sum + countWords(c.text), 0);
    const authorLine = book.author_name ? `by ${book.author_name}` : "";

    if (format === "txt") {
      const parts = [book.title.toUpperCase()];
      if (authorLine) parts.push(authorLine);
      if (book.author_note) parts.push("", book.author_note);
      parts.push("", "=".repeat(Math.min(60, Math.max(20, book.title.length))), "");
      chapters.forEach((ch, idx) => {
        parts.push(`${ch.title}`);
        parts.push("-".repeat(Math.min(48, Math.max(12, ch.title.length))));
        parts.push("");
        parts.push((ch.text || "").trim() || "[Draft in progress]");
        if (idx < chapters.length - 1) {
          parts.push("", "", "* * *", "", "");
        }
      });
      parts.push("", "", `[Total manuscript words: ${totalWords.toLocaleString()}]`);
      return parts.join("\n");
    }

    if (format === "html") {
      const chapterHtml = chapters
        .map(
          (ch, idx) => `
          <section class="chapter-section">
            <p class="chapter-num">Chapter ${idx + 1}</p>
            <h2>${escapeHtmlString(ch.title)}</h2>
            ${renderProseHtml(ch.text || "") || "<p><em>[Draft in progress]</em></p>"}
          </section>`
        )
        .join("\n");

      return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtmlString(book.title)}</title>
<style>
  body { font-family: Georgia, 'Palatino Linotype', serif; color: #1d241f; background: #fbfaf6; max-width: 42rem; margin: 3rem auto; padding: 0 1.5rem; line-height: 1.75; font-size: 18px; }
  .title-page { text-align: center; padding: 4rem 0 3.5rem; border-bottom: 1px solid #d7dcd2; margin-bottom: 3rem; }
  .title-page h1 { font-size: 2.5rem; margin: 0 0 0.5rem; }
  .title-page .byline { font-style: italic; color: #4e5a51; font-size: 1.15rem; margin: 0.25rem 0; }
  .title-page .meta { font-family: monospace; font-size: 0.82rem; color: #677369; margin-top: 1.5rem; }
  .chapter-section { margin-bottom: 3.5rem; page-break-before: always; }
  .chapter-section:first-of-type { page-break-before: auto; }
  .chapter-num { font-family: monospace; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.12em; color: #6a766c; margin-bottom: 0.25rem; }
  .chapter-section h2 { font-size: 1.65rem; margin: 0 0 1.5rem; }
  p { margin: 0 0 1.05rem; text-indent: 1.4em; }
  .chapter-section h2 + p, hr.scene-break + p { text-indent: 0; }
  hr.scene-break { border: none; text-align: center; margin: 2rem 0; }
  hr.scene-break::after { content: "*   *   *"; color: #6a766c; letter-spacing: 0.2em; }
  blockquote { margin: 1.25rem 1.5rem; padding-left: 1rem; border-left: 2px solid #9aa89b; font-style: italic; }
  @media print { body { background: #fff; margin: 0; max-width: none; font-size: 12pt; } }
</style>
</head>
<body>
  <header class="title-page">
    <h1>${escapeHtmlString(book.title)}</h1>
    ${authorLine ? `<p class="byline">${escapeHtmlString(authorLine)}</p>` : ""}
    ${book.author_note ? `<p class="byline">${escapeHtmlString(book.author_note)}</p>` : ""}
    <p class="meta">${chapters.length} chapter(s) &middot; ${totalWords.toLocaleString()} words</p>
  </header>
  ${chapterHtml}
</body>
</html>`;
    }

    // Default: Markdown (.md)
    const md = [`# ${book.title}`];
    if (authorLine) md.push(`_${authorLine}_`);
    if (book.author_note) md.push("", `> ${book.author_note}`);
    md.push("", "---", "");
    chapters.forEach((ch, idx) => {
      md.push(`## ${ch.title}`, "");
      md.push((ch.text || "").trim() || "_[Draft in progress]_");
      if (idx < chapters.length - 1) {
        md.push("", "---", "");
      }
    });
    md.push("", "", `<!-- Exported from AuthorLedger · ${totalWords} words -->`);
    return md.join("\n");
  }

  function parseManuscriptImport(rawText, fallbackBookTitle = "Imported Manuscript") {
    const normalized = String(rawText || "").replace(/\r\n/g, "\n").trim();
    if (!normalized) {
      return {
        title: fallbackBookTitle,
        chapters: [{ title: "Chapter 1", text: "" }],
      };
    }

    const lines = normalized.split("\n");
    let bookTitle = fallbackBookTitle;
    let startIdx = 0;

    if (lines[0].startsWith("# ") && !/^#\s+chapter\b/i.test(lines[0])) {
      bookTitle = lines[0].replace(/^#\s+/, "").trim() || fallbackBookTitle;
      startIdx = 1;
    }

    const chapterHeadingRe = /^(?:##\s+(.+)|#\s+(Chapter\b.*)|(?:CHAPTER|Chapter)\s+([0-9IVXLCDM]+(?:[:.\-—\s].*)?))$/;
    const chapters = [];
    let currentTitle = null;
    let currentLines = [];

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      const match = line.trim().match(chapterHeadingRe);
      if (match) {
        if (currentTitle !== null || currentLines.join("\n").trim()) {
          const textChunk = currentLines.join("\n").replace(/^(\s*---\s*\n|\s*\n)+/, "").trim();
          if (currentTitle !== null || textChunk) {
            chapters.push({
              title: currentTitle || "Prologue / Opening",
              text: textChunk,
            });
          }
        }
        if (match[1]) currentTitle = match[1].trim();
        else if (match[2]) currentTitle = match[2].trim();
        else currentTitle = line.trim();
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }

    const trailing = currentLines.join("\n").replace(/^(\s*---\s*\n|\s*\n)+/, "").trim();
    if (currentTitle !== null || trailing) {
      chapters.push({
        title: currentTitle || "Chapter 1",
        text: trailing,
      });
    }

    if (chapters.length === 0) {
      chapters.push({ title: "Chapter 1", text: normalized });
    }

    return { title: bookTitle, chapters };
  }

  // ---------------------------------------- Browser Storage Engine --

  function createEmptyDataset() {
    return {
      schemaVersion: 2,
      seq: { book: 0, chapter: 0, snapshot: 0, audit: 0, bible: 0 },
      books: [],
      chapters: [],
      snapshots: [],
      bible: [],
      audit_log: [],
    };
  }

  class BrowserLedgerStore {
    constructor(options = {}) {
      this._idbFactory = options.indexedDB ?? (typeof indexedDB !== "undefined" ? indexedDB : null);
      this._localStorage = options.localStorage ?? (typeof localStorage !== "undefined" ? localStorage : null);
      this._data = createEmptyDataset();
      this._db = null;
      this._readyPromise = null;
      this._storageBackend = "memory";
    }

    get storageBackend() {
      return this._storageBackend;
    }

    async init() {
      if (this._readyPromise) return this._readyPromise;
      this._readyPromise = this._doInit();
      return this._readyPromise;
    }

    async _doInit() {
      let loadedFromIdb = null;
      if (this._idbFactory) {
        try {
          this._db = await this._openIdb();
          loadedFromIdb = await this._readIdbState();
          this._storageBackend = "indexeddb";
        } catch {
          this._db = null;
        }
      }

      let loadedFromMirror = null;
      if (this._localStorage) {
        try {
          const raw = this._localStorage.getItem(MIRROR_KEY);
          if (raw) loadedFromMirror = JSON.parse(raw);
          if (!this._db) this._storageBackend = "localstorage";
        } catch {
          loadedFromMirror = null;
        }
      }

      if (loadedFromIdb && (loadedFromIdb.books.length || loadedFromIdb.audit_log.length)) {
        // If localStorage mirror has a newer synchronous flush (e.g. from beforeunload),
        // prefer whichever has the higher sequence/updated state while never losing audit rows.
        if (
          loadedFromMirror &&
          (loadedFromMirror.updatedAt || "") > (loadedFromIdb.updatedAt || "")
        ) {
          this._data = this._normalizeDataset(loadedFromMirror);
          await this._persist();
        } else {
          this._data = this._normalizeDataset(loadedFromIdb);
        }
      } else if (loadedFromMirror) {
        this._data = this._normalizeDataset(loadedFromMirror);
        if (this._db) await this._persist();
      }

      if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.persist) {
        navigator.storage.persist().catch(() => {});
      }

      return this;
    }

    _normalizeDataset(raw) {
      const base = createEmptyDataset();
      if (!raw || typeof raw !== "object") return base;
      base.books = Array.isArray(raw.books) ? raw.books : [];
      base.chapters = Array.isArray(raw.chapters) ? raw.chapters : [];
      base.snapshots = Array.isArray(raw.snapshots) ? raw.snapshots : [];
      // `bible` arrived after the first schema, so older backups simply
      // have no array to normalize — that must never throw or lose data.
      base.bible = Array.isArray(raw.bible) ? raw.bible : [];
      base.audit_log = Array.isArray(raw.audit_log) ? raw.audit_log : [];
      const maxId = (arr) => arr.reduce((m, item) => Math.max(m, Number(item.id) || 0), 0);
      base.seq = {
        book: Math.max(Number(raw.seq?.book) || 0, maxId(base.books)),
        chapter: Math.max(Number(raw.seq?.chapter) || 0, maxId(base.chapters)),
        snapshot: Math.max(Number(raw.seq?.snapshot) || 0, maxId(base.snapshots)),
        audit: Math.max(Number(raw.seq?.audit) || 0, maxId(base.audit_log)),
        bible: Math.max(Number(raw.seq?.bible) || 0, maxId(base.bible)),
      };
      base.schemaVersion = 2;
      base.updatedAt = raw.updatedAt || nowIso();
      return base;
    }

    _openIdb() {
      return new Promise((resolve, reject) => {
        const req = this._idbFactory.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("kv")) {
            db.createObjectStore("kv");
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    _readIdbState() {
      return new Promise((resolve, reject) => {
        const tx = this._db.transaction("kv", "readonly");
        const store = tx.objectStore("kv");
        const req = store.get("ledger_state");
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    }

    _writeMirrorSync() {
      this._data.updatedAt = nowIso();
      if (!this._localStorage) return;
      try {
        this._localStorage.setItem(MIRROR_KEY, JSON.stringify(this._data));
      } catch {
        // Quota exceeded on localStorage for huge books: IndexedDB still holds full data.
      }
    }

    async _persist() {
      this._writeMirrorSync();
      if (!this._db) return;
      await new Promise((resolve, reject) => {
        const tx = this._db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(this._data, "ledger_state");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }

    // Append-only audit writer — deliberately the ONLY method touching audit_log.
    _appendAudit({ book_id, chapter_id = null, book_title = "", chapter_title = "", event_type, detail = "", word_count = null }) {
      this._data.seq.audit += 1;
      this._data.audit_log.push({
        id: this._data.seq.audit,
        book_id,
        chapter_id,
        book_title,
        chapter_title,
        event_type,
        detail,
        word_count,
        timestamp: nowIso(),
      });
    }

    // ---- Books ----

    async listBooks() {
      await this.init();
      return this._data.books
        .slice()
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "") || b.id - a.id)
        .map((b) => {
          const chs = this._data.chapters.filter((c) => c.book_id === b.id);
          return {
            ...b,
            chapter_count: chs.length,
            word_count: chs.reduce((sum, c) => sum + countWords(c.text), 0),
          };
        });
    }

    async getBook(bookId) {
      await this.init();
      const id = Number(bookId);
      const book = this._data.books.find((b) => b.id === id);
      if (!book) throw new Error("Book not found.");
      const chapters = this._data.chapters
        .filter((c) => c.book_id === id)
        .sort((a, b) => a.position - b.position || a.id - b.id)
        .map((c) => ({ ...c }));
      const bible = sortBibleEntries(this._data.bible.filter((entry) => entry.book_id === id))
        .map((entry) => ({ ...entry }));
      return { ...book, chapters, bible };
    }

    async createBook({ title, author_name = "", author_note = "", word_goal = 0 }) {
      await this.init();
      const cleanTitle = String(title || "").trim();
      if (!cleanTitle) throw new Error("A book needs a title.");
      this._data.seq.book += 1;
      const book = {
        id: this._data.seq.book,
        title: cleanTitle,
        author_name: String(author_name || "").trim(),
        author_note: String(author_note || "").trim(),
        word_goal: Math.max(0, parseInt(word_goal, 10) || 0),
        created_at: nowIso(),
      };
      this._data.books.push(book);
      this._appendAudit({
        book_id: book.id,
        book_title: book.title,
        event_type: "book_created",
        detail: `Book '${book.title}' created.`,
      });
      await this._persist();
      return { ...book };
    }

    async updateBook(bookId, { title, author_name, author_note, word_goal }) {
      await this.init();
      const id = Number(bookId);
      const book = this._data.books.find((b) => b.id === id);
      if (!book) throw new Error("Book not found.");
      if (title !== undefined) {
        const clean = String(title).trim();
        if (!clean) throw new Error("A book needs a title.");
        book.title = clean;
      }
      if (author_name !== undefined) book.author_name = String(author_name).trim();
      if (author_note !== undefined) book.author_note = String(author_note).trim();
      if (word_goal !== undefined) book.word_goal = Math.max(0, parseInt(word_goal, 10) || 0);

      this._appendAudit({
        book_id: book.id,
        book_title: book.title,
        event_type: "book_updated",
        detail: `Book details updated for '${book.title}'.`,
      });
      await this._persist();
      return this.getBook(id);
    }

    async deleteBook(bookId) {
      await this.init();
      const id = Number(bookId);
      const idx = this._data.books.findIndex((b) => b.id === id);
      if (idx === -1) throw new Error("Book not found.");
      const book = this._data.books[idx];
      const chapterIds = new Set(
        this._data.chapters.filter((c) => c.book_id === id).map((c) => c.id)
      );
      this._data.chapters = this._data.chapters.filter((c) => c.book_id !== id);
      this._data.snapshots = this._data.snapshots.filter((s) => !chapterIds.has(s.chapter_id));
      this._data.bible = this._data.bible.filter((entry) => entry.book_id !== id);
      this._data.books.splice(idx, 1);

      // Audit log is deliberately kept intact even after book deletion!
      this._appendAudit({
        book_id: id,
        book_title: book.title,
        event_type: "book_deleted",
        detail: `Book '${book.title}' deleted (history retained).`,
      });
      await this._persist();
      return { ok: true };
    }

    // ---- Chapters ----

    async createChapter(bookId, { title, text = "", synopsis = "", status = "drafting", classification = "unclassified", classification_note = "" }) {
      await this.init();
      const bId = Number(bookId);
      const book = this._data.books.find((b) => b.id === bId);
      if (!book) throw new Error("Book not found.");
      const cleanTitle = String(title || "").trim() || "Untitled chapter";
      const cleanStatus = VALID_CHAPTER_STATUSES.includes(status) ? status : "drafting";
      const cleanClass = VALID_CLASSIFICATIONS.includes(classification) ? classification : "unclassified";

      const siblings = this._data.chapters.filter((c) => c.book_id === bId);
      const nextPos = siblings.reduce((m, c) => Math.max(m, c.position), -1) + 1;
      const now = nowIso();

      this._data.seq.chapter += 1;
      const chapter = {
        id: this._data.seq.chapter,
        book_id: bId,
        title: cleanTitle,
        synopsis: String(synopsis || "").trim(),
        status: cleanStatus,
        text: String(text || ""),
        classification: cleanClass,
        classification_note: String(classification_note || ""),
        position: nextPos,
        created_at: now,
        updated_at: now,
      };
      this._data.chapters.push(chapter);
      this._appendAudit({
        book_id: bId,
        chapter_id: chapter.id,
        book_title: book.title,
        chapter_title: chapter.title,
        event_type: "chapter_created",
        detail: `Chapter '${chapter.title}' created.`,
        word_count: countWords(chapter.text),
      });
      if (cleanClass !== "unclassified") {
        this._appendAudit({
          book_id: bId,
          chapter_id: chapter.id,
          book_title: book.title,
          chapter_title: chapter.title,
          event_type: "classified",
          detail: `Marked as '${cleanClass}'.` + (chapter.classification_note ? ` Note: ${chapter.classification_note}` : ""),
          word_count: countWords(chapter.text),
        });
      }
      await this._persist();
      return { ...chapter };
    }

    async getChapter(chapterId) {
      await this.init();
      const id = Number(chapterId);
      const chapter = this._data.chapters.find((c) => c.id === id);
      if (!chapter) throw new Error("Chapter not found.");
      return { ...chapter };
    }

    updateChapterTextSync(chapterId, text) {
      const id = Number(chapterId);
      const chapter = this._data.chapters.find((c) => c.id === id);
      if (!chapter) return;
      chapter.text = String(text ?? "");
      chapter.updated_at = nowIso();
      this._writeMirrorSync();
    }

    async updateChapterText(chapterId, text, { logAudit = true } = {}) {
      await this.init();
      const id = Number(chapterId);
      const chapter = this._data.chapters.find((c) => c.id === id);
      if (!chapter) throw new Error("Chapter not found.");
      const book = this._data.books.find((b) => b.id === chapter.book_id);
      chapter.text = String(text ?? "");
      chapter.updated_at = nowIso();

      if (logAudit) {
        this._appendAudit({
          book_id: chapter.book_id,
          chapter_id: chapter.id,
          book_title: book ? book.title : "",
          chapter_title: chapter.title,
          event_type: "text_updated",
          detail: "Chapter text updated.",
          word_count: countWords(chapter.text),
        });
      }
      await this._persist();
      return { ...chapter };
    }

    async updateChapterMeta(chapterId, { title, synopsis, status }) {
      await this.init();
      const id = Number(chapterId);
      const chapter = this._data.chapters.find((c) => c.id === id);
      if (!chapter) throw new Error("Chapter not found.");
      const book = this._data.books.find((b) => b.id === chapter.book_id);
      const oldTitle = chapter.title;

      if (title !== undefined) chapter.title = String(title).trim() || "Untitled chapter";
      if (synopsis !== undefined) chapter.synopsis = String(synopsis).trim();
      if (status !== undefined) {
        if (!VALID_CHAPTER_STATUSES.includes(status)) {
          throw new Error(`Invalid chapter status '${status}'.`);
        }
        chapter.status = status;
      }
      chapter.updated_at = nowIso();

      if (chapter.title !== oldTitle) {
        this._appendAudit({
          book_id: chapter.book_id,
          chapter_id: chapter.id,
          book_title: book ? book.title : "",
          chapter_title: chapter.title,
          event_type: "chapter_renamed",
          detail: `Chapter renamed from '${oldTitle}' to '${chapter.title}'.`,
          word_count: countWords(chapter.text),
        });
      }
      await this._persist();
      return { ...chapter };
    }

    async reorderChapter(chapterId, direction) {
      await this.init();
      const id = Number(chapterId);
      const chapter = this._data.chapters.find((c) => c.id === id);
      if (!chapter) throw new Error("Chapter not found.");
      const chapters = this._data.chapters
        .filter((c) => c.book_id === chapter.book_id)
        .sort((a, b) => a.position - b.position || a.id - b.id);
      const idx = chapters.findIndex((c) => c.id === id);
      const swapIdx = direction === "up" ? idx - 1 : direction === "down" ? idx + 1 : idx;
      if (swapIdx >= 0 && swapIdx < chapters.length && swapIdx !== idx) {
        const tmp = chapters[idx];
        chapters[idx] = chapters[swapIdx];
        chapters[swapIdx] = tmp;
        chapters.forEach((c, pos) => {
          c.position = pos;
        });
        await this._persist();
      }
      return chapters.map((c) => ({ ...c }));
    }

    async classifyChapter(chapterId, classification, note = "") {
      await this.init();
      if (!VALID_CLASSIFICATIONS.includes(classification)) {
        throw new Error(
          `'${classification}' is not a valid classification. Use one of: ${VALID_CLASSIFICATIONS.join(", ")}.`
        );
      }
      const id = Number(chapterId);
      const chapter = this._data.chapters.find((c) => c.id === id);
      if (!chapter) throw new Error("Chapter not found.");
      const book = this._data.books.find((b) => b.id === chapter.book_id);
      const cleanNote = String(note ?? "");

      chapter.classification = classification;
      chapter.classification_note = cleanNote;
      chapter.updated_at = nowIso();

      this._appendAudit({
        book_id: chapter.book_id,
        chapter_id: chapter.id,
        book_title: book ? book.title : "",
        chapter_title: chapter.title,
        event_type: "classified",
        detail: `Marked as '${classification}'.` + (cleanNote ? ` Note: ${cleanNote}` : ""),
        word_count: countWords(chapter.text),
      });
      await this._persist();
      return { ...chapter };
    }

    async deleteChapter(chapterId) {
      await this.init();
      const id = Number(chapterId);
      const idx = this._data.chapters.findIndex((c) => c.id === id);
      if (idx === -1) throw new Error("Chapter not found.");
      const chapter = this._data.chapters[idx];
      const book = this._data.books.find((b) => b.id === chapter.book_id);
      this._data.chapters.splice(idx, 1);
      this._data.snapshots = this._data.snapshots.filter((s) => s.chapter_id !== id);

      this._appendAudit({
        book_id: chapter.book_id,
        chapter_id: null,
        book_title: book ? book.title : "",
        chapter_title: chapter.title,
        event_type: "chapter_deleted",
        detail: `Chapter '${chapter.title}' deleted (history retained).`,
      });
      await this._persist();
      return { ok: true };
    }

    // ---- Snapshots ----

    async createSnapshot(chapterId, label = "") {
      await this.init();
      const id = Number(chapterId);
      const chapter = this._data.chapters.find((c) => c.id === id);
      if (!chapter) throw new Error("Chapter not found.");
      const book = this._data.books.find((b) => b.id === chapter.book_id);
      const cleanLabel = String(label || "").trim() || "Draft checkpoint";
      const wc = countWords(chapter.text);

      this._data.seq.snapshot += 1;
      const snap = {
        id: this._data.seq.snapshot,
        chapter_id: id,
        label: cleanLabel,
        text: chapter.text,
        word_count: wc,
        created_at: nowIso(),
      };
      this._data.snapshots.push(snap);
      this._appendAudit({
        book_id: chapter.book_id,
        chapter_id: chapter.id,
        book_title: book ? book.title : "",
        chapter_title: chapter.title,
        event_type: "snapshot_saved",
        detail: `Saved snapshot '${cleanLabel}'.`,
        word_count: wc,
      });
      await this._persist();
      return { ...snap };
    }

    async listSnapshots(chapterId) {
      await this.init();
      const id = Number(chapterId);
      return this._data.snapshots
        .filter((s) => s.chapter_id === id)
        .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "") || b.id - a.id)
        .map((s) => ({ ...s }));
    }

    async restoreSnapshot(snapshotId) {
      await this.init();
      const sId = Number(snapshotId);
      const snap = this._data.snapshots.find((s) => s.id === sId);
      if (!snap) throw new Error("Snapshot not found.");
      const chapter = this._data.chapters.find((c) => c.id === snap.chapter_id);
      if (!chapter) throw new Error("Chapter not found.");
      const book = this._data.books.find((b) => b.id === chapter.book_id);

      chapter.text = snap.text;
      chapter.updated_at = nowIso();
      this._appendAudit({
        book_id: chapter.book_id,
        chapter_id: chapter.id,
        book_title: book ? book.title : "",
        chapter_title: chapter.title,
        event_type: "snapshot_restored",
        detail: `Restored snapshot '${snap.label}' (${snap.created_at}).`,
        word_count: countWords(snap.text),
      });
      await this._persist();
      return { ...chapter };
    }

    // ---- Story Bible ----
    //
    // Craft notes about the people, places, and rules of a book. These
    // are intentionally NOT written to the audit log: the ledger records
    // how chapters were written, not what happens in them.

    async listBibleEntries(bookId) {
      await this.init();
      const id = Number(bookId);
      return sortBibleEntries(this._data.bible.filter((entry) => entry.book_id === id))
        .map((entry) => ({ ...entry }));
    }

    async saveBibleEntry(bookId, payload = {}) {
      await this.init();
      const id = Number(bookId);
      const book = this._data.books.find((b) => b.id === id);
      if (!book) throw new Error("Book not found.");

      const kind = BIBLE_KINDS.includes(payload.kind) ? payload.kind : "character";
      const name = String(payload.name || "").trim();
      if (!name) throw new Error("A story-bible entry needs a name.");
      const description = String(payload.description || "").trim();
      const tags = String(payload.tags || "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .join(", ");
      const now = nowIso();

      let entry = null;
      if (payload.id !== undefined && payload.id !== null) {
        entry = this._data.bible.find((item) => item.id === Number(payload.id) && item.book_id === id);
        if (!entry) throw new Error("Story-bible entry not found.");
      }

      if (entry) {
        entry.kind = kind;
        entry.name = name;
        entry.description = description;
        entry.tags = tags;
        entry.updated_at = now;
      } else {
        this._data.seq.bible += 1;
        entry = {
          id: this._data.seq.bible,
          book_id: id,
          kind,
          name,
          description,
          tags,
          created_at: now,
          updated_at: now,
        };
        this._data.bible.push(entry);
      }

      await this._persist();
      return { ...entry };
    }

    async deleteBibleEntry(entryId) {
      await this.init();
      const id = Number(entryId);
      const idx = this._data.bible.findIndex((entry) => entry.id === id);
      if (idx === -1) throw new Error("Story-bible entry not found.");
      this._data.bible.splice(idx, 1);
      await this._persist();
      return { ok: true };
    }

    // ---- Audit & Reports ----

    async getAuditLog(bookId) {
      await this.init();
      const id = Number(bookId);
      return this._data.audit_log
        .filter((e) => e.book_id === id)
        .sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || "") || a.id - b.id)
        .map((e) => ({ ...e }));
    }

    async getGlobalAuditLog() {
      await this.init();
      return this._data.audit_log
        .slice()
        .sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || "") || a.id - b.id)
        .map((e) => ({ ...e }));
    }

    async logCustomEvent(bookId, eventType, detail) {
      await this.init();
      const id = Number(bookId);
      const book = this._data.books.find((b) => b.id === id);
      this._appendAudit({
        book_id: id,
        book_title: book ? book.title : "",
        event_type: eventType,
        detail,
      });
      await this._persist();
    }

    // ---- Backup Export & Import ----

    async exportBackup() {
      await this.init();
      return {
        app: "AuthorLedger",
        format: "authorledger-browser-backup",
        version: 1,
        exported_at: nowIso(),
        data: JSON.parse(JSON.stringify(this._data)),
      };
    }

    async importBackup(bundle) {
      await this.init();
      const payload = bundle?.data && Array.isArray(bundle.data.books) ? bundle.data : bundle;
      if (!payload || !Array.isArray(payload.books) || !Array.isArray(payload.chapters)) {
        throw new Error("That file does not look like a valid AuthorLedger JSON backup.");
      }

      const bookIdMap = new Map();
      const chapterIdMap = new Map();
      let importedBooks = 0;

      for (const srcBook of payload.books) {
        this._data.seq.book += 1;
        const newBookId = this._data.seq.book;
        bookIdMap.set(srcBook.id, newBookId);
        const createdBook = {
          id: newBookId,
          title: String(srcBook.title || "Imported Book").trim() || "Imported Book",
          author_name: String(srcBook.author_name || "").trim(),
          author_note: String(srcBook.author_note || "").trim(),
          word_goal: Math.max(0, parseInt(srcBook.word_goal, 10) || 0),
          created_at: srcBook.created_at || nowIso(),
        };
        this._data.books.push(createdBook);
        importedBooks += 1;
      }

      for (const srcCh of payload.chapters) {
        const mappedBookId = bookIdMap.get(srcCh.book_id);
        if (!mappedBookId) continue;
        this._data.seq.chapter += 1;
        const newChId = this._data.seq.chapter;
        chapterIdMap.set(srcCh.id, newChId);
        const cls = VALID_CLASSIFICATIONS.includes(srcCh.classification)
          ? srcCh.classification
          : "unclassified";
        const st = VALID_CHAPTER_STATUSES.includes(srcCh.status) ? srcCh.status : "drafting";
        this._data.chapters.push({
          id: newChId,
          book_id: mappedBookId,
          title: String(srcCh.title || "Untitled chapter").trim() || "Untitled chapter",
          synopsis: String(srcCh.synopsis || "").trim(),
          status: st,
          text: String(srcCh.text || ""),
          classification: cls,
          classification_note: String(srcCh.classification_note || ""),
          position: Number(srcCh.position) || 0,
          created_at: srcCh.created_at || nowIso(),
          updated_at: srcCh.updated_at || nowIso(),
        });
      }

      if (Array.isArray(payload.snapshots)) {
        for (const srcSnap of payload.snapshots) {
          const mappedChId = chapterIdMap.get(srcSnap.chapter_id);
          if (!mappedChId) continue;
          this._data.seq.snapshot += 1;
          this._data.snapshots.push({
            id: this._data.seq.snapshot,
            chapter_id: mappedChId,
            label: String(srcSnap.label || "Imported checkpoint"),
            text: String(srcSnap.text || ""),
            word_count: countWords(srcSnap.text || ""),
            created_at: srcSnap.created_at || nowIso(),
          });
        }
      }

      if (Array.isArray(payload.bible)) {
        for (const srcEntry of payload.bible) {
          const mappedBookId = bookIdMap.get(srcEntry.book_id);
          if (!mappedBookId) continue;
          this._data.seq.bible += 1;
          this._data.bible.push({
            id: this._data.seq.bible,
            book_id: mappedBookId,
            kind: BIBLE_KINDS.includes(srcEntry.kind) ? srcEntry.kind : "character",
            name: String(srcEntry.name || "Untitled entry").trim() || "Untitled entry",
            description: String(srcEntry.description || "").trim(),
            tags: String(srcEntry.tags || "").trim(),
            created_at: srcEntry.created_at || nowIso(),
            updated_at: srcEntry.updated_at || nowIso(),
          });
        }
      }

      if (Array.isArray(payload.audit_log)) {
        for (const entry of payload.audit_log) {
          this._data.seq.audit += 1;
          this._data.audit_log.push({
            id: this._data.seq.audit,
            book_id: bookIdMap.get(entry.book_id) || Number(entry.book_id) || 0,
            chapter_id: entry.chapter_id ? chapterIdMap.get(entry.chapter_id) || null : null,
            book_title: String(entry.book_title || ""),
            chapter_title: String(entry.chapter_title || ""),
            event_type: String(entry.event_type || "imported_event"),
            detail: String(entry.detail || ""),
            word_count: entry.word_count ?? null,
            timestamp: entry.timestamp || nowIso(),
          });
        }
      }

      for (const [, newBookId] of bookIdMap.entries()) {
        const b = this._data.books.find((item) => item.id === newBookId);
        this._appendAudit({
          book_id: newBookId,
          book_title: b ? b.title : "",
          event_type: "backup_imported",
          detail: `Restored book '${b ? b.title : ""}' from backup.`,
        });
      }

      await this._persist();
      return { importedBooks };
    }

    // ---- Sample Book ----

    async seedSampleBook() {
      const book = await this.createBook({
        title: "The Glass Cartographer (Sample)",
        author_name: "Demo Manuscript",
        author_note: "Sample novel demonstrating writing, autosave, pattern checks, and KDP disclosure logging.",
        word_goal: 2500,
      });

      await this.createChapter(book.id, {
        title: "Chapter 1 — Salt on the Astrolabe",
        synopsis: "Mira arrives at the harbor observatory before dawn and discovers a missing sea chart.",
        status: "final",
        classification: "human",
        classification_note: "Drafted by hand in two morning sessions; self-edited.",
        text:
          "Rain had been promised since Tuesday, and still the harbor smelled only of dry rope and warm brass.\n\n" +
          "Mira unlocked the observatory's side door with her knuckle pressed against the latch so it wouldn't wake the harbourmaster's dog. Inside, the long cedar table lay bare except for a ring of salt where the astrolabe usually sat.\n\n" +
          "\"You're early,\" someone said from the stair.\n\n" +
          "She didn't turn. Only one person in Port Veridian climbed three flights in wet boots without making a board complain. \"And you're standing in the dark, Julian. Where is the northern folio?\"\n\n" +
          "He set a lantern on the chart-drawer. Its wick popped once, throwing crooked amber ribs across the ceiling. \"Gone before midnight. Whoever took it left the silver dividers and took the paper. That tells you who we're dealing with.\"",
      });

      await this.createChapter(book.id, {
        title: "Chapter 2 — The Tide-Clock's Ledger",
        synopsis: "Julian and Mira reconstruct the ship registry from harbour toll receipts.",
        status: "revising",
        classification: "ai_assisted",
        classification_note: "Human-written scene; used Claude to brainstorm 18th-century harbour weights & copyedit typos.",
        text:
          "By seven o'clock the customs clerks were awake and arguing over coal.\n\n" +
          "Mira spread three years of harbour-due receipts across the bench beside the tide-clock. Every ship that crossed the bar left two traces: a chalk mark on the pilot's slate, and a weighed tally of ballast stones tipped at the south pier. Chalk washed off in the first squall. Ballast stayed.\n\n" +
          "\"Look at November,\" Julian murmured, tapping a column inked in cramped brown numerals. \"Three brigantines cleared for Lisbon in a single neap tide, all carrying empty casks. Nobody sails south in November with dry oak unless they're fetching something back that doesn't appear on a manifest.\"\n\n" +
          "Mira copied the dates into her pocket book. Outside, the gulls lifted all at once from the breakwater — a white sheet snapped into the wind.",
      });

      await this.createChapter(book.id, {
        title: "Chapter 3 — Fog Over Meridian Shoal",
        synopsis: "Outline & opening draft — needs classification once finished.",
        status: "drafting",
        classification: "unclassified",
        classification_note: "",
        text:
          "The fog came in flat and low, the colour of pewter polished with ash.\n\n" +
          "Mira kept the compass card between her knees while Julian worked the stern sweep. Ahead of them, Meridian Shoal made itself known before it showed itself: a sudden hush where the chop flattened over drowned sand.\n\n" +
          "* * *\n\n" +
          "Keep writing right here — try editing this chapter, toggling Focus Mode, saving a version snapshot, running the Writing Pattern Report, or stamping a classification below.",
      });

      await this.saveBibleEntry(book.id, {
        kind: "character",
        name: "Mira Quill",
        description: "Harbor cartographer, 31. Keeps a pocket book of tide times and lies about being afraid of deep water. Wants the northern folio back before the guild audit, mostly to prove she was right.",
        tags: "protagonist, cartographer, Port Veridian",
      });
      await this.saveBibleEntry(book.id, {
        kind: "character",
        name: "Julian Vale",
        description: "Night clerk at the observatory. Climbs stairs in wet boots, notices everything, volunteers very little. Owes Mira a debt he has never named.",
        tags: "ally, observatory, secretive",
      });
      await this.saveBibleEntry(book.id, {
        kind: "place",
        name: "Port Veridian",
        description: "A harbor town built on three hills of dry rope warehouses and brass instruments. Smells of tar and warm metal. The customs clerks argue about coal before sunrise.",
        tags: "setting, harbor, book one",
      });
      await this.saveBibleEntry(book.id, {
        kind: "lore",
        name: "The tide-clock",
        description: "A civic clock that runs on ballast stones rather than pendulums. Every ship that crosses the bar leaves a weighed tally at the south pier — the town's only honest ledger.",
        tags: "worldbuilding, mechanics",
      });
      await this.saveBibleEntry(book.id, {
        kind: "plot",
        name: "The northern folio disappears",
        description: "Act I turn: the chart is stolen before midnight, silver dividers left behind. The thief wanted the paper, not the instruments — which tells Mira who it was.",
        tags: "act 1, inciting incident",
      });

      return this.getBook(book.id);
    }

    // ---- Preferences ----

    getPrefs() {
      const defaults = {
        theme: "ledger",
        editorFont: "serif",
        editorSize: "medium",
        anthropicApiKey: "",
      };
      if (!this._localStorage) return defaults;
      try {
        const raw = this._localStorage.getItem(PREFS_KEY);
        if (!raw) return defaults;
        return { ...defaults, ...JSON.parse(raw) };
      } catch {
        return defaults;
      }
    }

    savePrefs(partial) {
      const merged = { ...this.getPrefs(), ...partial };
      if (this._localStorage) {
        try {
          this._localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
        } catch {
          // ignore
        }
      }
      return merged;
    }
  }

  // ------------------------------------------- Browser Claude Optional --

  async function callClaudeBrowser({ apiKey, prompt, maxTokens = 500 }) {
    if (!apiKey) return null;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw new Error(`Claude API returned ${res.status}: ${errBody.slice(0, 180)}`);
    }
    const body = await res.json();
    const blocks = (body.content || []).filter((b) => b.type === "text").map((b) => b.text);
    return blocks.join("\n").trim() || null;
  }

  return {
    VALID_CLASSIFICATIONS,
    VALID_CHAPTER_STATUSES,
    CLASSIFICATION_LABELS,
    CLASSIFICATION_BADGE_LABELS,
    WATCHED_PHRASES,
    PREFS_KEY,
    MIRROR_KEY,
    nowIso,
    countWords,
    countParagraphs,
    estimateReadingMinutes,
    analyzeText,
    analyzeCraft,
    lintProse,
    computeManuscriptHealth,
    BIBLE_KINDS,
    BIBLE_KIND_LABELS,
    buildReport,
    reportToMarkdown,
    compileManuscript,
    parseManuscriptImport,
    BrowserLedgerStore,
    callClaudeBrowser,
  };
});
