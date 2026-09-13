"""
test_frontend_assets.py

There's no browser in this test suite, so real rendering bugs (like the
one this file exists to catch) can't be caught by "does it compute the
right number" style tests. What we *can* do cheaply is check that the
specific fix stays in the file, so a future edit can't silently remove it
and reintroduce the bug where both modals rendered open and empty on
every single page load.
"""

from pathlib import Path

WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def test_hidden_attribute_override_exists_for_modals():
    css = (WEB_DIR / "style.css").read_text(encoding="utf-8")
    assert ".modal-backdrop[hidden]" in css, (
        "The `.modal-backdrop { display: flex }` rule needs a matching "
        "`.modal-backdrop[hidden] { display: none }` rule, or the `hidden` "
        "attribute on the modals gets silently overridden and both modals "
        "render open (and empty) on every page load. This exact bug "
        "shipped once already — see the CSS comment above this test."
    )


def test_modals_start_hidden_in_markup():
    html = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    for modal_id in ("audit-modal", "report-modal"):
        marker = f'id="{modal_id}"'
        idx = html.index(marker)
        # the `hidden` attribute should appear on the same opening tag
        tag_end = html.index(">", idx)
        opening_tag = html[max(0, idx - 60):tag_end]
        assert "hidden" in opening_tag, f"#{modal_id} should start with the hidden attribute"
