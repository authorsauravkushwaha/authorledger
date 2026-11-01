"""Optional real-browser checks for the standalone studio.

Install playwright and its Chromium, then run pytest normally. A custom
browser can be supplied with AUTHORLEDGER_CHROMIUM_EXECUTABLE.
"""
import functools
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading

import pytest


@pytest.fixture(scope="module")
def studio_url():
    web = Path(__file__).resolve().parent.parent / "web"
    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(web))
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()
    server.server_close()
    thread.join()


@pytest.fixture(scope="module")
def browser():
    playwright = pytest.importorskip("playwright.sync_api")
    with playwright.sync_playwright() as p:
        executable = os.environ.get("AUTHORLEDGER_CHROMIUM_EXECUTABLE")
        if not executable and not Path(p.chromium.executable_path).exists():
            pytest.skip("Install Playwright Chromium to run the studio browser tests")
        instance = p.chromium.launch(executable_path=executable, args=["--no-sandbox"])
        yield instance
        instance.close()


@pytest.fixture
def page(browser, studio_url):
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(studio_url, wait_until="networkidle")
    yield page
    context.close()
    assert not errors, f"Browser errors: {errors}"


def create_book(page, title="A writer’s first book"):
    page.fill("#new-book-title", title)
    page.click("#new-book-form button[type=submit]")
    page.wait_for_selector("#book-view:not([hidden])")


def test_fresh_studio_and_responsive_layout(page):
    assert page.is_visible("#dash-shelf-empty")
    assert page.locator(".modal-backdrop:not([hidden])").count() == 0
    assert page.locator("#dash-stat-books").inner_text() == "0"
    for width in [1440, 1024, 768, 390, 320]:
        page.set_viewport_size({"width": width, "height": 900})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), width
    page.click("#shelf-create-btn")
    assert page.locator("#new-book-title").evaluate("el => el === document.activeElement")


def test_manuscripts_search_sort_and_keyboard_open(page):
    create_book(page, "Zebra")
    create_book(page, "Amber")
    page.click("#nav-home-btn")
    page.select_option("#manuscript-sort", "title")
    assert page.locator(".dash-book-title").all_text_contents() == ["Amber", "Zebra"]
    page.fill("#manuscript-search", "not a title")
    assert page.is_visible("#shelf-no-results")
    assert page.is_hidden("#dash-shelf-empty")
    page.fill("#manuscript-search", "zeb")
    assert page.locator(".dash-book-card").count() == 1
    page.locator(".dash-book-card").press("Enter")
    assert page.locator("#book-title").inner_text() == "Zebra"


def test_daily_goal_editor_autosave_and_reload(page):
    create_book(page)
    page.click("#nav-home-btn")
    page.click("#edit-daily-goal-btn")
    page.fill("#daily-goal-input", "100")
    page.wait_for_timeout(1100)  # timer updates must not overwrite a goal being edited
    assert page.input_value("#daily-goal-input") == "100"
    page.click("#daily-goal-form button")
    page.click("#daily-write-btn")
    page.wait_for_selector("#chapter-view:not([hidden])")
    page.fill("#chapter-text", "One two three four five")
    page.wait_for_function("document.getElementById('save-status').textContent === 'Auto-saved'")
    page.click("#nav-home-btn")
    assert page.locator("#daily-words").inner_text() == "5"
    assert page.locator("#daily-goal-label").inner_text() == "100"
    page.reload(wait_until="networkidle")
    assert page.locator("#daily-words").inner_text() == "5"
    page.click("#daily-write-btn")
    assert page.input_value("#chapter-text") == "One two three four five"
    page.fill("#chapter-text", "One two three")
    page.click("#nav-home-btn")
    assert page.locator("#daily-words").inner_text() == "3"


def test_focus_timer_pause_reset_and_reload(page):
    page.click("#start-focus-btn")
    page.wait_for_function("document.getElementById('focus-clock').textContent !== '25:00'")
    page.reload(wait_until="networkidle")
    assert "Pause" in page.locator("#start-focus-btn").inner_text()
    page.click("#start-focus-btn")
    paused = page.locator("#focus-clock").inner_text()
    page.wait_for_timeout(1200)
    assert page.locator("#focus-clock").inner_text() == paused
    page.click("#reset-focus-btn")
    assert page.locator("#focus-clock").inner_text() == "25:00"


def test_sample_guide_and_manuscript_export(page):
    page.click("#load-sample-btn")
    page.wait_for_selector("#book-view:not([hidden])")
    page.click("#nav-home-btn")
    assert page.locator("#daily-words").inner_text() == "0"
    page.click("#tools-export-btn")
    assert page.is_visible("#manuscript-modal")
    with page.expect_download() as download:
        page.click('[data-export-format="markdown"]')
    assert download.value.suggested_filename.endswith(".md")
    page.click("#nav-home-btn")
    page.click("#tools-guide-btn")
    assert page.locator("#studio-guide").evaluate("el => el.open")
    assert page.is_visible("#feature-tour")


def test_mobile_backup_and_dialog_keyboard_access(page):
    page.set_viewport_size({"width": 390, "height": 844})
    create_book(page, "Mobile draft")
    page.click("#workspace-settings-btn")
    assert page.is_visible("#settings-modal")
    assert page.locator("#settings-modal .modal").get_attribute("role") == "dialog"
    assert page.locator("#settings-modal .modal").get_attribute("aria-modal") == "true"
    page.focus("#settings-form button[type=submit]")
    page.keyboard.press("Tab")
    assert page.locator("#close-settings-modal").evaluate("el => el === document.activeElement")
    with page.expect_download() as download:
        page.click("#settings-backup-btn")
    assert download.value.suggested_filename.endswith(".json")
    page.keyboard.press("Escape")
    assert page.is_hidden("#settings-modal")
    assert page.locator("#workspace-settings-btn").evaluate("el => el === document.activeElement")


def test_daily_progress_resets_for_a_new_day(page):
    page.evaluate("""() => {
      const key = window.AuthorLedgerEngine.PREFS_KEY;
      const prefs = JSON.parse(localStorage.getItem(key) || '{}');
      prefs.dailyProgress = {date: '2000-01-01', words: 999};
      prefs.dailyWordGoal = 750;
      localStorage.setItem(key, JSON.stringify(prefs));
    }""")
    page.reload(wait_until="networkidle")
    assert page.locator("#daily-words").inner_text() == "0"
    assert page.locator("#daily-goal-label").inner_text() == "750"


def test_story_bible_health_and_craft_tools(page):
    create_book(page, "Craft Tools Novel")

    # Story bible: add a character, then confirm the card renders.
    page.click("#bible-add-btn")
    assert page.is_visible("#bible-modal")
    assert page.is_visible("#bible-form")
    page.fill("#bible-name", "Mira Quill")
    page.fill("#bible-description", "Harbor cartographer with a pocket book of tide times.")
    page.fill("#bible-tags", "protagonist, act one")
    page.click("#bible-form button[type=submit]")
    page.wait_for_selector("#bible-grid .bible-card")
    assert "Mira Quill" in page.locator("#bible-grid").inner_text()
    page.keyboard.press("Escape")
    assert page.is_hidden("#bible-modal")

    # Typewriter mode toggles and survives a reload (stored in preferences).
    page.click("#daily-write-btn")
    page.wait_for_selector("#chapter-view:not([hidden])")
    page.click("#typewriter-btn")
    assert page.locator("body").evaluate("el => el.classList.contains('typewriter-mode')")
    page.reload(wait_until="networkidle")
    page.click("#daily-write-btn")
    assert page.locator("body").evaluate("el => el.classList.contains('typewriter-mode')")
    page.click("#typewriter-btn")

    # Line edit runs offline and every mark is clickable.
    page.fill(
        "#chapter-text",
        "She felt very tired. She saw the door, and she really saw it. "
        "At the end of the day, her heart pounded. The door was opened by the wind.",
    )
    page.click("#line-edit-btn")
    page.wait_for_selector(".lint-category")
    assert "Filter words" in page.locator("#line-edit-results").inner_text()
    page.locator(".lint-example").first.click()
    assert page.evaluate("document.getElementById('chapter-text').selectionEnd > 0")

    # Story bible picker inserts a name at the cursor.
    page.focus("#chapter-text")
    page.evaluate("document.getElementById('chapter-text').setSelectionRange(0, 0)")
    page.click("#editor-bible-btn")
    assert page.is_visible("#bible-modal")
    page.locator("#bible-modal-list .bible-list-item").first.click()
    assert page.input_value("#chapter-text").startswith("Mira Quill")

    # Read aloud bar opens; speech itself is not started in headless runs.
    page.click("#read-aloud-btn")
    assert page.is_visible("#read-aloud-bar")
    assert page.is_hidden("#read-aloud-bar") is False

    # Manuscript health summarises the book and flags unclassified chapters.
    page.click("#back-to-book")
    page.wait_for_selector("#book-view:not([hidden])")
    assert page.locator("#chapter-pace-chart .pace-bar").count() == 1
    assert "unstamped" in page.locator("#health-badge").inner_text()
