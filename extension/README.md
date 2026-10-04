# Sponsor Check for job-radar

A Chrome extension that scores a job posting while you're actually reading
it -- on LinkedIn, Indeed, or any company careers page -- using the exact
same sponsorability, posting-pattern, ATS-readiness and CV-fit logic as
job-radar's own dashboard (`jobradar/sponsor_check.py`, ported to JS in
`lib/scoring.js` and checked line-for-line against the Python version, down
to matching Python's rounding behaviour).

Everything runs in your browser. Your CV and the postings you read are never
sent anywhere; the one network request this extension makes is a weekly
refresh of the UK Government's published sponsor register, the same source
job-radar's dashboard already uses.

## Install it (unpacked, for personal use)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Click the extension's icon in the toolbar, then **Add / update CV**, and
   upload your CV (PDF or plain text) or paste it directly.

That's it -- open a job posting on LinkedIn, Indeed, or most company careers
sites, and a small "Sponsor Check" pill appears in the bottom-right corner
within a second or two. Click it for the full breakdown: sponsorship
likelihood, posting-pattern and CV-fit scores, ATS-readiness flags, and a
plain-language recommendation.

For a board that doesn't auto-detect (an in-house ATS with no structured
job-posting data), click the extension icon and use **Check this page** --
it scores whatever's on the page instead of waiting for a confident
detection.

## How detection works

Most modern ATS platforms (Greenhouse, Lever, Workday, SmartRecruiters,
Workable, and many company career pages) already publish a
`schema.org/JobPosting` block on the page for Google's own job search --
the extension reads that first, since it's the same structured answer the
site already gives search engines rather than a guess at page layout.
LinkedIn and Indeed get their own small set of selectors as a fallback for
the pages of theirs that don't carry that markup. Anything else only gets
scored when you ask it to, via the toolbar button.

## What it doesn't do

- It doesn't scan job boards for you or keep a list -- that's what
  job-radar's own `scan`/dashboard does. This is the "I'm already looking
  at one posting, is it worth my time" half of the same tool.
- It doesn't read or write anything on the page besides floating a small
  badge over it.
- It doesn't call any AI model -- the scoring is the same fast, free,
  rule-based logic job-radar's dashboard uses for the same reason: it costs
  nothing to run on every posting you open.

## Files

| File | What it does |
|---|---|
| `manifest.json` | Extension configuration (Manifest V3) |
| `lib/scoring.js` | The scoring logic itself -- a JS port of `sponsor_check.py` |
| `background.js` | Service worker: holds your CV and the cached sponsor register, answers scoring requests |
| `content.js` | Runs on job pages: extracts the posting, asks the background worker to score it, renders the badge |
| `badge.css` | The floating badge/panel's styling |
| `popup.html` / `popup.js` | The toolbar popup: CV/register status, manual check button |
| `options.html` / `options.js` | Where you add/replace your CV |
| `lib/pdf.min.js`, `lib/pdf.worker.min.js` | Mozilla's PDF.js, bundled so a PDF CV can be read without leaving the browser |
