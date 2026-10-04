"""Non-agentic CV/cover-letter drafting via Gemini.

runner.run_job() shells out to real Claude Code with Read/Write/Bash tool
access, and its prompts (runner.PROMPTS) say "read source-cv.txt" / "read
job-description.md" / "use the rate-cv skill", expecting Claude Code's own
tool-use loop to fetch that content autonomously mid-conversation. A model
behind a simple text-in/text-out proxy (no real tool use) never gets to
read any of it, so real Claude Code is currently the only thing that
works for these two kinds -- confirmed directly against this repo's own
runner.py: the CV prompt's very first instruction is "Read that file
first", and nothing in the prompt text itself carries the CV or the job
description.

This module takes the opposite approach: do every "read" step in Python
first -- the same reads run_job() itself already does to build the
role's own folder -- inline all of that content directly into one
prompt, and call Gemini with nothing left for it to fetch. The
quality-check loop (runner._quality, which already just runs
cv_signals.py / detect.py as plain subprocesses, never the model) is
reused completely unchanged, so a draft written this way is held to
exactly the same bar as one Claude Code would have written.

Everything reused from runner.py is imported, not copied, so a fix there
(a new quality check, a revised prompt) applies here too without anyone
having to remember to port it twice.
"""

from __future__ import annotations

import os
import re
import shutil
from pathlib import Path

from . import runner, store
from .runner import (role_dir, _write_jd, PROMPTS, UNTRUSTED,
                     _quality, _record, tidy_case, MAX_REVISIONS,
                     redact_secrets, _skill_roots)

GEMINI_MODEL = os.environ.get("PROXY_GEMINI_MODEL", "gemini-3.6-flash")

KINDS = ("cv", "cover_letter")

# Roughly what drafting one CV or cover letter costs, input tokens. Used only
# to show a cost estimate before a bulk draft starts -- there is no per-call
# metering here the way there was for the old Claude-based ranking feature,
# but the dashboard still asks before spending anything, and asking with no
# number attached is worse than a rough one. Carried over from the figure
# ranking used to quote for screening a single role one at a time, which
# remains a reasonable order-of-magnitude estimate for one CV/cover-letter
# draft against a real job description.
SCREEN_TOKENS = 60_000


def _gemini_client():
    from google import genai
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        raise RuntimeError("GEMINI_API_KEY is not set in this process's environment")
    return genai.Client(api_key=key)


def _skill_text(name: str, *rels: str) -> str:
    """Inline a skill's own files, since Gemini has no Read tool to fetch
    them itself. Empty string if the skill isn't installed -- matching
    run_job()'s own "missing is reported, not fatal" stance rather than
    raising over it.
    """
    for root in _skill_roots():
        base = root / name
        if base.is_dir():
            parts = []
            for rel in rels:
                f = base / rel
                if f.exists():
                    parts.append(f"--- {name}/{rel} ---\n"
                                 + f.read_text(encoding="utf-8"))
            return "\n\n".join(parts)
    return ""


def _call_gemini(prompt: str) -> str:
    """One text-in, text-out call. Strips a markdown code fence Gemini
    sometimes wraps the answer in, the same cleanup the proxy already
    does for rank -- so a draft never gets saved with ```markdown ... ```
    literally wrapped around it.
    """
    client = _gemini_client()
    response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
    text = (response.text or "").strip()
    text = re.sub(r"^```[a-zA-Z]*\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    return text


def _build_initial_prompt(kind: str, cv_text: str, jd_text: str, cfg_text: str) -> str:
    """The same instructions runner.PROMPTS already carries, unedited, with
    the content those instructions say to "read" inlined directly above
    them instead of left for a tool call that will never come.
    """
    parts = [UNTRUSTED]
    parts.append(f"--- job-description.md ---\n{jd_text}")
    parts.append(f"--- source-cv.txt ---\n{cv_text}")
    # Both kinds are told to "use the natural-writing skill" inside
    # PROMPTS[kind] itself, but only "cv" ever had the skill's own text
    # inlined here -- a cover letter went out with the instruction pointing
    # at a skill Gemini could never read, and no craft guidance behind it,
    # which is exactly the gap that leaves a letter reading generic rather
    # than ready to send.
    skill = _skill_text("natural-writing", "SKILL.md")
    if skill:
        parts.append(skill)
    if kind == "cv":
        skill = _skill_text("rate-cv", "SKILL.md", "references/rubric.md",
                            "references/craft.md")
        if skill:
            parts.append(skill)
    # UNTRUSTED is already in `parts[0]`, so passed empty here to avoid
    # duplicating it inside the formatted body.
    body = PROMPTS[kind].format(config=cfg_text, cv_source="source-cv.txt",
                                untrusted="")
    note = ("\n\nNOTE: you have no file access here. Everything you would "
           "normally read (job-description.md, source-cv.txt, and the "
           "rate-cv skill where mentioned) is already given above, in "
           "full -- do not say you cannot find a file, it is there. You "
           "also cannot run a script yourself; a separate check runs "
           "after you answer, the same way it always does. Return ONLY "
           "the finished document's full text: no preamble, no code "
           "fence, nothing else.")
    parts.append(body + note)
    return "\n\n".join(parts)


def _build_revision_prompt(current_draft: str, problems: list[str]) -> str:
    """Same substance as runner._revision_prompt(), reworded for a model
    that returns text rather than editing a file in place.
    """
    lines = "\n".join(f"- {p}" for p in problems)
    return (
        f"Here is the current draft in full:\n\n{current_draft}\n\n"
        f"It was checked and these came back:\n\n{lines}\n\n"
        f"Fix exactly those. Do not remove content to make a score go up: "
        f"every claim already in the document is one the candidate can "
        f"defend, and losing it costs more than the score gains. Do not "
        f"add any fact that was not already in the draft or the CV. Keep "
        f"the same structure and the same headings, keep every section, "
        f"and keep role date ranges in digits on the title line, as "
        f"'2022 - Present'. Do not reintroduce a phrase or a construction "
        f"an earlier pass removed, in this or any other sentence: it "
        f"failed once and it fails again. Return ONLY the complete "
        f"revised document's full text: no preamble, no code fence, "
        f"nothing else."
    )


def run_job_gemini(job_id: int, db_path=None, base=None, cv_source=None,
                   config_path=None) -> None:
    """The same contract as runner.run_job(), for kind in ("cv",
    "cover_letter") only -- calls Gemini directly instead of shelling out
    to Claude Code. Everything downstream (the artifacts table, the
    dashboard's rendering, the quality gates) is unchanged: this only
    replaces how the document gets written, not what happens to it after.
    """
    con = store.connect(db_path)
    try:
        job = con.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not job or job["state"] not in ("pending", "running"):
            return
        if job["kind"] not in KINDS:
            store.mark_job(con, job_id, "failed",
                           error=f"run_job_gemini does not handle kind={job['kind']!r}")
            return
        row = con.execute("SELECT * FROM roles WHERE uid=?", (job["uid"],)).fetchone()
        if row is None:
            store.mark_job(con, job_id, "failed", error="role not found")
            return

        store.mark_job(con, job_id, "running")

        if not os.environ.get("GEMINI_API_KEY", "").strip():
            store.mark_job(con, job_id, "failed",
                           error="GEMINI_API_KEY is not set")
            return

        d = role_dir(row, base)
        d.mkdir(parents=True, exist_ok=True)
        _write_jd(d, row)

        cfg_file = (Path(config_path) if config_path else
                   next((Path(n) for n in ("config.local.yaml", "config.yaml")
                        if Path(n).exists()), None))
        cfg_text = (redact_secrets(cfg_file.read_text(encoding="utf-8"))[:6000]
                   if cfg_file else "(no config found)")

        cv_cfg, cfg_err = "", ""
        try:
            from .config import load as _load
            cv_cfg = _load(config_path).cv_path
        except Exception as e:
            cfg_err = f"{type(e).__name__}: {e}"[:200]
        chosen = cv_source or cv_cfg or os.environ.get("JOB_RADAR_CV") or ""
        src = Path(chosen) if chosen else None
        if src is None or not src.exists() or src.is_dir():
            why = (f"could not read your config ({cfg_err}), so the CV path "
                  f"is unknown. Fix the config and click again."
                  if cfg_err and not chosen else
                  "No CV configured. Set `cv.path` in your config, or run "
                  "`job-radar setup`." if not chosen else
                  f"the CV at {src} is not a readable file. Check `cv.path` "
                  f"in your config.")
            store.mark_job(con, job_id, "failed", error=why)
            return

        shutil.copy2(src, d / f"source-cv{src.suffix}")
        # Routed through the same cvtext.read_cv_file() every scoring path
        # uses (via its cv_text() wrapper), rather than this function's own
        # docx/txt-only branching -- which had no branch at all for a .pdf
        # CV. That silently left cv_text as "", and the draft went to Gemini
        # with no CV in it: a cover letter "ready to send" cannot be written
        # against nothing, and the failure was invisible because nothing
        # checked for it before the call. cvtext.read_cv_file() also refuses
        # outright (SystemExit) on a CV that cannot be read as text at all,
        # rather than quietly drafting from a PDF's file structure or an
        # empty string.
        try:
            from . import cvtext
            cv_text = cvtext.read_cv_file(src, limit=0)
        except SystemExit as e:
            store.mark_job(con, job_id, "failed", error=str(e)[:400])
            return
        (d / "source-cv.txt").write_text(cv_text, encoding="utf-8")

        jd_text = (d / "job-description.md").read_text(encoding="utf-8",
                                                        errors="ignore")

        kind = job["kind"]
        expected = {"cv": "CV.md", "cover_letter": "cover-letter.md"}[kind]

        try:
            draft = _call_gemini(
                _build_initial_prompt(kind, cv_text, jd_text, cfg_text))
        except Exception as e:
            store.mark_job(con, job_id, "failed",
                           error=f"Gemini call failed: {e}"[:400])
            return
        if not draft.strip():
            store.mark_job(con, job_id, "failed",
                           error="Gemini returned an empty response")
            return
        (d / expected).write_text(draft, encoding="utf-8")

        try:
            fixed = tidy_case((d / expected).read_text(encoding="utf-8"))
            if fixed != draft:
                (d / expected).write_text(fixed, encoding="utf-8")
        except OSError:
            pass

        # The exact same measurement runner.run_job() uses -- plain
        # subprocess calls to cv_signals.py / detect.py, never the model --
        # so a Gemini draft is held to the identical bar a Claude one is.
        ok, problems, scores = _quality(d, expected, kind)
        history = [f"attempt 1: {'clean' if ok else str(len(problems)) + ' problem(s)'}"
                  + (f", slop {scores['slop']}" if "slop" in scores else "")]
        out = f"drafted with Gemini ({GEMINI_MODEL}); no Claude Code involved.\n"
        for attempt in range(MAX_REVISIONS):
            if ok:
                break
            out += ("\n\nsent back for revision:\n"
                   + "\n".join(f"  {p}" for p in problems))
            current = (d / expected).read_text(encoding="utf-8")
            try:
                revised = _call_gemini(_build_revision_prompt(current, problems))
            except Exception as e:
                out += f"\n  revision failed: {e}; keeping the draft as it stands"
                break
            if not revised.strip():
                out += "\n  revision came back empty; keeping the draft as it stands"
                break
            (d / expected).write_text(revised, encoding="utf-8")
            was = len(problems)
            ok, problems, scores = _quality(d, expected, kind)
            history.append(
                f"attempt {attempt + 2}: "
                + ("clean" if ok else f"{len(problems)} problem(s)")
                + (f", slop {scores['slop']}" if "slop" in scores else ""))
            if not ok and len(problems) >= was:
                out += ("\n  revision did not improve it, so it stops here "
                       "rather than paying for the same answer again")
                break
        out += "\n\nquality loop: " + " -> ".join(history)
        if not ok:
            out += ("\n  still unresolved:\n"
                   + "\n".join(f"    {p}" for p in problems))

        _record(con, job, d, out)
        store.mark_job(con, job_id, "done", log=out)
    except Exception as e:                      # never leave a job stuck running
        store.mark_job(con, job_id, "failed", error=f"{type(e).__name__}: {e}"[:400])
    finally:
        con.close()
