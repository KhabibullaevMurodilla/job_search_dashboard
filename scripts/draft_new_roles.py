#!/usr/bin/env python3
"""Draft a CV and cover letter for the best new roles this scan found.

This calls Gemini directly (jobradar/gemini_generate.py, via
JOB_RADAR_USE_GEMINI=1), never the `claude` CLI -- a GitHub Actions runner
has no interactive session for `claude -p` to sign in with, and Gemini's
free tier needs no billing account attached, so a request past the free
quota fails with 429 rather than charging anything.

Gated by DRAFT_MIN_SCORE / DRAFT_MAX_PER_RUN so a big first scan (or a
strong week) does not try to draft for hundreds of roles in one run and
burn through the day's free quota on roles nobody has looked at yet.

Never fails the workflow. By the time this step runs, the scan and the
"new roles" issue have already succeeded; a role that cannot be drafted
is logged and skipped rather than turning a working run red over a
bonus feature.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

ROLES_JSON = Path("out/roles.json")
# vars.DRAFT_MIN_SCORE / vars.DRAFT_MAX_PER_RUN come through as "" when unset
# in GitHub Actions, not absent -- `or "70"` catches that; `.get(...)` alone
# would not.
MIN_SCORE = float(os.environ.get("DRAFT_MIN_SCORE") or "70")
MAX_PER_RUN = int(os.environ.get("DRAFT_MAX_PER_RUN") or "10")
DOCS_DIR = os.environ.get("JOB_RADAR_DOCS") or "applications"


def main() -> int:
    if not ROLES_JSON.exists():
        print("no out/roles.json, nothing to draft")
        return 0
    if not os.environ.get("GEMINI_API_KEY", "").strip():
        print("GEMINI_API_KEY is not set -- skipping drafting entirely. "
              "Add it as a repo secret to enable this step.")
        return 0

    data = json.loads(ROLES_JSON.read_text(encoding="utf-8"))
    new = data.get("new", [])
    candidates = sorted(
        (r for r in new if (r.get("score") or 0) >= MIN_SCORE),
        key=lambda r: -(r.get("score") or 0),
    )[:MAX_PER_RUN]

    if not candidates:
        print(f"no new role scored {MIN_SCORE:.0f}+ (checked {len(new)}), "
              f"nothing to draft")
        return 0

    env = dict(os.environ)
    env["JOB_RADAR_USE_GEMINI"] = "1"

    summary: list[str] = []
    for role in candidates:
        uid = role["uid"]
        label = f"{role.get('company', '?')} - {role.get('title', '?')[:56]}"
        score = role.get("score") or 0
        print(f"\n== {label} (score {score:.0f}) ==", flush=True)

        cv = subprocess.run(
            ["job-radar", "generate", uid, "-k", "cv", "--docs", DOCS_DIR],
            env=env, capture_output=True, text=True,
        )
        print(cv.stdout)
        if cv.stderr:
            print(cv.stderr, file=sys.stderr)
        if cv.returncode != 0:
            summary.append(f"- **{label}** (score {score:.0f}): CV draft failed")
            continue

        letter = subprocess.run(
            ["job-radar", "generate", uid, "-k", "cover_letter",
             "--docs", DOCS_DIR],
            env=env, capture_output=True, text=True,
        )
        print(letter.stdout)
        if letter.stderr:
            print(letter.stderr, file=sys.stderr)
        summary.append(
            f"- **{label}** (score {score:.0f}): CV drafted"
            + (", cover letter drafted" if letter.returncode == 0
               else ", cover letter failed")
        )

    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary and summary:
        with open(step_summary, "a", encoding="utf-8") as f:
            f.write(f"\n## Drafted documents (score {MIN_SCORE:.0f}+, "
                     f"up to {MAX_PER_RUN} per run)\n\n")
            f.write("\n".join(summary) + "\n")
            f.write(f"\n<sub>Full CV/cover-letter files are in the "
                     f"`applications` workflow artifact.</sub>\n")

    return 0  # a drafting problem never fails the workflow


if __name__ == "__main__":
    sys.exit(main())
