"""job_radar_launcher.py

Runs job-radar with JOB_RADAR_USE_GEMINI=1 set, so `cv`/`cover_letter`
generation goes straight to Gemini (jobradar/gemini_generate.py) instead of
shelling out to a `claude` CLI install. One command instead of setting an
environment variable by hand every session.

This used to also start a local HTTP server (fake_claude.py) that pretended
to be the `claude` CLI by speaking a stripped-down shape of Anthropic's API.
That approach never worked for anything beyond `rank` (Claude Code's own
Read/Write/Bash tool loop has no equivalent in a single HTTP call), so it's
gone: gemini_generate.py already does the real job by building one
self-contained prompt and calling Gemini directly, no proxy required.

Usage:
    python job_radar_launcher.py rank
    python job_radar_launcher.py serve
    python job_radar_launcher.py scan

Anything you'd normally type after `job-radar` works the same way here.
Needs GEMINI_API_KEY set in the environment (or in a `.env` job-radar
already loads) -- this launcher does not set it for you.
"""

from __future__ import annotations

import os
import subprocess
import sys


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print("Usage: python job_radar_launcher.py <job-radar arguments>")
        print("e.g.:  python job_radar_launcher.py rank")
        return 1

    if not os.environ.get("GEMINI_API_KEY"):
        print("! GEMINI_API_KEY isn't set in this session. cv/cover_letter "
              "generation will fail until it is -- scan, enrich, list and "
              "serve don't need it.")

    env = os.environ.copy()
    # Only set if you haven't already decided this yourself.
    env.setdefault("JOB_RADAR_USE_GEMINI", "1")

    print(f"Running: job-radar {' '.join(args)}")
    result = subprocess.run(["job-radar", *args], env=env)
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
