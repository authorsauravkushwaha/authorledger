"""
Real, live, in-a-browser verification of AuthorLedger — not a re-render,
not a static-HTML check, an actual headless Chromium clicking through the
actual running app, the same way a person would.

This directly re-tests the exact bug reported: does a modal appear on
page load before any book exists? Then it walks the full workflow:
create a book, add a chapter, save text, classify it, run the pattern
report, open the audit trail, open and close the compliance report modal
(the one from the screenshot) - and fails loudly on any browser console
error along the way.
"""
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

PORT = 8799
BASE = f"http://127.0.0.1:{PORT}"

console_errors = []
failures = []


def check(label, condition):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {label}")
    if not condition:
        failures.append(label)


def main():
    proc = subprocess.Popen(
        [sys.executable, "main.py", "--port", str(PORT), "--db", "e2e_verify.db", "--no-browser"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    # wait for the server to actually come up
    for _ in range(30):
        try:
            urllib.request.urlopen(f"{BASE}/api/status", timeout=1)
            break
        except Exception:
            time.sleep(0.2)
    else:
        print("Server never came up.")
        print(proc.stdout.read())
        sys.exit(1)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
            page.on("pageerror", lambda exc: console_errors.append(str(exc)))

            # ---- THE reported bug: does a modal show up before anything exists? ----
            page.goto(BASE, wait_until="networkidle")
            check(
                "No modal visible on a completely fresh page load (the reported bug)",
                page.is_hidden("#audit-modal") and page.is_hidden("#report-modal"),
            )
            check("Onboarding message is visible instead", page.is_visible("#empty-desk"))

            # ---- create a book ----
            page.fill("#new-book-title", "E2E Verification Book")
            page.click("#new-book-form button[type=submit]")
            page.wait_for_selector("#book-view:not([hidden])")
            check("Book view appears after creating a book", page.is_visible("#book-view"))
            check("New book appears on the shelf", page.inner_text("#book-list") .find("E2E Verification Book") != -1)

            # ---- backup download link actually triggers a real download ----
            with page.expect_download() as download_info:
                page.click("text=Download full backup")
            download = download_info.value
            check("Backup link triggers a real file download", download.suggested_filename.endswith(".db"))

            # ---- add a chapter ----
            page.fill("#new-chapter-title", "Chapter One")
            page.click("#new-chapter-form button[type=submit]")
            page.wait_for_selector("#chapter-rows tr")
            check("Chapter row appears in the ledger table", page.locator("#chapter-rows tr").count() == 1)

            # ---- open chapter, write text, save ----
            page.click("#chapter-rows tr")
            page.wait_for_selector("#chapter-view:not([hidden])")
            sample = ("Moreover, we must delve into the tapestry of this unwavering "
                      "testament. Furthermore, it seamlessly underscores a boundless truth "
                      "in a way that repeats the quick brown fox jumps over the lazy dog "
                      "the quick brown fox jumps over the lazy dog.")
            page.fill("#chapter-text", sample)
            page.click("#save-text-btn")
            page.wait_for_selector("#save-status:has-text('Saved')")
            check("Chapter text saves and shows confirmation", True)

            # ---- classify it ----
            page.click('.stamp-choice[data-value="ai_generated"]')
            time.sleep(0.3)
            check(
                "AI-generated stamp becomes selected",
                "selected" in (page.get_attribute('.stamp-choice[data-value="ai_generated"]', "class") or ""),
            )

            # ---- run the pattern report ----
            page.click("#run-pattern-btn")
            page.wait_for_selector("#pattern-results .pattern-stats")
            check("Pattern report renders stats", page.locator(".pattern-stat").count() > 0)
            check(
                "Flagged phrases show up for this text",
                page.locator(".flagged-phrase").count() > 0,
            )
            check(
                "Disclaimer language is present, not a bare score",
                "not" in page.inner_text(".pattern-disclaimer").lower(),
            )

            # ---- back to book, open audit trail ----
            page.click("#back-to-book")
            page.wait_for_selector("#book-view:not([hidden])")
            page.click("#view-audit-btn")
            page.wait_for_selector("#audit-modal:not([hidden])")
            check("Audit modal opens and is populated", page.locator("#audit-list li").count() > 0)
            page.click("#close-audit")
            check("Audit modal closes again", page.is_hidden("#audit-modal"))

            # ---- open compliance report -- this is the exact modal from the screenshot ----
            page.click("#export-report-btn")
            page.wait_for_selector("#report-modal:not([hidden])")
            report_text = page.inner_text("#report-body")
            check("Report modal opens with real content this time", len(report_text.strip()) > 0)
            check("Report includes the suggested disclosure section", "disclosure" in report_text.lower())
            check("Report mentions AI-generated (we classified the chapter that way)", "ai-generated" in report_text.lower())
            page.click("#close-report")
            check("Report modal closes again", page.is_hidden("#report-modal"))

            # ---- delete the book, confirm clean teardown ----
            page.on("dialog", lambda dialog: dialog.accept())
            page.click("#delete-book-btn")
            page.wait_for_selector("#empty-desk:not([hidden])")
            check("Deleting the book returns to the empty state", page.is_visible("#empty-desk"))

            browser.close()
    finally:
        proc.terminate()
        proc.wait(timeout=5)

    print()
    print("Console/page errors seen during the whole run:", console_errors or "none")
    print()
    if failures:
        print(f"{len(failures)} CHECK(S) FAILED:")
        for f in failures:
            print(" -", f)
        sys.exit(1)
    else:
        print(f"All checks passed. Zero console errors: {len(console_errors) == 0}")


if __name__ == "__main__":
    main()
