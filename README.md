# Job Radar

A UK/EU visa-sponsorship job search tool: it scans employer boards and job
APIs on a schedule, scores each posting against a sponsor register and your
CV, and drafts a tailored CV and cover letter for the ones worth applying to.

This is my own working build, kept and extended from [maccydee/job-radar](
https://github.com/maccydee/job-radar) (MIT-licensed — full text in
[LICENSE](LICENSE)). The scanning engine, the 17,800+ employer source list,
and the scoring logic are that project's work. What's in this repo on top of
it:

- **A public web dashboard** (`web/`) — browse scored roles and draft
  documents from any browser, no install, no login.
- **A Chrome extension** (`extension/`) — the same sponsor/CV-fit scoring
  overlaid on a job posting while you're reading it on the actual site.
- **A free GitHub Actions pipeline** (`.github/workflows/`, `scripts/`) —
  the scan runs on a schedule in the cloud, with no server to maintain and
  no cost on a public repo.
- **A Gemini-direct document path** (`jobradar/gemini_generate.py`, wired
  into the CLI via `JOB_RADAR_USE_GEMINI=1`) — drafts CVs and cover letters
  through a free Gemini API key instead of requiring a Claude Code
  installation. One real bug in the original CLI (`cmd_generate` checking
  for the `claude` binary before this path got a chance to run) was found
  and fixed here — see `jobradar/cli.py` and `jobradar/runner.py`.

## Layout

```
jobradar/           the core CLI and engine (scan, enrich, screen, generate, serve)
skills/              the Claude Code skills job-radar's own CLI drives (rate-cv, screen-role, setup)
web/                 the public dashboard (static, client-side only — see SETUP.md)
extension/           the Chrome extension version of the same scoring
.github/workflows/   the scheduled scan + CI, for the Actions setup
scripts/             helpers the workflows call (export_register.py, draft_new_roles.py)
sources/             the bundled list of employer boards to scan
docs/                reference docs (config, sources, platforms, this project's own notes)
tests/, tools/       test suite and maintenance scripts
```

`config.yaml`, `.env` and `cv.md` are yours, kept locally and out of version
control (see `.gitignore`) — `config.example.yaml` is the template.

## Getting started locally

```
git clone <this repo>
cd job-radar
python3 install.py
```

`install.py` sets up a virtual environment and hands straight over to
`job-radar setup`, which asks for your CV and search criteria and runs the
first scan. From there:

```
job-radar scan      # fetch and score new roles
job-radar serve      # the local dashboard, at http://localhost:...
job-radar generate   # draft a CV / cover letter for a role
```

`generate` needs either a real Claude Code install, or Gemini directly:

```
export GEMINI_API_KEY=your-key-here
python3 job_radar_launcher.py generate ...
```

(`job_radar_launcher.py` just sets `JOB_RADAR_USE_GEMINI=1` and runs
`job-radar` — you can set that environment variable yourself instead and
skip the launcher entirely.)

## Running it for free on GitHub, with a public dashboard

See for the full walkthrough: a public repo, a
scheduled scan with no server and no cost, and a dashboard at
`https://khabibullaevmurodilla.github.io/job_search_dashboard/` that anyone can use — each visitor's CV,
API key and applied/skipped choices stay in their own browser, never in
this repo.

## Everything from upstream

Config reference, the full source list, platform notes, and the original
project's own working notes are kept in `docs/` and `CLAUDE.md` unchanged.
