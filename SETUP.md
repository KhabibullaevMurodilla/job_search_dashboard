# job-radar: public dashboard, free, on GitHub

## What you get

A public, free, no-login web dashboard at `https://<you>.github.io/<repo>/`
with the same scoring job-radar's local tool uses, plus:

- **Sponsor-likelihood and CV-fit scoring**, computed live in each
  visitor's own browser against the UK sponsor register and whatever CV
  they paste in.
- **"Draft CV" / "Draft cover letter"** buttons, same prompts and rules
  job-radar's local `job-radar serve` dashboard uses, calling Gemini
  directly from the visitor's browser with their own free API key.
- **Apply / Skip** tracking, per visitor, kept in their own browser.

Nobody's CV, API key, or applied/skipped choices ever reach this repo or
this workflow. There is no backend and no database for any of that —
everything above runs client-side, in whichever browser has the page open.
Discovery (the actual job scan) is the one part that *does* run
server-side, on a schedule, via the GitHub Actions workflows below.

## The trade-off: this repo has to be public

GitHub Pages is free only on a public repo. A private repo needs GitHub
Pro ($4/month) to use Pages at all. Since you said free and public is
fine, that's what this is built for — but it's worth being precise about
what "public" means here, because it's not just the dashboard:

- **`config.yaml`** (your search criteria — roles, locations, salary
  floor) becomes visible to anyone who looks at the repo.
- **Anything you commit** is visible, full stop. That includes a
  committed CV.

This changes one thing from the private-repo setup I gave you earlier:
**don't turn on `DRAFT_DOCS`** (the Actions-side auto-draft step that uses
*your* CV and *your* Gemini key to pre-draft documents for new roles). That
feature needs your CV committed into the repo as a file (`cv.path` in
`config.yaml` has to point to something that exists in the checkout, not a
path on your Windows PC) — fine on a private repo, not something to do on
a public one.

You don't need it anymore anyway: open your own public dashboard, paste
your own CV into the box (it stays in your own browser, never committed),
and click "Draft CV" yourself. Same drafting, same Gemini call, zero
privacy cost, because it's now a client-side action you take as a visitor
to your own page, not a server-side step that needs your CV checked in.

If you'd rather keep `DRAFT_DOCS` and auto-drafting with your own CV, keep
the repo **private** instead and skip the public dashboard (that was the
setup from before this one) — the two don't have to be the same repo.

## Setup

### 1. Files

From your repo (`C:\Users\User\Projects\job-radar\`), add:

```
git remote add upstream https://github.com/maccydee/job-radar.git
git fetch upstream
```

Copy everything in this package into your repo at the same paths:
- `.github/workflows/scan.yml` — real upstream scan.yml + the drafting
  step (off unless you set `DRAFT_DOCS`) + the public-dashboard build step
- `.github/workflows/test.yml`, `.github/workflows/validate.yml` —
  upstream's, unmodified
- `scripts/draft_new_roles.py`, `scripts/export_register.py`
- `web/` — the dashboard itself

### 2. Make the repo public, commit your config

```
git add -f config.yaml
git commit -m "my config"
git push
```

Settings → General → Danger Zone → Change visibility → **Public**.

**Do not commit your CV to this repo.** You don't need to — see above.

### 3. Turn Pages on

- Settings → Pages → Source: **GitHub Actions**
- `gh variable set PUBLISH_PAGES --body true` (or set it in Settings →
  Secrets and variables → Actions → Variables)
- Leave `DRAFT_DOCS` unset, for the reason above.

### 4. Add secrets (just the job-board ones now)

Settings → Secrets and variables → Actions → Secrets:
- `REED_API_KEY`, `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`

No `GEMINI_API_KEY` secret needed here — each visitor (including you)
brings their own, typed into the page itself.

### 5. Run it

Actions tab → `scan` → Run workflow. Once it finishes, your dashboard is
live at `https://<your-username>.github.io/<repo-name>/`. Open it, paste
your CV, paste a free Gemini key (aistudio.google.com/apikey, no billing
account needed), and start browsing.

## What's checked, and what's lighter than the local tool

The sponsor/CV-fit scoring (`web/lib/scoring.js`) is the same code already
verified against job-radar's own Python scoring in this project's Chrome
extension — same inputs, same scores.

The drafting quality gates are lighter: the local tool runs real
Python checks (`natural-writing`'s slop detector, `rate-cv`'s structural
scorer). This page has no Python runtime, so it checks the mechanical
parts only — word count, em-dashes, date-range format, missing sections,
and CV/cover-letter phrase overlap (the same longest-shared-phrase check
`runner.py` uses, hardened here against a performance bug its own version
has on heavily-duplicated text, found while testing this). A draft that
passes the page's checks is not held to the identical bar the local tool's
gates set, and that difference is shown in the UI (a warning box lists
exactly what the lighter check caught), not hidden.

## Tested before delivery

- `test_core.js` (16 checks): filtering/sorting, prompt building, every
  quality-check rule, the phrase-overlap check including a performance
  regression test on a near-total-overlap document, and the real
  `scoring.js` sponsorability check fed through the same JSON shape
  `export_register.py` produces.
- `test_dom.js` (18 checks): the whole page wired up in a real DOM
  (jsdom) — roles loading and rendering, every filter, CV save
  triggering re-scoring, apply/skip persisting, and the full draft flow
  (CV draft → cover letter draft, including the "draft the CV first"
  refusal) against a mocked Gemini endpoint.
