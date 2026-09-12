"""
llm_assist.py — optional Claude-powered features.

Everything else in AuthorLedger works fully offline with zero dependencies
and zero API calls. This module is the one *optional* layer on top: if the
author sets an Anthropic API key, AuthorLedger can (a) turn a book's
structured compliance report into a plain-English paragraph, and
(b) give craft feedback (voice, pacing) on a chapter.

Neither feature has anything to do with detecting AI-generated text — that
job is deliberately kept out of this file too. This is a writing/reporting
assistant, not a lie-detector.

No third-party packages: this uses ``urllib.request`` from the standard
library to call the Anthropic API directly, so `pip install` is never
required to run AuthorLedger, even with this feature on.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

API_URL = "https://api.anthropic.com/v1/messages"
DEFAULT_MODEL = "claude-sonnet-4-6"
ENV_VAR = "AUTHORLEDGER_ANTHROPIC_API_KEY"


class LLMError(RuntimeError):
    """Raised when a Claude call fails. Callers should catch this and
    degrade gracefully — the app must never crash because the network
    or the API key isn't available."""


def get_api_key() -> str | None:
    return os.environ.get(ENV_VAR) or None


def is_configured() -> bool:
    return get_api_key() is not None


def _call_claude(prompt: str, *, max_tokens: int = 600, model: str = DEFAULT_MODEL) -> str:
    api_key = get_api_key()
    if not api_key:
        raise LLMError(
            f"No Anthropic API key found. Set the {ENV_VAR} environment "
            "variable to enable this feature — it's optional."
        )

    payload = json.dumps({
        "model": model,
        "max_tokens": max_tokens,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    request = urllib.request.Request(
        API_URL,
        data=payload,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise LLMError(f"Claude API returned {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise LLMError(f"Could not reach the Claude API: {exc.reason}") from exc

    blocks = body.get("content", [])
    text_blocks = [b.get("text", "") for b in blocks if b.get("type") == "text"]
    if not text_blocks:
        raise LLMError("Claude API responded, but with no text content.")
    return "\n".join(text_blocks).strip()


def summarize_report_narrative(report: dict) -> str | None:
    """Turn the structured compliance report into a short, plain-English
    paragraph the author can paste into their own notes. Returns None
    (never raises) if the feature isn't configured or the call fails —
    the rest of the app must work perfectly without this."""
    if not is_configured():
        return None

    prompt = (
        "You are helping a self-published author write a short, plain-English note "
        "for their own private records, summarizing how much of their book was "
        "human-written versus AI-assisted versus AI-generated, based on the "
        "structured data below. Be factual and brief (3-4 sentences), do not add "
        "any legal advice or claims about Amazon policy beyond what's given, and do "
        "not speculate about anything not in the data.\n\n"
        f"Book title: {report.get('book_title')}\n"
        f"Total chapters: {report.get('total_chapters')}\n"
        f"Word counts by classification: {json.dumps(report.get('word_counts_by_classification', {}))}\n"
        f"Suggested disclosure note: {report.get('suggested_disclosure')}\n"
    )
    try:
        return _call_claude(prompt, max_tokens=300)
    except LLMError:
        return None


def craft_feedback(chapter_text: str) -> str | None:
    """Ask Claude for brief, constructive craft feedback on a chapter —
    voice, pacing, clarity. Purely a writing-assistant feature; returns
    None (never raises) if unavailable."""
    if not is_configured():
        return None
    if not chapter_text.strip():
        return None

    excerpt = chapter_text[:6000]  # keep the prompt small and cheap
    prompt = (
        "You are a supportive, direct writing coach. Read the excerpt below and give "
        "3-5 short bullet points of craft feedback: things like pacing, voice "
        "consistency, repetitive phrasing, or sentence-rhythm variety. Do not comment "
        "on whether the text seems AI-written or not — that's not your job here, only "
        "the craft.\n\n"
        f"--- Excerpt ---\n{excerpt}\n--- End excerpt ---"
    )
    try:
        return _call_claude(prompt, max_tokens=500)
    except LLMError:
        return None
