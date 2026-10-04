"""A small local server so the dashboard can be worked from, not just read.

Standard library only: `http.server` and `sqlite3`. It binds to 127.0.0.1 and
runs while you are triaging, then stops. It is not a daemon and it is not
something to expose.

`scan` still writes the static file. This renders the same data with the
buttons live, from the same database, so the two cannot disagree.
"""



from __future__ import annotations

from . import sponsor_check as sc

import errno
import json
import re
import subprocess
import sys
import sqlite3
import tempfile
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import html as _h
from pathlib import Path
from urllib.parse import quote, urlparse

from . import runner, store
from .output import interactive

# Nothing this dashboard posts is large: the biggest body is a status plus a
# note. A Content-Length beyond this is a mistake, and reading it would be
# blocking on bytes that are not coming.
MAX_BODY = 1 << 20

# A CV upload is the one exception: it is a real document, base64-encoded
# (about a third more bytes than the file itself), and a two-page CV as a
# PDF or .docx can be a few hundred KB on its own. 8MB comfortably covers
# any real CV while still refusing anything that could not possibly be one.
CV_MAX_BODY = 8 << 20

# Extensions cvtext.read_cv_file() can actually turn into text.
CV_EXTENSIONS = {".pdf", ".docx", ".txt", ".md"}


# The most roles one bulk click will take.
#
# Not a technical limit: `MAX_RUNNING` is what bounds what actually runs, and
# the rest queue. This is a guard against a mis-click on "select all" over a
# four thousand row board turning into four thousand paid agent runs.
_MIME = {".pdf": "application/pdf", ".md": "text/markdown; charset=utf-8",
         ".txt": "text/plain; charset=utf-8",
         ".docx": ("application/vnd.openxmlformats-officedocument"
                   ".wordprocessingml.document")}


def _download_name(company: str, title: str, kind: str, suffix: str) -> str:
    """A filename you can find in a folder of downloads.

    Every generated CV is called CV.pdf on disk, which is fine in a directory
    named after the role and useless in ~/Downloads, where three of them
    become CV.pdf, CV (1).pdf and CV (2).pdf. The employer and the role go in
    front so the picker's own list is enough.
    """
    what = {"cv": "CV", "cover_letter": "Cover-letter",
            "screen": "Screening"}.get(kind, kind)
    def slug(s, n):
        s = re.sub(r"[^\w\s-]", "", s or "").strip()
        s = re.sub(r"[\s_]+", "-", s)
        return s[:n].strip("-")
    parts = [p for p in (slug(company, 28), slug(title, 40), what) if p]
    return "-".join(parts) + suffix


BULK_LIMIT = 40


class Handler(BaseHTTPRequestHandler):
    db_path = None
    docs_base = None
    config_path = None
    # The host `serve()` was asked to bind to, so `_expected_hosts` can accept
    # the name the browser will actually send. Empty means loopback only,
    # which is what every test and the default both want.
    bind_host = ""
    # `salary.currency` from the config, so the salary sort groups by the
    # currency the FLOOR is in rather than by whichever one happens to be
    # commonest on the board. Read once at startup: it cannot change while
    # the process runs, and re-reading it per request would put a file read
    # on the page load.
    home_currency = ""

    # Set by /api/cv when someone uploads a CV through the dashboard.
    # In-memory only, for the running process -- it is not written back into
    # config.yaml, so it does not survive a restart (the upload response
    # says so). A class attribute, not per-request, because it needs to
    # outlive the request that set it and there is only one config in play
    # for the life of this server.
    uploaded_cv_path: str | None = None

    # ------------------------------------------------------------- helpers
    def _resolve_uploaded_cv(self) -> str | None:
        """The uploaded CV's path, if there is one -- checking disk, not
        just memory.

        `Handler.uploaded_cv_path` is set the moment someone uploads through
        `/api/cv`, but it is a class attribute and resets to None whenever
        this process restarts (closing and reopening the dashboard, a crash,
        an update). The uploaded file itself survives on disk regardless
        (`_upload_cv` writes it to a stable `uploaded-cv.<ext>` name), so a
        restart used to silently forget the upload and quietly fall back to
        `cv.path` again -- exactly the kind of "worked once, then went dead"
        gap this exists to close. Every caller that needs the uploaded CV
        (scanning, sponsor-check, cover-letter generation) should go through
        this rather than reading the class attribute directly.
        """
        if Handler.uploaded_cv_path:
            return Handler.uploaded_cv_path
        matches = sorted(self._cv_dir().glob("uploaded-cv.*"))
        if matches:
            Handler.uploaded_cv_path = str(matches[0])
        return Handler.uploaded_cv_path

    def _load_cfg(self):
        """The config for this request, with an uploaded CV (if any)
        overriding whatever `cv.path` says on disk. Every handler that needs
        a Config should go through this rather than calling `config.load()`
        directly, so an uploaded CV actually gets used everywhere a CV is
        read for.
        """
        from .config import load as load_cfg
        cfg = load_cfg(self.config_path) if self.config_path else load_cfg()
        uploaded = self._resolve_uploaded_cv()
        if uploaded:
            cfg.cv_path = uploaded
        return cfg
    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self._answered = True
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _html(self, text):
        body = text.encode("utf-8")
        self._answered = True
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        # This page is rebuilt from the live database on every request, so a
        # cached copy is never merely stale, it is actively wrong: a reload
        # right after a delete or a scan can otherwise hand back the exact
        # bytes from before either happened, showing roles that are gone or
        # missing ones that just arrived, with no way to tell that is what
        # happened.
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        """The posted JSON object, or {} if there is not one.

        Everything here is defensive for the same reason: an exception thrown
        out of a handler is not an error message, it is a dropped connection.
        The browser's `fetch` rejects, the click does nothing, and the page
        says nothing, which is indistinguishable from a button that is not
        wired up. So a body that is not an object, or a Content-Length that is
        not a number, becomes {} and the handler's own validation answers with
        a sentence.
        """
        raw = self.headers.get("Content-Length") or "0"
        try:
            n = int(raw)
        except ValueError:
            return {}
        if n <= 0 or n > MAX_BODY:
            return {}
        try:
            data = json.loads(self.rfile.read(n) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            return {}
        # `json.loads('[]')` and `json.loads('"hi"')` are both valid JSON and
        # neither has `.get`. Reaching `data.get("uid")` on one raised
        # AttributeError inside the handler and dropped the connection.
        return data if isinstance(data, dict) else {}

    def log_message(self, *a):
        pass                      # the scan output is the interesting log

    # ------------------------------------------------------------- routing
    #
    # Every request runs inside this. Four separate defects here all had the
    # same shape and the same symptom -- a malformed body, an unhashable
    # `kind`, a note that was not a string, and a write that lost a race with
    # a scan -- and each one killed the connection instead of answering:
    # http.server writes no status line when a handler raises, so the
    # browser's `fetch` rejected and the page said nothing at all. A click
    # that did nothing and a click that failed looked identical, and the one
    # that failed had usually just lost a status change.
    #
    # Wrapped here rather than around each `do_*` so there is one place that
    # cannot be forgotten, and so a handler added later gets it for free.
    def handle_one_request(self):
        self._answered = False
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            # The browser closed or reset the connection out from under a
            # response already being written -- a reload while a poll was
            # in flight, a tab closed, a laptop going to sleep. The
            # dashboard polls every few seconds, so this fires constantly on
            # ordinary use and on Windows shows up as WinError 10053. It is
            # not a bug in this tool, there is no one left to answer, and it
            # is not worth a traceback on every occurrence -- so unlike the
            # branch below, this is never re-raised.
            self.close_connection = True
        except Exception as e:
            if getattr(self, "_answered", False):
                raise            # too late to answer; let the server log it
            locked = (isinstance(e, sqlite3.OperationalError)
                      and ("locked" in str(e).lower() or "busy" in str(e).lower()))
            if locked:
                # The one failure here with an obvious cause and an obvious
                # thing to do about it: a scan holds the write lock while it
                # updates the board, and 15 seconds was not long enough.
                msg = ("the database is busy, most likely a scan is writing "
                       "to it. Nothing was saved. Try again in a moment.")
                code = 503
            else:
                msg = f"{type(e).__name__}: {e}"[:300]
                code = 500
            self.close_connection = True
            try:
                self._json({"ok": False, "error": msg}, code)
            except OSError:
                pass             # the client went away mid-answer

    def do_GET(self):
        # Reads were exempt from this and should not have been.
        #
        # The Host check exists to stop DNS rebinding, and it was only on the
        # POSTs and on /open. So a page on evil.example that had rebound its
        # own name to 127.0.0.1 could not WRITE anything -- but it could ask
        # for `/` and `/api/jobs` same-origin, and read back the whole board:
        # every employer, every application status, the private note on each
        # role, the fit scores, the text of every screening, and the paths of
        # the generated documents under ~/job-applications. For someone job
        # hunting out of a current job that is the most sensitive thing this
        # tool holds, and it was the one page not behind the check.
        #
        # Verified by sending `Host: evil.example:PORT` to `/`: 200 and the
        # full dashboard before this, 403 after.
        if not self._same_origin():
            return self._json(
                {"ok": False, "error": "cross-origin request refused"}, 403)
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            con = store.connect(self.db_path)
            try:
                return self._html(
                    interactive.render(con, self.home_currency))
            finally:
                con.close()
        
        if path == "/api/sponsor-check":
            con = store.connect(self.db_path)
            try:
                rows = sc.candidates(con)
                return self._json({
                    "pending": len(rows),
                    "state": store.get_meta(con, "sc_state", "idle"),
                    "done": int(store.get_meta(con, "sc_done", "0") or 0),
                    "total": int(store.get_meta(con, "sc_total", "0") or 0),
                    "error": store.get_meta(con, "sc_error", "") or "",
                    "checked": con.execute(
                        "SELECT COUNT(*) c FROM roles WHERE sc_legitimacy>=0"
                    ).fetchone()["c"],
                })
            finally:
                con.close()

        if path == "/api/scan":
            con = store.connect(self.db_path)
            try:
                return self._json({
                    "state": store.get_meta(con, "scan_state", "idle"),
                    "done": int(store.get_meta(con, "scan_done", "0") or 0),
                    "total": int(store.get_meta(con, "scan_total", "0") or 0),
                    # Which phase is running right now, and (only meaningful
                    # during that phase) how far the enrichment pass has
                    # got. Fetching sources is one phase of several -- a
                    # scan is still working after every source has been
                    # read, and without this the dashboard sat at
                    # "total/total sources checked" for however long
                    # enrichment and sponsor-check took, reading as stuck.
                    "stage": store.get_meta(con, "scan_stage", ""),
                    "enrich_done": int(store.get_meta(con, "enrich_done", "0") or 0),
                    "enrich_total": int(store.get_meta(con, "enrich_total", "0") or 0),
                    # The last scan process's exit code, once it is known --
                    # "" while none has run yet or one is still running.
                    # `scan_state` going back to "idle" happens identically
                    # on a clean finish and on a crash a few seconds in, so
                    # on its own it cannot tell those apart; this can. A
                    # non-"0" value here means the scan did not finish
                    # cleanly even though the button re-enabled.
                    "exit_code": store.get_meta(con, "scan_exit_code", ""),
                    "log_open_error": store.get_meta(con, "scan_log_open_error", ""),
                })
            finally:
                con.close()

        if path == "/api/scan/log":
            # The tail of the last scan's actual console output -- what it
            # said about sources read, what it skipped and why, what
            # sponsor-check found. A scan launched from this dashboard used
            # to throw all of that away; this is how the "is it actually
            # doing anything" question gets a real answer instead of a
            # guess from how fast the button re-enabled.
            #
            # The path actually used is read back from the database rather
            # than recomputed, because `_spawn_scan` falls back to the OS
            # temp directory when the primary location can't be opened for
            # writing (a permissions problem, an unusual path) -- recomputing
            # the primary path here would always miss that fallback and show
            # "no log" for a scan that in fact wrote one, just not where
            # this would have assumed.
            con = store.connect(self.db_path)
            try:
                recorded = store.get_meta(con, "scan_log_path", "")
                open_err = store.get_meta(con, "scan_log_open_error", "")
            finally:
                con.close()
            log_path = Path(recorded) if recorded else scan_log_path(self.db_path)
            try:
                text = log_path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                text = ""
            if open_err and not text:
                text = (f"! the scan's own log file could not be created: "
                        f"{open_err}\nWhatever this scan printed has been "
                        f"lost. If this keeps happening, check that the "
                        f"database's folder is writable.")
            elif open_err:
                text = (f"! could not write the log next to your database "
                        f"({open_err}), so this is from a fallback location "
                        f"instead ({log_path}). The scan itself ran fine.\n\n"
                        f"{text}")
            tail = text[-6000:]
            return self._json({"log": tail, "truncated": len(text) > len(tail)})

        if path == "/api/description":
            from urllib.parse import parse_qs
            q = parse_qs(urlparse(self.path).query)
            uid = (q.get("uid") or [""])[0]
            if not uid:
                return self._json({"ok": False, "error": "no uid given"}, 400)
            con = store.connect(self.db_path)
            try:
                row = con.execute(
                    "SELECT description FROM roles WHERE uid=?", (uid,)).fetchone()
                if row is None:
                    return self._json({"ok": False, "error": "no such role"}, 404)
                return self._json({"ok": True,
                                   "description": row["description"] or ""})
            finally:
                con.close()


        if path == "/api/jobs":
            con = store.connect(self.db_path)
            try:
                # Two things were wrong with the obvious version of this
                # comparison, and together they made a failed job re-assert
                # its error onto the row for the rest of the day. So after a
                # fix, the dashboard kept showing the old failure and it
                # looked like nothing had been fixed.
                #
                #   * finished_at is written by Python as "...T13:59:13" while
                #     SQLite's datetime() returns "... 13:59:13". Comparing
                #     them as strings compares "T" against " ", and "T" always
                #     wins, so every job finished today looked recent.
                #   * datetime('now') is UTC; the stored value is local.
                rows = con.execute(
                    # `started_at` travels so the browser can show elapsed
                    # time. A spinner with no clock on an eight minute job is
                    # the same failure as a page that paints nothing for a
                    # second: it reads as hung, and the reader kills work that
                    # was going fine.
                    "SELECT id,uid,kind,state,error,started_at FROM jobs "
                    "WHERE state IN ('pending','running') OR "
                    "replace(finished_at,'T',' ') > "
                    "datetime('now','localtime','-2 minutes')").fetchall()
                arts = con.execute(
                    "SELECT uid,kind,path,rating,summary FROM artifacts").fetchall()
                states = con.execute("SELECT uid,status FROM role_state").fetchall()
                return self._json({
                    "jobs": [dict(r) for r in rows],
                    # Per kind, and only the kinds actually in flight, so a
                    # quiet poll stays a small answer.
                    "typical": {k: store.typical_seconds(con, k)
                                for k in {r["kind"] for r in rows}},
                    "now": store._now(),
                    "artifacts": [dict(r) for r in arts],
                    "states": {r["uid"]: r["status"] for r in states},
                })
            finally:
                con.close()
        if path.startswith("/download"):
            # Serve the document as a download rather than revealing it in
            # Finder.
            #
            # `open -R` puts a Finder window in front of you, which is the
            # right answer when you want to look at the file and the wrong one
            # when you are about to attach it: Chrome's upload dialog does not
            # know about that window, so you are hunting through ninety
            # `2026-09-01-company-role-hash` folders for `CV.pdf`. A download
            # lands in ~/Downloads, which is where the picker already opens.
            #
            # The name matters as much as the route. Every generated CV is
            # called CV.pdf, so downloading three of them gives you CV.pdf,
            # CV (1).pdf and CV (2).pdf, and the picker's most useful column
            # tells you nothing. The employer and the role go in the filename.
            if not self._same_origin():
                return self._json(
                    {"ok": False, "error": "cross-origin request refused"}, 403)
            from urllib.parse import parse_qs, unquote
            q = parse_qs(urlparse(self.path).query)
            p = Path(unquote((q.get("path") or [""])[0] or ""))
            con = store.connect(self.db_path)
            try:
                row = con.execute(
                    "SELECT a.kind, r.company, r.title FROM artifacts a "
                    "JOIN roles r ON r.uid = a.uid WHERE a.path=? LIMIT 1",
                    (str(p),)).fetchone()
            finally:
                con.close()
            # The same allowlist by construction as /open: the path has to be
            # one already recorded in `artifacts`, so no amount of traversal
            # in the query string reaches anything else on the disk.
            if not row:
                return self._json(
                    {"ok": False,
                     "error": "that is not a document this tool made"}, 403)
            if not p.exists():
                return self._json({"ok": False, "error": "not found"}, 404)
            try:
                blob = p.read_bytes()
            except OSError as e:
                return self._json({"ok": False, "error": str(e)}, 500)
            name = _download_name(row["company"], row["title"], row["kind"],
                                  p.suffix)
            self.send_response(200)
            self.send_header("Content-Type", _MIME.get(p.suffix.lower(),
                                                       "application/octet-stream"))
            # ASCII only in the quoted form: a header is latin-1 and an
            # employer called "Nestlé" would raise inside the handler and drop
            # the connection. RFC 5987 carries the real one beside it.
            ascii_name = name.encode("ascii", "ignore").decode() or "document"
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{ascii_name}"; '
                f"filename*=UTF-8''{quote(name)}")
            self.send_header("Content-Length", str(len(blob)))
            self.end_headers()
            self.wfile.write(blob)
            return

        if path.startswith("/open"):
            # Checked like a POST. It is a GET, but it runs `open -R` on a
            # path from the query string, so any page in the browser could
            # have pointed it at anything on the disk.
            if not self._same_origin():
                return self._json(
                    {"ok": False, "error": "cross-origin request refused"}, 403)
            # Reveal a generated document in Finder rather than serving it.
            import subprocess
            from urllib.parse import parse_qs, unquote
            q = parse_qs(urlparse(self.path).query)
            target = (q.get("path") or [""])[0]
            p = Path(unquote(target)) if target else None
            # Only documents this tool made. An allowlist by construction:
            # the path has to be one already recorded in `artifacts`, so no
            # amount of traversal in the query string reaches anything else.
            if p is not None:
                con = store.connect(self.db_path)
                try:
                    known = con.execute(
                        "SELECT 1 FROM artifacts WHERE path=? LIMIT 1",
                        (str(p),)).fetchone()
                finally:
                    con.close()
                if not known:
                    return self._json(
                        {"ok": False,
                         "error": "that is not a document this tool made"}, 403)
            if p and not p.exists():
                # The file moved or was deleted. The text is in the database,
                # so show that rather than telling someone a document they
                # paid for is gone.
                con = store.connect(self.db_path)
                try:
                    row = con.execute(
                        "SELECT body,kind FROM artifacts WHERE path=? AND "
                        "COALESCE(body,'')<>'' ORDER BY id DESC LIMIT 1",
                        (str(p),)).fetchone()
                finally:
                    con.close()
                if row:
                    return self._html(
                        "<pre style='white-space:pre-wrap;font:14px/1.6 "
                        "ui-monospace,monospace;max-width:44rem;margin:3rem auto;"
                        "padding:0 1.5rem'>"
                        f"<b>{_h.escape(p.name)} is no longer on disk. This is "
                        f"the copy kept in the database.</b>\n\n"
                        f"{_h.escape(row['body'])}</pre>")
            if p and p.exists():
                # check=False does not suppress FileNotFoundError, so on a
                # machine without `open` this raised inside the handler and
                # dropped the connection.
                import sys as _sys
                cmds = ([["open", "-R", str(p)]] if _sys.platform == "darwin"
                        else [["xdg-open", str(p.parent)], ["explorer", str(p.parent)]])
                for c in cmds:
                    try:
                        subprocess.run(c, check=False)
                        return self._json({"ok": True})
                    except (FileNotFoundError, OSError):
                        continue
                return self._json({"ok": False,
                                   "error": f"could not reveal it; the file is at {p}"})
            return self._json({"ok": False, "error": "not found"}, 404)
        self.send_error(404)

    def _expected_hosts(self) -> set[str]:
        """The names this server is allowed to be reached by.

        The loopback names, plus whatever `--host` was actually given. Without
        the last one, `job-radar serve --host 0.0.0.0` opened the browser at
        `http://0.0.0.0:8765/`, and every write from that page was refused with
        "cross-origin request refused" -- a flag that silently broke the
        buttons. It is not a hole: a rebinding attack needs the ATTACKER's
        name in Host, and that is a name the person running this never typed.
        """
        port = self.server.server_address[1]
        allowed = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}
        if self.bind_host:
            allowed.add(f"{self.bind_host}:{port}")
        return allowed

    def _same_origin(self) -> bool:
        """Reject cross-site posts, and reject rebinding.

        This server spends money. Without a check, any page open in the same
        browser could POST to /api/generate, and a text/plain body is a simple
        request so there is no preflight to stop it.

        Comparing Origin to Host was not enough. Both headers are attacker
        controlled together: a page on evil.example that has rebound its own
        DNS to 127.0.0.1 sends Origin: http://evil.example and Host:
        evil.example, they match, and the request went through to
        /api/generate. So Host is checked against what this server actually
        bound to, and Origin against the same set.
        """
        host = self.headers.get("Host", "")
        allowed = self._expected_hosts()
        if host not in allowed:
            return False
        origin = self.headers.get("Origin")
        if origin is None:
            return True                      # curl and same-origin form posts
        return origin.split("//")[-1] in allowed

    def _start_generation(self, con, uid, kind):
        """Queue one role. Returns (job_id, "") or (None, reason).

        Shared by the single button and the bulk one so a role cannot be
        accepted by one path and refused by the other. Every check here is a
        refusal that costs nothing; the thing being guarded costs money.
        """
        # A cover letter used to require a CV drafted through this tool
        # first, so the letter could be checked against it for repeated
        # phrasing. CV drafting is no longer offered here (the user supplies
        # their own CV -- see /api/cv), so there is no CV.md to require or
        # to check overlap against any more; the letter is still drafted
        # against the source CV text itself (cvtext.read_cv_file()).
        if kind in ("cv", "cover_letter"):
            # A CV drafted against "_No description available from this
            # source._" is a full agent run, a rating, and a document
            # tailored to nothing. ("screen" used to be checked here too,
            # before it moved to sponsor_check, which is free and handles
            # an empty description gracefully on its own.)
            row = con.execute("SELECT description FROM roles WHERE uid=?",
                              (uid,)).fetchone()
            if row is None:
                return None, "no such role"
            if len((row["description"] or "").strip()) < 200:
                return None, ("this posting has no description, so there is "
                              "nothing to screen. Open the advert instead.")
        # Queue it, then let the pump decide what runs. The cap belongs on
        # what is RUNNING, not on what may be asked for: it used to sit here,
        # so nine selected roles became three started and six refused while
        # the dialog that took the click promised the rest would queue.
        #
        # `enqueue` is idempotent per role and kind, so a double-click returns
        # the same job rather than a second one writing the same folder.
        job_id = store.enqueue(con, uid, kind)
        con.commit()
        runner.pump(db_path=self.db_path, base=self.docs_base,
                    config_path=self.config_path,
                    cv_source=self._resolve_uploaded_cv())
        return job_id, ""

    def _cv_dir(self) -> Path:
        """Where an uploaded CV is written. Next to the config file, since
        that is the one stable, writable location this tool already knows
        about -- the same directory `cv.path` in config.yaml is normally
        relative to.
        """
        if self.config_path:
            return Path(self.config_path).expanduser().resolve().parent
        from . import config as config_mod
        return config_mod.resolve().expanduser().resolve().parent

    def _upload_cv(self):
        """POST /api/cv -- upload a CV from the dashboard.

        Body is JSON: {"filename": "cv.pdf", "data": "<base64>"}. Written
        atomically (write-then-rename, via state.atomic_write_bytes) to a
        stable `uploaded-cv<ext>` file next to the config, validated with
        the exact reader every scoring/drafting path already uses
        (cvtext.read_cv_file), and then swapped in as the running config's
        cv_path for the rest of this process -- in memory only; it is not
        written back into config.yaml, so it will not survive a restart
        unless cv.path is also updated there by hand.
        """
        raw = self.headers.get("Content-Length") or "0"
        try:
            n = int(raw)
        except ValueError:
            return self._json({"ok": False, "error": "bad Content-Length"}, 400)
        if n <= 0:
            return self._json({"ok": False, "error": "empty request"}, 400)
        if n > CV_MAX_BODY:
            # Still have to read (and discard) the bytes: leaving them on the
            # socket unread corrupts whatever request comes after this one.
            remaining = n
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 1 << 16))
                if not chunk:
                    break
                remaining -= len(chunk)
            return self._json(
                {"ok": False,
                 "error": f"that file is too big ({n:,} bytes encoded; "
                          f"{CV_MAX_BODY:,} is the most this will take)"}, 413)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
            return self._json({"ok": False, "error": "bad request body"}, 400)
        if not isinstance(body, dict):
            return self._json({"ok": False, "error": "bad request body"}, 400)

        filename = body.get("filename")
        if not isinstance(filename, str) or not filename.strip():
            return self._json({"ok": False, "error": "no filename given"}, 400)
        ext = Path(filename).suffix.lower()
        if ext not in CV_EXTENSIONS:
            return self._json(
                {"ok": False,
                 "error": f"{ext or '(no extension)'} isn't a CV format this "
                          f"tool can read. Use one of: "
                          f"{', '.join(sorted(CV_EXTENSIONS))}."}, 400)

        b64 = body.get("data")
        if not isinstance(b64, str) or not b64.strip():
            return self._json({"ok": False, "error": "no file data given"}, 400)
        import base64
        try:
            raw_bytes = base64.b64decode(b64, validate=False)
        except (ValueError, TypeError):
            return self._json({"ok": False, "error": "file data isn't valid base64"}, 400)
        if not raw_bytes:
            return self._json({"ok": False, "error": "the uploaded file is empty"}, 400)

        from .state import atomic_write_bytes
        target = self._cv_dir() / f"uploaded-cv{ext}"
        try:
            atomic_write_bytes(target, raw_bytes)
        except OSError as e:
            return self._json(
                {"ok": False, "error": f"could not save the file: {e}"}, 500)

        # Validated with the same reader every scoring and drafting path
        # already goes through, so "accepted" here means "usable there" --
        # not merely "the bytes made it to disk".
        from . import cvtext
        try:
            cvtext.read_cv_file(target, limit=0)
        except SystemExit as e:
            try:
                target.unlink()
            except OSError:
                pass
            return self._json({"ok": False, "error": str(e)}, 400)

        # Only one uploaded CV is live at a time. A previous upload in a
        # different format would otherwise sit there forever, unused but
        # easy to mistake for the current one.
        for other in self._cv_dir().glob("uploaded-cv.*"):
            if other != target:
                try:
                    other.unlink()
                except OSError:
                    pass

        Handler.uploaded_cv_path = str(target)
        return self._json({
            "ok": True,
            "message": f"CV uploaded ({filename}). This is now the CV used "
                       f"for scanning, sponsor-check and every cover letter "
                       f"-- it overrides cv.path in your config, and stays "
                       f"in effect even after you close and reopen the "
                       f"dashboard, until you upload a different one.",
            "path": str(target)})

    def do_POST(self):
        if not self._same_origin():
            return self._json({"ok": False, "error": "cross-origin request refused"}, 403)
        path = urlparse(self.path).path

        if path == "/api/cv":
            # Handled before the generic body reader below: a CV can be
            # several times MAX_BODY once base64-encoded, and `_body()`
            # silently drops (without reading) anything past that limit,
            # which would leave the extra bytes sitting unread on the
            # socket. This reads the body itself, with its own larger cap.
            return self._upload_cv()

        data = self._body()

        if path == "/api/scan":
            con = store.connect(self.db_path)
            try:
                if store.get_meta(con, "scan_state", "idle") == "running":
                    return self._json({"ok": False, "error": "already scanning"}, 429)
            finally:
                con.close()
            ok, err = _spawn_scan(self.db_path, self.config_path,
                                   self._resolve_uploaded_cv())
            if not ok:
                return self._json({"ok": False, "error": err}, 500)
            return self._json({"ok": True})

        if path == "/api/cleanup-and-rescan":
            con = store.connect(self.db_path)
            try:
                if store.get_meta(con, "scan_state", "idle") == "running":
                    return self._json({"ok": False, "error": "already scanning"}, 429)
                placeholders = ",".join("?" * len(store.IN_FLIGHT))
                rows = con.execute(
                    f"SELECT r.uid FROM roles r LEFT JOIN role_state s "
                    f"ON s.uid=r.uid WHERE COALESCE(s.status,'new') "
                    f"NOT IN ({placeholders})",
                    tuple(store.IN_FLIGHT)).fetchall()
                uids = [r["uid"] for r in rows]
                for uid in uids:
                    con.execute("DELETE FROM roles WHERE uid=?", (uid,))
            finally:
                con.close()

            ok, err = _spawn_scan(self.db_path, self.config_path,
                                   self._resolve_uploaded_cv())
            if not ok:
                return self._json({
                    "ok": True, "deleted": len(uids), "scan_started": False,
                    "error": f"deleted {len(uids)} roles, but couldn't "
                             f"start a scan: {err}"})
            return self._json({"ok": True, "deleted": len(uids),
                               "scan_started": True})

        if path == "/api/sponsor-check/stop":
            con = store.connect(self.db_path)
            try:
                if store.get_meta(con, "sc_state", "idle") != "running":
                    return self._json({"ok": False, "error": "not running"}, 409)
                store.set_meta(con, "sc_cancel", "1")
            finally:
                con.close()
            return self._json({"ok": True,
                               "message": "stopping after the current role"})
    
        if path == "/api/sponsor-check":
            con = store.connect(self.db_path)
            try:
                if not store.claim(con, "sponsor_check"):
                    return self._json(
                        {"ok": False, "error": "already checking"}, 429)
                try:
                    rows = sc.candidates(con, refresh=bool(data.get("refresh")))
                    if not rows:
                        store.release(con, "sponsor_check")
                        return self._json(
                            {"ok": False,
                             "error": "every role already has a sponsor-check "
                                      "result"}, 409)
                    store.set_meta(con, "sc_state", "running")
                    store.set_meta(con, "sc_total", str(len(rows)))
                    store.set_meta(con, "sc_done", "0")
                    store.set_meta(con, "sc_cancel", "")
                    store.set_meta(con, "sc_error", "")
                except BaseException:
                    _abandon_sponsor_check(con)
                    raise
            finally:
                con.close()
            _spawn_sponsor_check(self.db_path, self.config_path,
                                refresh=bool(data.get("refresh")),
                                cv_path=self._resolve_uploaded_cv())
            return self._json({"ok": True, "roles": len(rows)})
    

        if path == "/api/generate/bulk":
            con = store.connect(self.db_path)
            try:
                # One request, many roles, and a per-role answer. A bulk
                # button that returns a single ok/failed is unusable: a
                # shortlist where two roles have no description and one is
                # already running has to say WHICH, or the reader has to open
                # forty rows to find out what actually started.
                kind = data.get("kind")
                if kind == "cv":
                    # CV drafting from scratch is no longer offered: the user
                    # supplies their own CV (see /api/cv) and this tool only
                    # drafts the cover letter around it. The underlying "cv"
                    # kind still exists in runner/gemini_generate so nothing
                    # downstream that reads it breaks, it is just no longer
                    # reachable from here.
                    return self._json(
                        {"ok": False,
                         "error": "CV drafting isn't offered any more -- "
                                  "upload your own CV and generate a cover "
                                  "letter instead"}, 400)
                if not isinstance(kind, str) or kind not in runner.KINDS:
                    return self._json({"ok": False, "error": "bad kind"}, 400)
                uids = data.get("uids")
                if not isinstance(uids, list) or not uids:
                    return self._json(
                        {"ok": False, "error": "no roles selected"}, 400)
                if len(uids) > BULK_LIMIT:
                    return self._json(
                        {"ok": False,
                         "error": f"{len(uids)} roles asked for at once; "
                                  f"{BULK_LIMIT} is the most this will take "
                                  f"in one go"}, 400)
                if kind == "screen":
                    # sponsor_check is instant and free, so bulk-screen runs
                    # synchronously here rather than through the paid
                    # Claude queue -- same per-role logic
                    # /api/sponsor-check/screen uses, just looped. Without
                    # this special case, "Screen selected" silently fell
                    # through to the old Claude path even after the
                    # per-role Screen button had already moved off it.
                    try:
                        cfg = self._load_cfg()
                    except Exception as e:
                        return self._json(
                            {"ok": False, "error": f"could not load config: {e}"}, 500)
                    registers = sc.load_registers()
                    cv_text, cv_meta = "", None
                    try:
                        from . import cvtext
                        cv_text = cvtext.cv_text(cfg, limit=0)
                        cv_meta = sc._cv_meta_for(cfg)
                    except SystemExit:
                        pass  # proceed without a CV
                    accepted, skipped = [], []
                    for one in uids:
                        if not isinstance(one, str):
                            continue
                        row = con.execute(
                            "SELECT * FROM roles WHERE uid=?", (one,)).fetchone()
                        if not row:
                            skipped.append({"uid": one, "why": "no such role"})
                            continue
                        job = {"title": row["title"] or "",
                              "company": row["company"] or "",
                              "location": row["location"] or "",
                              "description": row["description"] or ""}
                        result = sc.evaluate_job(job, registers, cv_text, cv_meta)
                        sc.record(con, one, result)
                        summary = sc.screen_summary(result["recommendation"])
                        body = sc.screening_markdown(result)
                        store.add_artifact(
                            con, one, "screen", path="",
                            rating=result["recommendation"].get("score"),
                            summary=summary, gates={}, body=body)
                        accepted.append(one)
                    return self._json({"ok": True, "kind": kind,
                                       "queued": accepted, "started": accepted,
                                       "running": 0, "skipped": skipped})

                accepted, skipped = [], []
                for one in uids:
                    if not isinstance(one, str):
                        continue
                    job, why = self._start_generation(con, one, kind)
                    if job:
                        accepted.append(one)
                    else:
                        skipped.append({"uid": one, "why": why})
                running = len(store.busy_uids(con))
                return self._json({"ok": True, "kind": kind,
                                   "queued": accepted, "started": accepted,
                                   "running": running,
                                   "skipped": skipped})
            finally:
                con.close()

        uid = data.get("uid")
        # An unknown uid used to raise inside the handler and drop the
        # connection, so the browser's fetch rejected and the click silently
        # did nothing. A missing uid inserted a NULL row, because SQL foreign
        # keys ignore NULL.
        if not isinstance(uid, str) or not uid:
            return self._json({"ok": False, "error": "a role id is required"}, 400)
        con = store.connect(self.db_path)
        try:
            if not con.execute("SELECT 1 FROM roles WHERE uid=?", (uid,)).fetchone():
                return self._json({"ok": False, "error": "no such role"}, 404)
            if path == "/api/sponsor-check/screen":
                row = con.execute("SELECT * FROM roles WHERE uid=?",
                                  (uid,)).fetchone()
                job = {"title": row["title"] or "", "company": row["company"] or "",
                      "location": row["location"] or "",
                      "description": row["description"] or ""}
                try:
                    cfg = self._load_cfg()
                except Exception as e:
                    return self._json(
                    {"ok": False, "error": f"could not load config: {e}"}, 500)
                registers = sc.load_registers()
                cv_text, cv_meta = "", None
                try:
                    from . import cvtext
                    cv_text = cvtext.cv_text(cfg, limit=0)
                    cv_meta = sc._cv_meta_for(cfg)
                except SystemExit:
                    pass  # proceed without a CV; cv_fit reports "No CV uploaded yet"
                result = sc.evaluate_job(job, registers, cv_text, cv_meta)
                sc.record(con, uid, result)
                summary = sc.screen_summary(result["recommendation"])
                body = sc.screening_markdown(result)
                store.add_artifact(con, uid, "screen", path="",
                                   rating=result["recommendation"].get("score"),
                                   summary=summary, gates={}, body=body)
                return self._json({"ok": True, "summary": summary})
          
            if path == "/api/status":
                status = data.get("status", "")
                if not isinstance(status, str) or status not in store.STATUSES:
                    return self._json({"ok": False, "error": "bad status"}, 400)
                # None means "not supplied, keep the note that is there"; a
                # string means "use this one, even if it is empty". Anything
                # else is neither, and sqlite refused to bind it: the request
                # died with no response and the click did nothing.
                note = data.get("note")
                if note is not None and not isinstance(note, str):
                    return self._json(
                        {"ok": False, "error": "a note has to be text"}, 400)
                store.set_status(con, uid, status, note)
                return self._json({"ok": True, "uid": uid, "status": status})

            if path == "/api/generate":
                kind = data.get("kind")
                if kind == "cv":
                    # See the matching check in /api/generate/bulk: CV
                    # drafting from scratch is no longer offered.
                    return self._json(
                        {"ok": False,
                         "error": "CV drafting isn't offered any more -- "
                                  "upload your own CV and generate a cover "
                                  "letter instead"}, 400)
                # `kind not in runner.KINDS` hashes `kind`, so a list or a
                # dict raised TypeError rather than answering "bad kind".
                if not isinstance(kind, str) or kind not in runner.KINDS:
                    return self._json({"ok": False, "error": "bad kind"}, 400)
                if kind == "screen":
                    # Defense in depth: the dashboard's own JS intercepts
                    # kind==='screen' before it ever reaches this endpoint
                    # (see the click handler), but anything else that calls
                    # /api/generate directly with kind="screen" should still
                    # get the free sponsor_check path, not the old paid
                    # Claude queue. Same logic as /api/sponsor-check/screen.
                    row = con.execute(
                        "SELECT * FROM roles WHERE uid=?", (uid,)).fetchone()
                    job = {"title": row["title"] or "",
                          "company": row["company"] or "",
                          "location": row["location"] or "",
                          "description": row["description"] or ""}
                    try:
                        cfg = self._load_cfg()
                    except Exception as e:
                        return self._json(
                            {"ok": False, "error": f"could not load config: {e}"}, 500)
                    registers = sc.load_registers()
                    cv_text, cv_meta = "", None
                    try:
                        from . import cvtext
                        cv_text = cvtext.cv_text(cfg, limit=0)
                        cv_meta = sc._cv_meta_for(cfg)
                    except SystemExit:
                        pass
                    result = sc.evaluate_job(job, registers, cv_text, cv_meta)
                    sc.record(con, uid, result)
                    summary = sc.screen_summary(result["recommendation"])
                    body = sc.screening_markdown(result)
                    store.add_artifact(
                        con, uid, "screen", path="",
                        rating=result["recommendation"].get("score"),
                        summary=summary, gates={}, body=body)
                    return self._json({"ok": True, "kind": kind, "summary": summary})
                # The cover letter needs the CV to check itself against.
                ok, why = self._start_generation(con, uid, kind)
                if not ok:
                    return self._json({"ok": False, "error": why},
                                      429 if "running" in why else 409)
                return self._json({"ok": True, "job": ok, "kind": kind})
        finally:
            con.close()
        self.send_error(404)


def _abandon_sponsor_check(con, error: str = "") -> None:
    """Put the sponsor-check state back to idle, mirroring _abandon_rank."""
    
    # 1. Reset Metadata States
    metadata_updates = (
        ("sc_state", "idle"), 
        ("sc_cancel", ""), 
        ("sc_error", error[:300] if error else None)
    )
    
    for k, v in metadata_updates:
        if v is None:
            continue
            
        try:
            store.set_meta(con, k, v)
        except Exception:
            pass

    # 2. Release Lock
    try:
        store.release(con, "sponsor_check")
    except Exception:
        pass



def _spawn_sponsor_check(db_path, config_path, refresh: bool = False,
                          cv_path=None) -> None:
    """Run sponsor-check on a background thread, mirroring _spawn_rank.

    No per-batch cost tracking is needed (nothing here spends money), so
    this is simpler than _spawn_rank: one progress callback updating
    sc_done, and the same cancel-flag / cleanup shape for consistency.

    cv_path: the uploaded CV's path (`Handler._resolve_uploaded_cv()`), if
    any -- passed in explicitly, from the request thread, rather than read
    off `Handler` in here, since this runs on its own background thread with
    no request object of its own.
    """
    import threading

    def work():
        # 1. Establish Database Connection
        try:
            con = store.connect(db_path)
        except Exception as e:
            try:
                with store.open_db(db_path) as c2:
                    _abandon_sponsor_check(c2, f"could not open the database: {e}")
            except Exception:
                pass
            return

        # 2. Main Logic Block
        try:
            from .config import load as load_cfg
            cfg = load_cfg(config_path) if config_path else load_cfg()
            if cv_path:
                cfg.cv_path = cv_path

            def progress(done, total):
                store.set_meta(con, "sc_done", str(done))

            def should_stop():
                return store.get_meta(con, "sc_cancel", "") == "1"

            # evaluate_and_store doesn't currently accept should_stop —
            # sponsor-check is fast enough per-role that a mid-run cancel
            # matters less than for rank, but wiring should_stop through is
            # a small, safe follow-up if a very large board makes it worth
            # interrupting cleanly.
            sc.evaluate_and_store(con, cfg, refresh=refresh, on_progress=progress)
            
            store.set_meta(con, "sc_state", "idle")
            store.set_meta(con, "sc_cancel", "")
            
        # 3. Error Handling
        except Exception as e:
            store.set_meta(con, "sc_state", "idle")
            store.set_meta(con, "sc_cancel", "")
            store.set_meta(con, "sc_error", f"sponsor-check failed: {e}"[:300])
            
        # 4. Cleanup Resources
        finally:
            store.release(con, "sponsor_check")
            con.close()

    # 5. Start Thread
    threading.Thread(target=work, daemon=True).start()



def scan_log_path(db_path) -> Path:
    """Where a dashboard-launched scan's console output is written.

    Next to the database it's scanning into, so a `--db` pointed elsewhere
    gets its own log rather than everyone sharing one file. Overwritten by
    each new scan, not appended to -- this is "what did the last scan say",
    not a history.
    """
    return Path(db_path or store.DEFAULT_PATH).with_suffix(".scan.log")


def _open_scan_log(db_path):
    """Open the scan log for writing, falling back to somewhere that will
    definitely accept the write rather than to DEVNULL.

    This used to fall back to DEVNULL on any OSError opening the intended
    path (a permissions problem, an unusual path, a locked file) -- which
    meant a scan whose own log couldn't be created for whatever reason threw
    away every line it ever printed, including a crash traceback, and looked
    from the dashboard exactly like a scan that quietly did nothing. The
    fallback here is the OS temp directory, which is about as likely to be
    writable as anywhere gets, and the path actually used is returned so the
    caller can record it -- `/api/scan/log` checks that record first, so a
    scan whose primary log location failed is still fully readable rather
    than looking like one that never ran.
    """
    primary = scan_log_path(db_path)
    try:
        primary.parent.mkdir(parents=True, exist_ok=True)
        return open(primary, "w", encoding="utf-8"), primary, ""
    except OSError as e:
        primary_err = str(e)
    try:
        fallback = Path(tempfile.gettempdir()) / "job-radar-scan.log"
        return open(fallback, "w", encoding="utf-8"), fallback, primary_err
    except OSError as e:
        # Both locations refused the write. There is genuinely nowhere to
        # put this scan's output, but that is still not a reason to refuse
        # the scan itself -- DEVNULL here, at last, with the two failures
        # recorded by the caller instead of silently swallowed.
        return subprocess.DEVNULL, None, f"{primary_err}; also: {e}"


def _spawn_scan(db_path, config_path, cv_path=None) -> tuple[bool, str]:
    """Start `job-radar scan` as a detached background process.

    Shared by /api/scan (a plain rescan) and /api/cleanup-and-rescan (the
    same thing, after deleting unapplied roles first), so the two buttons
    can't disagree about how a scan is actually launched.

    stdout/stderr go to a log file, not DEVNULL. A scan launched from a
    terminal prints its progress and its warnings -- how many sources were
    read, what got skipped and why, what sponsor-check found -- and a scan
    launched from this button used to throw every word of that away, which
    meant a real problem (like sponsor_focus silently failing open, or
    failing to, before that had a fix) had nowhere to be seen. `/api/scan`
    now reads the tail of this file back for the dashboard to show.

    cv_path: `Handler.uploaded_cv_path`, if someone has uploaded a CV
    through the dashboard. Without this, a scan -- unlike cover-letter
    generation -- runs as a brand-new process that reloads the config from
    disk and never learns a CV was uploaded, so an upload would silently do
    nothing the moment you actually scanned. Passed through as `--cv` so
    the uploaded file always wins over whatever cv.path says.

    A background thread waits for the child and records its exit code
    (`scan_exit_code` in the database) once it is known. Before this, the
    only thing the dashboard could see was `scan_state` going back to
    "idle", which a clean finish and a crash both do identically -- a scan
    that failed in the first few seconds looked exactly like one that
    finished normally, just fast. Given a real report of exactly that ("scan
    finished in a couple of minutes" when a full run should take about an
    hour), an exit code the dashboard can actually check is worth more here
    than one more guess at what might be crashing.
    """
    cmd = [sys.executable, "-m", "jobradar.cli"]
    if config_path:
        cmd += ["-c", str(config_path)]
    cmd += ["scan"]
    if db_path:
        cmd += ["--db", str(db_path)]
    if cv_path:
        cmd += ["--cv", str(cv_path)]
    log_file, log_used, open_err = _open_scan_log(db_path)
    try:
        con = store.connect(db_path)
        try:
            store.set_meta(con, "scan_exit_code", "")
            store.set_meta(con, "scan_log_path", str(log_used) if log_used else "")
            store.set_meta(con, "scan_log_open_error", open_err)
        finally:
            con.close()
    except Exception:
        pass  # this is diagnostics, never the reason a scan can't start
    try:
        proc = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT,
                                stdin=subprocess.DEVNULL, start_new_session=True)
    except OSError as e:
        return False, str(e)
    finally:
        if log_file not in (subprocess.DEVNULL,):
            log_file.close()   # the child inherited its own copy of the fd

    def _watch():
        code = proc.wait()
        try:
            con = store.connect(db_path)
            try:
                store.set_meta(con, "scan_exit_code", str(code))
            finally:
                con.close()
        except Exception:
            pass

    threading.Thread(target=_watch, daemon=True).start()
    return True, ""


def already_serving(host: str = "127.0.0.1", port: int = 8765) -> bool:
    """Whether something is already listening there.

    Asked before starting a dashboard rather than after, because binding a
    port that is taken raises out of `serve` before it prints anything useful,
    and the second copy would be racing the first for the same database.
    """
    import socket
    with socket.socket() as sock:
        sock.settimeout(0.4)
        try:
            return sock.connect_ex((host, port)) == 0
        except OSError:
            return False


def open_in_background(db_path=None, host: str = "127.0.0.1", port: int = 8765,
                       docs_base=None, config_path=None) -> str | None:
    """Start a dashboard that outlives this process, and return its URL.

    A scan takes over an hour and the first pass is usable after five minutes,
    so the dashboard should be there when it becomes worth looking at rather
    than when the scan happens to end. Detached, because the scan has another
    seventy minutes to run and the person wants to click things now.

    Returns None and starts nothing if a dashboard is already up: they would
    contend for the same database, and the one that lost would print a SQLite
    traceback at somebody who had done nothing wrong.
    """
    import subprocess
    import sys

    if already_serving(host, port):
        return None
    cmd = [sys.executable, "-m", "jobradar.cli"]
    if config_path:
        cmd += ["-c", str(config_path)]
    cmd += ["serve", "--no-browser", "--host", host, "--port", str(port)]
    if db_path:
        cmd += ["--db", str(db_path)]
    if docs_base:
        cmd += ["--docs", str(docs_base)]
    try:
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                         start_new_session=True)
    except OSError:
        return None
    # Wait for the bind rather than guessing at it, so the browser is not
    # opened at a port nothing is answering yet.
    import time
    for _ in range(40):
        if already_serving(host, port):
            return f"http://{host}:{port}/"
        time.sleep(0.25)
    return None


def serve(db_path=None, host="127.0.0.1", port=8765, open_browser=True,
          docs_base=None, config_path=None) -> int:
    # Take the port FIRST, before touching the database.
    #
    # Everything below assumes "I am starting, therefore no other server is
    # running", and clears interrupted generations, locks and rank state on
    # the strength of it. A launchd job with KeepAlive breaks that assumption
    # in the worst possible way: it retries every few seconds, loses the bind
    # to the server that is already up, and on the way to losing it reaps the
    # healthy server's work. Seven queued screenings were killed four seconds
    # after they started, by a process that never served a single request.
    #
    # A failed bind is the only reliable way to know another server owns this
    # database. So bind first, and if the port is taken, leave everything
    # alone and say so.
    try:
        httpd = ThreadingHTTPServer((host, port), Handler)
    except OSError as exc:
        # A second `serve` in another window, or the last one still running,
        # is the ordinary way to hit this, and it came out as a nine-frame
        # socketserver traceback ending in "Address already in use", which
        # reads as a broken tool rather than as a port that is taken.
        if getattr(exc, "errno", None) in (errno.EADDRINUSE, errno.EACCES):
            why = ("is already in use, most likely by a `job-radar serve` "
                   "that is still running"
                   if exc.errno == errno.EADDRINUSE
                   else "needs privileges this process does not have")
            print(f"Port {port} {why}. Either stop that one, or start this "
                  f"one somewhere else with `--port {port + 1}`.", flush=True)
            return 1
        raise

    # Gates are recomputed on start, so a fixed check corrects the rows it got
    # wrong rather than only applying to future runs.
    con = store.connect(db_path)
    try:
        # Documents made before there was a column for their text.
        store.backfill_bodies(con)
        # A generation cannot outlive the process that spawned it, so anything
        # still "running" here is from a server that is gone.
        orphans = store.reap_orphans(con, runner.TIMEOUT)
        if orphans:
            print(f"  cleared {orphans} interrupted generation(s)")
        # The old Claude-based ranking feature is gone (sponsor-check's own
        # combined score replaces it), but a database from before this
        # upgrade can still have `rank_state` stuck at "running" from a
        # server that no longer exists. Nothing writes this key any more, so
        # clearing it once is just tidying up an upgrade, not a feature this
        # server still has.
        if store.get_meta(con, "rank_state", "idle") == "running":
            store.set_meta(con, "rank_state", "idle")
            store.set_meta(con, "rank_cancel", "")
            print("  cleared a stale ranking-state flag from an older version")
        # A lock outlives the process that took it, so a crash mid-run would
        # otherwise refuse every generation for ever.
        if store.clear_locks(con):
            print("  released locks held by a previous run")
        # Housekeeping, and housekeeping must never be the reason the
        # dashboard will not start. `regate` rewrites the quality gates on
        # every stored document, so it writes, and a write loses to anything
        # else holding the database: a scan, a second window. That raised
        # straight out of `serve` and the server never reached its bind, so
        # a scan running in another terminal meant the dashboard simply
        # would not open, with a SQLite traceback as the explanation.
        #
        # Observed doing exactly that. The gates it refreshes are already
        # correct on disk from when each document was written; re-checking
        # them is an upgrade path for documents written before the gate was
        # fixed, and that can wait for the next start.
        try:
            n = runner.regate(con)
            if n:
                print(f"  rechecked {n} document(s)", flush=True)
        except sqlite3.OperationalError as e:
            print(f"  skipped re-checking documents: {e}. "
                  f"Something else is using the database.", flush=True)
    finally:
        con.close()

    Handler.db_path = db_path
    Handler.docs_base = docs_base
    Handler.bind_host = host or ""
    # Without this the runner resolved a config from its working directory, so
    # generation used whatever config.yaml happened to be in cwd rather than
    # the one passed on the command line.
    Handler.config_path = config_path
    # A config that will not load must not stop the dashboard starting: the
    # board and everything already on it are in the database, not the config.
    # Losing the sort grouping is a fair price; losing the page is not.
    try:
        from .config import load as _load_cfg
        Handler.home_currency = (
            _load_cfg(config_path).salary_currency or "").upper()
    except Exception:
        Handler.home_currency = ""
    url = f"http://{host}:{port}/"
    print(f"job-radar is at {url}", flush=True)
    print("  buttons: screen, CV, cover letter, apply, skip", flush=True)
    # Flushed, all three. Python block-buffers stdout when it is not a
    # terminal, so `job-radar serve > serve.log &` -- which is how anyone
    # running it in the background or under a supervisor starts it -- wrote
    # an empty file and kept it empty for the life of the process. A server
    # that is up and silent is indistinguishable from one that hung on the
    # bind, and the URL is the one thing the reader came for.
    print("  nothing generates unless you click it. Ctrl-C to stop.", flush=True)
    if open_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        httpd.server_close()
    return 0
