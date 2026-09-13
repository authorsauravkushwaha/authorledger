"""
analysis.py — the "Writing Pattern Report".

Read this docstring before you read the code, because the framing matters
more than the math.

This module does NOT try to answer "was this AI-generated?". No cheap
text-statistics script can answer that reliably, and a tool that claims it
can is lying to whoever reads its output. What it *does* do is compute a
few honest, well-known descriptive statistics about a chunk of text
(sentence-length variety, repeated phrasing, some words that generic LLM
output leans on heavily) and hand them back as a plain report, so that a
human — the author, who is the only person who actually knows how the text
was written — has something concrete to jog their memory when they fill in
the classification themselves.

Every number this module returns is a description of the text, not a
verdict about its origin. The UI and the README repeat this on purpose;
it's not boilerplate, it's the whole ethical spine of the feature.
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field

# Phrases that show up disproportionately often in generic LLM output,
# compiled from widely shared "AI writing tells" lists circa 2023-2026.
# This list is a *lens*, not a lie detector — plenty of human writers use
# these words too, especially in business or academic prose.
WATCHED_PHRASES: tuple[str, ...] = (
    "delve into", "delve", "tapestry", "boundless", "unwavering",
    "testament to", "navigate the complexities", "it is important to note",
    "it's important to note", "in today's fast-paced world", "moreover",
    "furthermore", "in conclusion", "seamless", "seamlessly", "elevate",
    "unleash", "game-changer", "let's dive in", "in summary",
    "a beacon of", "rich tapestry", "underscores", "underscore",
    "plays a pivotal role", "when it comes to", "in the realm of",
    "stands as a", "serves as a reminder",
)

_WORD_RE = re.compile(r"[A-Za-z']+")
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


@dataclass
class PatternReport:
    word_count: int
    sentence_count: int
    avg_sentence_length: float
    sentence_length_stdev: float
    burstiness: float | None  # None when there's too little text to measure
    lexical_diversity: float  # unique words / total words, 0..1
    em_dash_per_1000_words: float
    repeated_trigram_rate: float  # 0..1, share of 3-word phrases that repeat
    flagged_phrases: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "word_count": self.word_count,
            "sentence_count": self.sentence_count,
            "avg_sentence_length": round(self.avg_sentence_length, 1),
            "sentence_length_stdev": round(self.sentence_length_stdev, 1),
            "burstiness": None if self.burstiness is None else round(self.burstiness, 2),
            "lexical_diversity": round(self.lexical_diversity, 3),
            "em_dash_per_1000_words": round(self.em_dash_per_1000_words, 1),
            "repeated_trigram_rate": round(self.repeated_trigram_rate, 3),
            "flagged_phrases": self.flagged_phrases,
            "notes": self.notes,
        }


def _tokenize_words(text: str) -> list[str]:
    return [w.lower() for w in _WORD_RE.findall(text)]


def _split_sentences(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    parts = _SENTENCE_SPLIT_RE.split(text)
    return [p.strip() for p in parts if p.strip()]


def _burstiness(sentence_lengths: list[int]) -> float | None:
    """(stdev - mean) / (stdev + mean). Positive = bursty/varied rhythm
    (common in human prose), near zero or negative = unusually uniform
    sentence rhythm. Needs at least 3 sentences to mean anything."""
    if len(sentence_lengths) < 3:
        return None
    mean = statistics.mean(sentence_lengths)
    stdev = statistics.pstdev(sentence_lengths)
    if mean + stdev == 0:
        return 0.0
    return (stdev - mean) / (stdev + mean)


def _repeated_trigram_rate(words: list[str]) -> float:
    if len(words) < 6:
        return 0.0
    trigrams = [tuple(words[i:i + 3]) for i in range(len(words) - 2)]
    seen: set[tuple[str, str, str]] = set()
    repeats = 0
    for tg in trigrams:
        if tg in seen:
            repeats += 1
        seen.add(tg)
    return repeats / len(trigrams)


def _flagged_phrases(text: str, word_count: int) -> list[dict]:
    lowered = text.lower()
    found = []
    for phrase in WATCHED_PHRASES:
        count = lowered.count(phrase)
        if count == 0:
            continue
        per_1000 = (count / word_count * 1000) if word_count else 0.0
        found.append({"phrase": phrase, "count": count, "per_1000_words": round(per_1000, 2)})
    found.sort(key=lambda f: f["per_1000_words"], reverse=True)
    return found


def _build_notes(report_kwargs: dict) -> list[str]:
    notes = []
    burstiness = report_kwargs["burstiness"]
    if burstiness is not None and burstiness < 0.05:
        notes.append(
            "Sentence lengths are quite uniform in this chapter. That can happen with "
            "generated text, but plenty of deliberate, controlled human prose reads this "
            "way too — it's a data point, not evidence."
        )
    if report_kwargs["lexical_diversity"] < 0.35 and report_kwargs["word_count"] > 200:
        notes.append(
            "Word variety is on the lower side for this length. Could be repetition worth "
            "a look, could just be a technical or list-heavy passage."
        )
    if report_kwargs["repeated_trigram_rate"] > 0.05:
        notes.append(
            "A noticeable share of three-word phrases repeat elsewhere in this chapter."
        )
    if report_kwargs["flagged_phrases"]:
        top = report_kwargs["flagged_phrases"][0]["phrase"]
        notes.append(
            f"Contains phrasing often associated with generic AI output (e.g. \"{top}\"). "
            "Many careful human writers use these words too — this is a memory-jogger, "
            "not proof of anything."
        )
    if not notes:
        notes.append("Nothing unusual stood out in these stats.")
    return notes


def analyze_text(text: str) -> PatternReport:
    words = _tokenize_words(text)
    sentences = _split_sentences(text)
    sentence_lengths = [len(_tokenize_words(s)) for s in sentences] or [0]

    word_count = len(words)
    unique_words = len(set(words))
    lexical_diversity = (unique_words / word_count) if word_count else 0.0

    em_dash_count = text.count("—") + text.count("--")
    em_dash_per_1000 = (em_dash_count / word_count * 1000) if word_count else 0.0

    kwargs = dict(
        word_count=word_count,
        sentence_count=len(sentences),
        avg_sentence_length=statistics.mean(sentence_lengths) if sentence_lengths else 0.0,
        sentence_length_stdev=statistics.pstdev(sentence_lengths) if len(sentence_lengths) > 1 else 0.0,
        burstiness=_burstiness(sentence_lengths) if sentences else None,
        lexical_diversity=lexical_diversity,
        em_dash_per_1000_words=em_dash_per_1000,
        repeated_trigram_rate=_repeated_trigram_rate(words),
        flagged_phrases=_flagged_phrases(text, word_count),
    )
    kwargs["notes"] = _build_notes(kwargs)
    return PatternReport(**kwargs)
