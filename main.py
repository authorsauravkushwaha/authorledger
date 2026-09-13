#!/usr/bin/env python3
"""
main.py — AuthorLedger entry point.

Usage:
    python3 main.py                  # starts on http://localhost:8420
    python3 main.py --port 9000
    python3 main.py --db mybook.db   # keep separate ledgers per project

No pip install needed — everything AuthorLedger needs ships in Python's
standard library. The one optional feature (Claude-powered report
summaries and craft feedback) turns on automatically if you set the
AUTHORLEDGER_ANTHROPIC_API_KEY environment variable; without it, the app
runs fully offline.
"""

from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

from authorledger import llm_assist, server


def main() -> None:
    parser = argparse.ArgumentParser(description="AuthorLedger — AI-use disclosure ledger for authors.")
    parser.add_argument("--port", type=int, default=8420, help="Port to run on (default: 8420).")
    parser.add_argument("--db", type=str, default="authorledger.db", help="Path to the ledger database file.")
    parser.add_argument("--no-browser", action="store_true", help="Don't auto-open a browser tab.")
    args = parser.parse_args()

    httpd = server.run(args.db, args.port)
    url = f"http://localhost:{args.port}"

    print("=" * 60)
    print("  AuthorLedger is running")
    print(f"  Ledger file : {args.db}")
    print(f"  Open in browser: {url}")
    if llm_assist.is_configured():
        print("  Claude features: ON (report summaries + craft feedback)")
    else:
        print("  Claude features: off — everything core still works.")
        print(f"  (set {llm_assist.ENV_VAR} to turn them on)")
    print("  Press Ctrl+C to stop.")
    print("=" * 60)

    if not args.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down. Your ledger is saved in", args.db)
        httpd.shutdown()
        sys.exit(0)


if __name__ == "__main__":
    main()
