# Which platforms are worth scanning for UK/EU sponsorship

Based on what's actually in this codebase: `jobradar/adapters/__init__.py`'s
registered platforms (`greenhouse`, `lever`, `lever_eu`, `ashby`, `workable`
+ variants, `smartrecruiters`, `workday`, `bamboohr`, `personio`,
`teamtailor`, `pinpoint`, `recruitee`, `breezy`, `jazzhr`, `jobvite`,
`taleo`, `icims`, `oracle`, `avature`, `phenom`, `rmk`, `pcsx`, `amazon`,
`nhs`, `rss`, plus the two paid aggregator APIs `reed` and `adzuna`, and
`linkedin`), and `config.yaml`'s current settings (`sectors: []` — every
employer watched; `exclude_platforms: [linkedin, workable]`;
`sources.countries: [UK, IE, DE, NL]`).

I could not find an `EURAXESS` or `jobs.ac.uk` adapter or entry anywhere in
this checkout, and the bundled `sources/sources.json` list itself isn't
present in this working copy to inspect directly — so I can't confirm or
add to whatever academic/PhD sources were meant to already be in place;
worth checking on a machine that has the full bundled list.

## Higher-probability categories

- **ATS platforms used by scale-ups and larger employers** — Greenhouse,
  Lever, Ashby, SmartRecruiters, Workday, Personio, Teamtailor. Companies
  large enough to run their own ATS instance are disproportionately the
  ones with an established Home Office sponsor licence already, versus a
  small business posting to a single job board.
- **`nhs`** — a dedicated NHS Jobs adapter. The NHS is one of the most
  consistent UK visa sponsors (Health and Care Worker visa), so this is
  worth keeping fully in scope.
- **Enterprise/large-org ATS** (`workday`, `icims`, `oracle`, `avature`,
  `taleo`, `bamboohr`) — same logic as above: these are run by employers
  with HR infrastructure at a scale where sponsorship is routine, not
  exceptional.

## Lower-probability, but not worth excluding wholesale

- **`workable`** — already excluded in config.yaml, and for a documented
  reason unrelated to sponsorship likelihood (the individual per-employer
  boards are the slowest phase of a scan; `workable_recent` and
  `workable_search` stay on and are not covered by that exclusion, so
  Workable-hosted roles are still swept, just not one board at a time).
- **`linkedin`** — already excluded; LinkedIn mixes every kind of employer
  indiscriminately and gives the weakest per-posting signal of the lot.
- **`reed` / `adzuna`** — general aggregators; useful for volume and reach,
  but they carry no employer-type signal on their own, so the per-role
  `sc_worth_applying` score is doing the real filtering there.

## Recommendation

Don't exclude whole platforms by guessing at "who sponsors." That's exactly
the failure mode `sponsor_check.py` was written to avoid: a platform-level
exclusion is a blunt, unreviewable guess, while `sc_worth_applying` already
checks each individual posting against the actual UK/IE/DE/NL sponsor
registers, salary and CV fit — a far more precise signal than "this came
from platform X." With `sponsor_check.skip_below: 40` wired into every scan
(see config.yaml), roles that don't clear that bar are auto-skipped
regardless of which platform they came from, which is the right level to
filter at.

## Update: `sources.sponsor_focus` (scan only the useful boards)

Skip-below only cuts jobs *after* a board is read. Scanning is otherwise
still "everywhere" — every employer board that survives the country/sector
filters gets fetched, most of them small companies with no visible sponsor
licence, and only then does the score say so.

`sources.sponsor_focus: true` (now on in config.yaml) moves the same check
one step earlier, at the source list itself, before anything is fetched:

- An employer's own board (Greenhouse, Lever, Ashby, Workday, Personio,
  SmartRecruiters, etc.) is read only if that employer's name matches an
  entry on the UK sponsor register — the exact fuzzy match `sponsor_check`
  already trusts for scoring one role at a time, reused here one level
  further out (`sponsor_check.registered_company()`, called from
  `sources.sponsor_focus_filter()`).
- A search that returns many employers at once — Reed, Adzuna, NHS Jobs,
  the Workable sweeps — is never touched by this. There's no single
  employer name on the source to check, and every result it brings back is
  still scored individually as usual.
- The one known failure mode is the same one `sponsor_check` already lives
  with: a real sponsor whose own board spells its name slightly differently
  from the register reads as a non-match. The difference is that a
  non-match here means the board is never read at all, versus a low-but-
  visible score you could still check by hand at the per-role level. That's
  why it's a config switch (`sources.sponsor_focus`) rather than baked in —
  turn it off in config.yaml if the board starts looking thin and you'd
  rather see everything scored than trust the register match alone.

This is the concrete "scan only useful resources, not everywhere" change:
scanning itself now narrows to registered sponsors plus the wide-net
searches, rather than reading every employer board on the list and relying
on `skip_below` to clean up afterward.
