"""Reading a CV file into plain text, shared by every part of the tool that
scores or drafts against it.

This used to live inside rank.py, because ranking was the first thing that
needed it. It stayed there after sponsor_check and the generator grew their
own need for the exact same read, which meant the one file every scoring path
depended on was named after a feature this tool no longer has. Moved out on
its own so that removing rank.py does not take CV reading with it.
"""

from __future__ import annotations

from pathlib import Path


def pdf_to_text(p: Path) -> str:
    """A PDF's text, if this machine has something that can extract it.

    No new dependency is added for this. The tool installs on `requests` and
    `PyYAML` and nothing else, and a CV is read once per run, so an optional
    import that fails into a clear message is a better trade than a parser
    of our own for a container format.

    Tries pypdf's "layout" extraction mode first, and falls back to its
    default mode when that is not available (older pypdf) or raises. This
    matters specifically for CVs: a two-column template or a skills table --
    both common on a CV, rare on a plain job posting -- reads out of order
    and often with the spaces between words dropped entirely in the default
    mode, which then fails the readability check below or scores every job
    against a CV whose words never separated. Layout mode keeps each column
    and cell in its own place on the page, which keeps the reading order and
    the word boundaries intact. Whatever this returns still goes through the
    same length and readability checks as before, so a genuinely empty or
    scanned (image-only) PDF is caught exactly as it already was.
    """
    try:
        from pypdf import PdfReader                        # noqa: PLC0415
    except ImportError:
        return ""
    try:
        reader = PdfReader(str(p))
        pages = []
        for page in reader.pages:
            try:
                text = page.extract_text(extraction_mode="layout")
            except TypeError:
                # This pypdf predates the `extraction_mode` argument.
                text = None
            if not text or not text.strip():
                text = page.extract_text()
            pages.append(text or "")
        return "\n".join(pages)
    except Exception:
        # An encrypted or malformed PDF is not a crash worth taking here;
        # the caller refuses with a message either way.
        return ""


def is_readable_text(text: str) -> bool:
    """Whether this is somebody's CV rather than the bytes of a file format.

    A NUL settles it on its own: `subprocess` refuses to exec an argument
    containing one, so a prompt built from this dies before the model sees
    it. Past that, the test is what share of the characters are the letters,
    spaces and punctuation a CV is made of. A Flate-compressed PDF stream
    read as UTF-8 scores far below this; text with accents, symbols and box
    drawing in it scores far above.
    """
    if "\x00" in text:
        return False
    sample = text[:4000]
    if not sample.strip():
        return False
    ok = sum(ch.isalnum() or ch.isspace() or ch in ",.;:'\"()[]{}/\\-–—&@+#%*!?|"
             for ch in sample)
    return ok / len(sample) >= 0.85


def read_cv_file(path, limit: int = 6000) -> str:
    """The CV's plain text, read from whatever format `path` points at.

    `limit` truncates the result -- ranking sent this to a model in every
    batch of a run, so its length was multiplied by the call count and 6000
    characters (a full two-page CV) was the right ceiling. The cover-letter
    and sponsor-check paths call this with a higher limit, or none, since
    each of them reads the CV exactly once.

    The path-taking half of what used to be one function keyed off `cfg`
    alone: the cover-letter drafter has an explicit CV file in hand (the one
    a role's own job folder was given), not necessarily the one in
    `cfg.cv_path`, and building a throwaway config object just to satisfy a
    function that only ever read one attribute off it was the wrong shape.
    `cv_text()` below is the `cfg.cv_path` convenience wrapper around this.
    """
    from .runner import docx_to_text
    # An empty or unset path is not "the current directory" -- `Path("")`
    # resolves to `.`, which always exists, so the `not p.exists()` check
    # below would never fire for it and this would fall through to opening
    # the current directory as if it were a file (IsADirectoryError, on the
    # platforms where that is even the failure rather than something worse).
    # Every real caller here is `cfg.cv_path` (which is "" when nobody has
    # configured or uploaded a CV) or an explicit CLI path, so this is a
    # real, reachable state, not a hypothetical one -- checked directly
    # instead of relying on `.exists()` to catch it.
    if not str(path or "").strip():
        raise SystemExit("No CV configured. Set cv.path in your config, "
                          "pass --cv, or upload one from the dashboard.")
    p = Path(path).expanduser()
    if not p.exists():
        raise SystemExit(f"No CV at {p}. Set cv.path in your config.")
    if p.is_dir():
        raise SystemExit(f"{p} is a directory, not a CV file.")
    suffix = p.suffix.lower()
    if suffix == ".docx":
        text = docx_to_text(p)
    elif suffix == ".pdf":
        # Read as UTF-8 with errors ignored -- which is what everything that
        # is not a .docx used to get -- a PDF yields thousands of characters
        # of `%PDF-1.4`, `/FlateDecode` and stream bytes. That cleared the
        # length guard below, so the file structure of the CV was sent as
        # the document every score was judged against, and the only reason
        # anybody found out is that one NUL byte in it made `subprocess`
        # refuse to launch.
        text = pdf_to_text(p)
        if not is_readable_text(text) or len(text.strip()) < 200:
            raise SystemExit(
                f"{p} is a PDF and its text could not be extracted.\n"
                f"Scoring or drafting against a PDF's file structure would "
                f"give you output with nothing behind it, so this stops "
                f"here.\nEither install an extractor (`pip install pypdf`) "
                f"and run this again, or point cv.path at a .docx or a "
                f".txt export of the same CV.")
    else:
        text = p.read_text(encoding="utf-8", errors="ignore")
    # `docx_to_text` returns "" on anything it cannot open, including a
    # permission error, so a file that exists is not proof of a CV that can
    # be read. Scoring or drafting against an empty CV would still produce
    # confident-looking output, judged against nothing. Fail instead.
    if len(text.strip()) < 200:
        raise SystemExit(
            f"Could not read a CV out of {p} (got {len(text.strip())} "
            f"characters). Scoring or drafting against an empty CV would "
            f"give you output with nothing behind it. Check the file opens, "
            f"and that this process can read it.")
    # Length was never the right question on its own. Any binary file read
    # with `errors="ignore"` clears the count above while containing none of
    # the candidate's career: `.doc`, `.rtf`, `.odt` and `.pages` all reach
    # this line, and a PDF did until the branch above existed. Ask whether
    # what came back is text.
    if not is_readable_text(text):
        raise SystemExit(
            f"{p} does not read as text ({p.suffix or 'no extension'}), so "
            f"what came out of it is the file's own structure rather than "
            f"your CV.\nScoring or drafting against that would give you "
            f"output with nothing behind it.\nExport the same CV as .docx "
            f"or .txt and point cv.path at that.")
    text = " ".join(text.split())
    return text[:limit] if limit else text


def cv_text(cfg, limit: int = 6000) -> str:
    """The CV's plain text, read from whatever format `cfg.cv_path` points
    at. The `cfg.cv_path` convenience wrapper around `read_cv_file()`, for
    every caller that already has a loaded config rather than an explicit
    file it was handed.
    """
    return read_cv_file(cfg.cv_path, limit=limit)
