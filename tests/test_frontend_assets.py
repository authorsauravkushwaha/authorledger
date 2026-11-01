"""
test_frontend_assets.py

Checks critical markup, CSS, GitHub Pages relative-path compatibility, and
strict Content-Security-Policy invariants for the AuthorLedger web studio.
"""

import re
from pathlib import Path

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
WORKFLOW_PATH = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "publish-pages.yml"


def test_hidden_attribute_override_exists_for_modals():
    css = (WEB_DIR / "style.css").read_text(encoding="utf-8")
    assert ".modal-backdrop[hidden]" in css, (
        "The `.modal-backdrop { display: flex }` rule needs a matching "
        "`.modal-backdrop[hidden] { display: none }` rule, or the `hidden` "
        "attribute on the modals gets silently overridden and modals "
        "render open on page load."
    )


def test_modals_start_hidden_in_markup():
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    modal_ids = (
        "audit-modal",
        "report-modal",
        "manuscript-modal",
        "import-modal",
        "snapshots-modal",
        "settings-modal",
    )
    for modal_id in modal_ids:
        marker = f'id="{modal_id}"'
        idx = html.index(marker)
        tag_end = html.index(">", idx)
        opening_tag = html[max(0, idx - 60):tag_end]
        assert "hidden" in opening_tag, f"#{modal_id} should start with the hidden attribute"


def test_relative_asset_urls_for_github_pages_subpath():
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    assert 'href="style.css"' in html
    assert 'src="engine.js"' in html
    assert 'src="app.js"' in html
    assert 'href="/style.css"' not in html
    assert 'src="/app.js"' not in html


def test_no_inline_scripts_or_styles_violating_csp():
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    assert not re.search(r'\bstyle\s*=', html), "Inline style= attributes violate strict CSP"
    script_tags = re.findall(r"<script\b[^>]*>", html, flags=re.IGNORECASE)
    assert len(script_tags) >= 2
    for tag in script_tags:
        assert "src=" in tag, f"Inline <script> tag without src= violates CSP: {tag}"


def test_github_pages_workflow_publishes_web_studio():
    workflow = WORKFLOW_PATH.read_text(encoding="utf-8")
    assert "cp -r web/. _site/" in workflow


def test_every_dom_id_referenced_in_app_js_exists_in_html():
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    js = (WEB_DIR / "app.js").read_text(encoding="utf-8")

    html_ids = set(re.findall(r'\bid="([^"]+)"', html))
    referenced_ids = set(re.findall(r'getElementById\("([^"]+)"\)', js))
    referenced_ids |= set(re.findall(r'(?:show|hide)\("([^"]+)"\)', js))

    missing = referenced_ids - html_ids
    assert not missing, f"app.js references missing HTML element IDs: {sorted(missing)}"

