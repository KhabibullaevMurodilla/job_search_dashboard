"""Sponsorability, posting-pattern, ATS-readiness, and CV-fit scoring.

Ported from the Sponsor Check browser extension into job-radar's own
codebase, so its analysis runs as part of the same pipeline that already
scans, ranks, and generates documents -- one dashboard, one database,
no popup.

Design carried over unchanged from the extension:
  - Four separate signals, never blended into one misleading average.
    Legitimacy, ATS readiness, and CV fit answer different questions and
    are shown separately; a recommendation is a short piece of logic over
    the three, not a weighted mean of them.
  - Careful, non-accusatory wording throughout. A low posting-pattern score
    describes a PATTERN IN THE TEXT, never a verdict about the employer.
  - GB + EU scope only. Where no country publishes a usable sponsor
    register, that component honestly reports "no data" rather than
    guessing.
  - ATS readiness is FLAGS (critical/warning), not a percentage -- a
    scanned PDF is closer to a binary failure than a "70% CV".

This module has no dependency on anything browser-specific. CV text
extraction reuses job-radar's own `runner.docx_to_text` and
`rank._pdf_to_text`, so there is nothing new to install for that part.
"""

from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path


# ---------------------------------------------------------------------
# Country detection (GB + EU scope)
# ---------------------------------------------------------------------
COUNTRY_ALIASES = {
    "united kingdom": "UK", "u.k.": "UK", "uk": "UK", "england": "UK",
    "scotland": "UK", "wales": "UK", "northern ireland": "UK", "london": "UK",
    "great britain": "UK",
    "germany": "DE", "deutschland": "DE", "berlin": "DE", "munich": "DE",
    "frankfurt": "DE",
    "france": "FR", "paris": "FR",
    "netherlands": "NL", "holland": "NL", "amsterdam": "NL",
    "the hague": "NL", "rotterdam": "NL",
    "ireland": "IE", "dublin": "IE",
    "spain": "ES", "madrid": "ES", "barcelona": "ES",
    "italy": "IT", "rome": "IT", "milan": "IT",
    "sweden": "SE", "stockholm": "SE",
    "poland": "PL", "warsaw": "PL", "krakow": "PL",
    "portugal": "PT", "lisbon": "PT",
    "belgium": "BE", "brussels": "BE",
    "austria": "AT", "vienna": "AT",
    "denmark": "DK", "copenhagen": "DK",
    "finland": "FI", "helsinki": "FI",
    "greece": "GR", "athens": "GR",
    "czechia": "CZ", "czech republic": "CZ", "prague": "CZ",
    "hungary": "HU", "budapest": "HU",
    "romania": "RO", "bucharest": "RO",
    "bulgaria": "BG", "sofia": "BG",
    "croatia": "HR", "zagreb": "HR",
    "slovakia": "SK", "bratislava": "SK",
    "slovenia": "SI", "ljubljana": "SI",
    "estonia": "EE", "tallinn": "EE",
    "latvia": "LV", "riga": "LV",
    "lithuania": "LT", "vilnius": "LT",
    "luxembourg": "LU", "malta": "MT", "cyprus": "CY",
}


def detect_country(text: str) -> str:
    """The GB/EU country a job's location (or description) names, or ''."""
    low = (text or "").lower()
    for alias, code in COUNTRY_ALIASES.items():
        if alias in low:
            return code
    return ""


# ---------------------------------------------------------------------
# Component: Legitimacy & sponsorability (its own composite)
# ---------------------------------------------------------------------
UK_SALARY_GENERAL = 41700
UK_SALARY_NEW_ENTRANT = 33400
UK_SALARY_PHD_STEM = 37500
UK_SALARY_HEALTH_CARE = 25000

POSITIVE_SPONSOR_PATTERNS = [
    r"visa sponsorship (?:is |will be )?available",
    r"\bwe (?:can |will |do |are able to )?sponsor\b",
    r"sponsorship (?:is |will be )?offered",
    r"able to sponsor",
    r"open to sponsoring",
    r"will sponsor",
]
NEGATIVE_SPONSOR_PATTERNS = [
    # "do/does not offer/provide (visa) sponsorship" -- the word "visa" is
    # often inserted between "offer/provide" and "sponsorship" in real
    # postings, so this tolerates an optional word there rather than
    # requiring an exact substring match.
    r"(?:do|does)\s+not\s+(?:currently\s+)?(?:offer|provide)\s+(?:\w+\s+){0,2}sponsorship",
    r"unable to (?:offer|provide)\s+(?:\w+\s+){0,2}sponsorship",
    r"\bno\s+(?:\w+\s+){0,2}sponsorship\b",
    r"unable to sponsor",
    r"cannot sponsor",
    r"must have the right to work",
    r"must have right to work",
    r"not sponsoring",
    r"without the need for\s+(?:\w+\s+){0,2}sponsorship",
]
ENTRY_LEVEL_PHRASES = ["graduate", "junior", "intern", "internship",
                       "entry level", "entry-level", "trainee"]
LARGE_EMPLOYER_PHRASES = ["fortune 500", "fortune 100", "multinational",
                          "ftse 100", "ftse 250", "global company",
                          "offices in over", "operates in over", "plc",
                          "group of companies"]

_SALARY_PATTERNS = [
    re.compile(r"£\s?([\d,]{4,7})(?:\.\d+)?\s?(k)?", re.I),
    re.compile(r"(?:gbp|usd|eur|\$|€)\s?([\d,]{4,7})(?:\.\d+)?\s?(k)?", re.I),
    re.compile(r"([\d,]{4,7})\s?(k)?\s?(?:per year|per annum|annually|/year|a year)", re.I),
]


def extract_salary(text: str) -> int | None:
    for pattern in _SALARY_PATTERNS:
        m = pattern.search(text or "")
        if m:
            val = int(m.group(1).replace(",", ""))
            if m.group(2):
                val *= 1000
            if val >= 1000:
                return val
    return None


@dataclass
class RegisterEntry:
    name: str
    rating: str = ""   # "A" / "B" / ""
    route: str = ""


@dataclass
class Register:
    country: str
    entries: list[RegisterEntry] = field(default_factory=list)


def _find_register_entry(company_norm: str, applicable: list[Register]) -> tuple[RegisterEntry, str] | None:
    for register in applicable:
        for entry in register.entries:
            n = re.sub(r"[^a-z0-9 ]", "", entry.name.lower()).strip()
            if n and (n == company_norm or n in company_norm or company_norm in n):
                return entry, register.country
    return None


def registered_company(company: str, registers: list[Register]) -> bool:
    """Whether `company` matches a loaded sponsor register, using the exact
    fuzzy substring matching `sponsorability()` already trusts for scoring
    one role at a time.

    Exposed so `sources.py` can ask the same question one level further out
    -- at the source-list stage, before anything is ever fetched -- for its
    opt-in `sources.sponsor_focus` filter. A non-match here has the same
    known failure mode as a non-match in `sponsorability()` (a real sponsor
    whose own board spells its name differently from the register), which is
    why that filter stays opt-in rather than a default.
    """
    company_norm = re.sub(r"[^a-z0-9 ]", "", (company or "").lower()).strip()
    if not company_norm or not registers:
        return False
    return _find_register_entry(company_norm, registers) is not None


def sponsorability(job: dict, registers: list[Register]) -> dict:
    """job: {"title", "company", "location", "description"}.

    Returns {"percent": int|None, "reason": str, "sub_details": [str, ...],
             "explicit_no_sponsor": bool}
    """
    desc = (job.get("description") or "").lower()
    company_norm = re.sub(r"[^a-z0-9 ]", "", (job.get("company") or "").lower()).strip()
    country = detect_country(job.get("location") or "") or detect_country(job.get("description") or "")
    sub_details: list[str] = []

    neg_match = next((m for m in (re.search(p, desc) for p in NEGATIVE_SPONSOR_PATTERNS) if m), None)
    pos_match = next((m for m in (re.search(p, desc) for p in POSITIVE_SPONSOR_PATTERNS) if m), None)
    neg = neg_match.group(0) if neg_match else None
    pos = pos_match.group(0) if pos_match else None
    if neg:
        return {
            "percent": 5,
            "reason": f'This posting states outright that sponsorship isn\'t available ("{neg}"). Worth trusting what the employer wrote here over other signals.',
            "sub_details": [f'Posting states: "{neg}"'],
            "explicit_no_sponsor": True,
        }

    register_score = None
    if not company_norm:
        register_note = "Couldn't read a company name to check."
    else:
        applicable = [r for r in registers if r.country == country] if country else registers
        if not applicable:
            register_note = (
                f"No sponsor register is loaded for {country} yet — add one if one is publicly available for that country."
                if country else
                "Couldn't determine the job's country, and no registers are loaded."
            )
        else:
            found = _find_register_entry(company_norm, applicable)
            if not found:
                register_score = 25
                register_note = (
                    f"No match found for this company on the {country or applicable[0].country} register loaded. "
                    f"This could mean the company isn't a licensed sponsor there yet, or simply that its registered "
                    f"name differs slightly — worth checking directly rather than ruling it out."
                )
            else:
                entry, found_country = found
                register_score = 80
                register_note = f"Found on the {found_country} sponsor register."
                if entry.rating == "A":
                    register_score = 100
                    register_note += " Licence rating: A."
                elif entry.rating == "B":
                    register_score = 45
                    register_note += (" Licence rating: B — sponsors with a B rating are sometimes "
                                      "temporarily restricted from assigning new Certificates of Sponsorship "
                                      "while addressing compliance requirements, so it's worth asking the "
                                      "employer directly about current status.")
                if entry.route:
                    role_looks_permanent = not re.search(r"(intern|seasonal|temporary|placement)",
                                                          job.get("title") or "", re.I)
                    if "temporary" in entry.route.lower() and role_looks_permanent:
                        register_score = min(register_score, 40)
                        register_note += f' Licence route is "{entry.route}", which may not cover a permanent hire.'
                    else:
                        register_note += f" Licence route: {entry.route}."
    if register_score is not None:
        sub_details.append(register_note)
    else:
        sub_details.append(register_note)

    salary_score = None
    salary = extract_salary(job.get("description") or "")
    if country == "UK" and salary is not None:
        is_health = bool(re.search(r"\b(nhs|health|care worker|social care|nurse)\b", desc))
        is_phd = "phd" in desc
        is_new_entrant = any(p in desc for p in ENTRY_LEVEL_PHRASES)
        floor = (UK_SALARY_HEALTH_CARE if is_health else
                 UK_SALARY_PHD_STEM if is_phd else
                 UK_SALARY_NEW_ENTRANT if is_new_entrant else UK_SALARY_GENERAL)
        if salary >= UK_SALARY_GENERAL:
            salary_score = 100
            sub_details.append(f"Advertised salary (~£{salary:,}) clears the general £{UK_SALARY_GENERAL:,} threshold.")
        elif salary >= floor:
            salary_score = 70
            sub_details.append(f"Advertised salary (~£{salary:,}) is below the general threshold but may clear a discounted floor (~£{floor:,}) — confirm which applies.")
        else:
            salary_score = 15
            sub_details.append(f"Advertised salary (~£{salary:,}) appears below even the discounted Skilled Worker floors — this role likely isn't sponsorable as priced. Always check the specific occupation's \"going rate\" too.")
    elif country == "UK":
        sub_details.append("No salary figure found in the posting to check against the visa threshold.")
    elif country:
        sub_details.append(f"Salary-threshold checking is only implemented for the UK so far — {country} has its own rules not modeled here.")

    language_score = None
    if pos:
        language_score = 100
        sub_details.append(f'The posting itself mentions sponsorship: "{pos}".')

    title_and_desc = ((job.get("title") or "") + " " + (job.get("description") or "")).lower()
    entry_phrase = next((p for p in ENTRY_LEVEL_PHRASES if p in title_and_desc), None)
    seniority_score = None
    if entry_phrase:
        seniority_score = 35
        sub_details.append(f'This reads as an entry-level/graduate/junior role ("{entry_phrase}"). Employers sponsor these less often on average, purely for cost and process reasons — it doesn\'t mean this specific one won\'t.')

    large_phrase = next((p for p in LARGE_EMPLOYER_PHRASES if p in desc), None)
    if large_phrase:
        sub_details.append(f'The posting suggests a larger or multinational employer ("{large_phrase}"), and bigger employers more often have existing sponsorship infrastructure — a loose statistical tendency, not a guarantee for this role.')

    parts = [(register_score, 0.40), (salary_score, 0.30), (language_score, 0.15), (seniority_score, 0.15)]
    parts = [(p, w) for p, w in parts if p is not None]
    weight_sum = sum(w for _, w in parts)
    percent = round(sum(p * w for p, w in parts) / weight_sum) if weight_sum > 0 else None

    return {
        "percent": percent,
        "reason": sub_details[0] if sub_details else "Not enough information yet to estimate sponsorship likelihood.",
        "sub_details": sub_details,
        "explicit_no_sponsor": False,
    }


# ---------------------------------------------------------------------
# Component: posting-pattern check (careful, non-accusatory wording)
# ---------------------------------------------------------------------
CAUTION_PHRASES = [
    "wire transfer", "processing fee", "registration fee", "pay a fee",
    "training fee", "send your bank details", "whatsapp only",
    "telegram only", "no interview necessary",
    "immediate start no experience", "work from home earn", "send money",
    "purchase equipment yourself", "reply with your full name and address",
    "gift card",
]
URGENCY_PHRASES = ["apply now limited spots", "only a few positions left",
                   "act fast", "immediate joining only"]


def posting_pattern(description: str) -> dict:
    desc = (description or "").lower()
    if not desc.strip():
        return {"percent": None, "reason": "No description text available to check."}
    found = [p for p in CAUTION_PHRASES if p in desc]
    found_urgency = [p for p in URGENCY_PHRASES if p in desc]
    percent = 100
    reason = "No notable red-flag phrasing spotted in the text."
    if found:
        percent -= 35 * len(found)
        reason = (f'This posting includes phrasing sometimes seen in lower-quality or fraudulent listings '
                  f'(e.g. "{found[0]}"). This is not proof of anything wrong — plenty of genuine postings use '
                  f'ordinary business language that happens to overlap — but it\'s worth verifying details '
                  f'directly with the employer before sharing personal or financial information.')
    if found_urgency:
        percent -= 10
        reason += " It also leans on urgency language, which is worth noticing but isn't unusual in genuine recruiting either."
    percent = max(0, min(100, percent))
    return {"percent": percent, "reason": reason}


def description_quality(description: str) -> dict:
    desc = description or ""
    if not desc.strip():
        return {"percent": None, "reason": "No description text available."}
    if len(desc) < 200:
        return {"percent": 30, "reason": "The description is on the short side, so there's less here to evaluate — that's true of some genuine postings too, just worth reading the full listing directly."}
    if len(desc) > 800:
        return {"percent": 90, "reason": "Description is detailed, consistent with a genuine posting."}
    return {"percent": 65, "reason": "Description length is unremarkable."}


# ---------------------------------------------------------------------
# Component: ATS readiness (flags, not a percentage)
# cv_meta: {"method": "pdf"|"docx"|"txt", "avg_chars_per_page": int|None}
# ---------------------------------------------------------------------
def ats_readiness(cv_text: str, cv_meta: dict | None) -> dict:
    if not cv_text or not cv_meta:
        return {"has_cv": False, "ready": None, "flags": []}

    flags = []
    if cv_meta.get("method") == "pdf" and cv_meta.get("avg_chars_per_page") is not None \
            and cv_meta["avg_chars_per_page"] < 100:
        flags.append({"severity": "critical",
                      "text": ("This PDF looks like it may be a scanned image rather than searchable text. "
                               "Many ATS platforms can't read image-based PDFs at all — this is often an "
                               "instant rejection regardless of your actual experience. A text-based PDF or "
                               "Word (.docx) file is much safer.")})

    has_email = bool(re.search(r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}", cv_text, re.I))
    if not has_email:
        flags.append({"severity": "critical",
                      "text": "Couldn't find an email address in the extracted text — ATS platforms rely on this to file your application, so this can also mean it never reaches a person."})

    if len(cv_text) < 300:
        flags.append({"severity": "warning", "text": "The extracted text is quite short — worth double-checking the file uploaded correctly and includes your full CV."})
    elif len(cv_text) > 20000:
        flags.append({"severity": "warning", "text": "This is a long document — some ATS platforms truncate very long CVs, so details near the end could be missed."})

    lower = cv_text.lower()
    for label, pattern in (("experience", r"\b(experience|employment history|work history)\b"),
                           ("education", r"\beducation\b"),
                           ("skills", r"\bskills\b")):
        if not re.search(pattern, lower):
            flags.append({"severity": "warning", "text": f'Couldn\'t find a clearly labeled "{label}" section — standard headings help both ATS parsers and human reviewers scan a CV quickly.'})

    lines = cv_text.split("\n")
    lines_with_gaps = sum(1 for l in lines if re.search(r"\S {4,}\S", l.strip()))
    total_lines = max(1, sum(1 for l in lines if l.strip()))
    if lines_with_gaps / total_lines > 0.15:
        flags.append({"severity": "warning", "text": "The text extraction suggests this CV may use multi-column layout or tables. Many ATS parsers read these out of order or drop content entirely — a single-column layout is the safest bet."})

    has_critical = any(f["severity"] == "critical" for f in flags)
    return {"has_cv": True, "ready": not has_critical, "flags": flags}


# ---------------------------------------------------------------------
# Component: CV fit (required-skills / experience / title / general overlap)
# ---------------------------------------------------------------------
SYNONYMS = {
    "js": "javascript", "javascript": "javascript", "node": "nodejs",
    "nodejs": "nodejs", "node.js": "nodejs", "reactjs": "react",
    "react.js": "react", "ts": "typescript", "typescript": "typescript",
    "py": "python", "python": "python", "postgres": "postgresql",
    "postgresql": "postgresql", "k8s": "kubernetes", "kubernetes": "kubernetes",
    "ml": "machine learning", "machine learning": "machine learning",
    "ai": "artificial intelligence", "aws": "amazon web services",
    "amazon web services": "amazon web services", "gcp": "google cloud",
    "google cloud platform": "google cloud", "ci/cd": "cicd", "cicd": "cicd",
    "continuous integration": "cicd", "nlp": "natural language processing",
    "db": "database", "dbs": "database", "excel": "microsoft excel",
    "msexcel": "microsoft excel",
}
STOP_WORDS = set("""the and a to of in for with on is are as an we you your
our will be or this that team work role company job looking experience
skills ability strong using years year knowledge based building right
candidate""".split())


def _tokenize(s: str) -> list[str]:
    return re.findall(r"[a-z][a-z0-9+#.]{1,}", (s or "").lower())


def _canon(token: str) -> str:
    return SYNONYMS.get(token, token)


def _extract_requirements(desc: str) -> tuple[str, str]:
    m = re.search(r"(requirements|must have|required qualifications|minimum qualifications|what you'll need|you have|essential)[:\s]", desc, re.I)
    if not m:
        return "", desc
    start = m.end()
    after = desc[start:]
    m2 = re.search(r"(nice to have|preferred|desirable|bonus|about us|benefits|perks)[:\s]", after, re.I)
    end = m2.start() if m2 else min(len(after), 600)
    required = after[:end]
    rest = desc[:m.start()] + after[end:]
    return required, rest


def _skill_overlap(cv_tokens: set[str], job_text: str) -> tuple[int | None, list[str]]:
    job_tokens = [_canon(t) for t in _tokenize(job_text) if t not in STOP_WORDS]
    if not job_tokens:
        return None, []
    freq: dict[str, int] = {}
    for t in job_tokens:
        freq[t] = freq.get(t, 0) + 1
    unique = list(freq.keys())
    matched = [t for t in unique if t in cv_tokens]
    percent = round(len(matched) / len(unique) * 100)
    top = sorted(matched, key=lambda t: -freq[t])[:8]
    return percent, top


def _extract_year_ranges(text: str) -> list[tuple[int, int]]:
    ranges = []
    for m in re.finditer(r"(19|20)\d{2}\s*[-\u2013]\s*((19|20)\d{2}|present|current)", text, re.I):
        span = m.group(0)
        parts = re.split(r"[-\u2013]", span)
        if len(parts) >= 2:
            try:
                start_y = int(parts[0].strip())
                end_raw = parts[-1].strip().lower()
                end_y = 2026 if ("present" in end_raw or "current" in end_raw) else int(end_raw)
                if end_y >= start_y:
                    ranges.append((start_y, end_y))
            except ValueError:
                pass
    return ranges


def _estimate_cv_years(cv_text: str) -> int | None:
    ranges = _extract_year_ranges(cv_text)
    if not ranges:
        m = re.search(r"(\d+)\+?\s*years?\s*(of)?\s*experience", cv_text, re.I)
        return int(m.group(1)) if m else None
    ranges.sort()
    merged: list[list[int]] = []
    for s, e in ranges:
        if merged and s <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
        else:
            merged.append([s, e])
    return sum(e - s for s, e in merged)


def cv_fit(cv_text: str, job_description: str, job_title: str) -> dict:
    if not cv_text:
        return {"percent": None, "reason": "No CV uploaded yet.", "sub_details": []}

    cv_tokens = {_canon(t) for t in _tokenize(cv_text) if t not in STOP_WORDS}
    required, rest = _extract_requirements(job_description or "")

    req_percent, req_matched = _skill_overlap(cv_tokens, required) if required else (None, [])
    nice_percent, _ = _skill_overlap(cv_tokens, rest or job_description or "")

    cv_years = _estimate_cv_years(cv_text)
    req_years_match = re.search(r"(\d+)\+?\s*years?", job_description or "", re.I)
    req_years = int(req_years_match.group(1)) if req_years_match else None
    experience_percent = None
    experience_note = ""
    if req_years is not None and cv_years is not None:
        if cv_years >= req_years:
            experience_percent = 100
            experience_note = f"Meets the ~{req_years}+ years requirement (estimated {cv_years} yrs on your CV)."
        else:
            gap = req_years - cv_years
            experience_percent = max(0, 100 - gap * 25)
            experience_note = f"Posting asks for ~{req_years}+ years; your CV suggests around {cv_years}, a {gap}-year gap."
    elif req_years is not None:
        experience_note = f"Posting asks for ~{req_years}+ years; couldn't estimate your years of experience from the CV text."

    title_tokens = [t for t in _tokenize(job_title) if t not in STOP_WORDS]
    title_overlap = [t for t in title_tokens if _canon(t) in cv_tokens]
    title_percent = round(len(title_overlap) / len(title_tokens) * 100) if title_tokens else None

    parts = [(req_percent, 0.40), (experience_percent, 0.20), (title_percent, 0.15), (nice_percent, 0.25)]
    parts = [(p, w) for p, w in parts if p is not None]
    weight_sum = sum(w for _, w in parts)
    percent = round(sum(p * w for p, w in parts) / weight_sum) if weight_sum > 0 else 0

    sub_details = []
    if req_percent is not None:
        sub_details.append(f"Required-skills match: {req_percent}%" + (f" ({', '.join(req_matched[:5])})" if req_matched else ""))
    if experience_note:
        sub_details.append(experience_note)
    if title_percent is not None:
        sub_details.append(f"Title alignment: {title_percent}%")
    sub_details.append(f"General keyword overlap: {nice_percent}%")

    reason = (f"Good overall fit with your CV. {sub_details[0]}" if percent >= 65 else
             f"This may not be a strong fit based on your CV — worth deciding if it's worth the time to apply. {sub_details[0]}" if percent <= 35 else
             f"Partial fit — worth a closer read of the full posting. {sub_details[0]}")

    return {"percent": percent, "reason": reason, "sub_details": sub_details}


# ---------------------------------------------------------------------
# evaluate_job: the four-part result, mirroring the extension exactly
# ---------------------------------------------------------------------
def evaluate_job(job: dict, registers: list[Register], cv_text: str, cv_meta: dict | None) -> dict:
    """job: {"title", "company", "location", "description", "applicant_count"?}"""
    sponsor = sponsorability(job, registers)
    pattern = posting_pattern(job.get("description") or "")
    desc_q = description_quality(job.get("description") or "")
    cv = cv_fit(cv_text, job.get("description") or "", job.get("title") or "")
    ats = ats_readiness(cv_text, cv_meta)

    leg_weights = {"sponsor": 0.55, "pattern": 0.30, "desc": 0.15}
    leg_parts = [(sponsor["percent"], leg_weights["sponsor"]),
                 (pattern["percent"], leg_weights["pattern"]),
                 (desc_q["percent"], leg_weights["desc"])]
    leg_parts = [(p, w) for p, w in leg_parts if p is not None]
    leg_weight_sum = sum(w for _, w in leg_parts)
    leg_percent = round(sum(p * w for p, w in leg_parts) / leg_weight_sum) if leg_weight_sum > 0 else None

    leg_verdict = "Needs a closer look"
    if leg_percent is not None:
        if leg_percent >= 75:
            leg_verdict = "Looks legitimate and plausibly sponsorable"
        elif leg_percent <= 35:
            leg_verdict = "Several concerns worth verifying before investing time"

    ats_critical = ats["has_cv"] and not ats["ready"]
    ats_warnings_only = ats["has_cv"] and ats["ready"] and bool(ats["flags"])

    # A single blended score, used as the STARTING point for every branch
    # below and then overridden/capped exactly where the branch's own text
    # already says the number should be low. This is deliberately computed
    # inline with the decision tree rather than separately from it: a
    # parallel scoring function risks disagreeing with the text next to it,
    # which is a worse failure than not having a number at all.
    blend_parts = [(leg_percent, 0.5), (cv["percent"], 0.5)]
    blend_parts = [(p, w) for p, w in blend_parts if p is not None]
    blend_sum = sum(w for _, w in blend_parts)
    blended = round(sum(p * w for p, w in blend_parts) / blend_sum) if blend_sum > 0 else None

    if sponsor["explicit_no_sponsor"]:
        rec_verdict = "Probably skip — unless you don't need sponsorship"
        rec_explanation = "The posting states outright that sponsorship isn't available. Everything else about fit or legitimacy is secondary to this unless your circumstances don't require sponsorship."
        worth_applying = 5
    elif ats_critical:
        rec_verdict = "Fix your CV file first"
        rec_explanation = "Your uploaded CV has at least one issue that commonly causes automated rejection before a human ever sees it. Worth resolving that before spending time (or tokens) on an application here."
        worth_applying = min(blended, 20) if blended is not None else 20
    elif leg_percent is not None and leg_percent <= 30:
        rec_verdict = "Verify carefully before applying"
        rec_explanation = "There are enough open questions about legitimacy or sponsorship here that it's worth confirming directly with the employer before investing time."
        worth_applying = min(blended, 35) if blended is not None else 35
    elif cv["percent"] is not None and cv["percent"] < 25:
        rec_verdict = "Probably not a strong use of your time"
        rec_explanation = "Based on the required skills and experience in the posting, this doesn't look like a close match for your CV — that's a bigger factor than how legitimate or sponsorable the posting is."
        worth_applying = min(blended, 30) if blended is not None else 30
    elif leg_percent is None and cv["percent"] is None:
        rec_verdict = "Not enough information yet"
        rec_explanation = "Add a sponsor register and a CV to get a real recommendation here."
        worth_applying = None
    else:
        leg_tier = "unknown" if leg_percent is None else "high" if leg_percent >= 70 else "medium" if leg_percent >= 40 else "low"
        fit_tier = "unknown" if cv["percent"] is None else "high" if cv["percent"] >= 65 else "medium" if cv["percent"] >= 45 else "low"
        if leg_tier == "high" and fit_tier == "high":
            rec_verdict, rec_explanation = "Worth applying", "Both the legitimacy/sponsorability picture and your CV fit look solid."
        elif leg_tier == "high" and fit_tier == "medium":
            rec_verdict, rec_explanation = "Worth a shot", "Legitimacy and sponsorability look solid; your CV fit is partial — worth tailoring your application to the required skills before applying."
        elif leg_tier == "medium" and fit_tier == "high":
            rec_verdict, rec_explanation = "Good fit — verify sponsorship details first", "Your CV fits well, but double-check the sponsorship/legitimacy details directly with the employer before investing time."
        elif fit_tier == "unknown":
            rec_verdict, rec_explanation = "Add your CV for a personalized read", "Legitimacy looks reasonable so far, but a fit assessment needs your CV."
        elif leg_tier == "unknown":
            rec_verdict, rec_explanation = "Add a sponsor register for a fuller picture", "CV fit is assessed, but sponsorship legitimacy needs a register loaded for this country."
        else:
            rec_verdict, rec_explanation = "Mixed signals — read the full posting carefully", "Neither legitimacy nor fit stands out clearly either way — worth reading the full posting yourself before deciding."
        worth_applying = blended
        # A CV-readiness warning (not critical) shaves a little off the
        # number without changing the verdict tier — it's a real but minor
        # drag on the odds of getting through, not a reason to say "skip".
        if ats_warnings_only and worth_applying is not None:
            worth_applying = max(0, worth_applying - 10)
            rec_explanation += " Also worth a look: some CV formatting details flagged under ATS readiness could still trip up automated screening."

    return {
        "legitimacy": {"percent": leg_percent, "verdict": leg_verdict,
                       "sponsor": sponsor, "pattern": pattern, "description_quality": desc_q},
        "ats": ats,
        "cv_fit": cv,
        "recommendation": {"verdict": rec_verdict, "explanation": rec_explanation,
                           "score": worth_applying},
        "detected_country": detect_country(job.get("location") or "") or detect_country(job.get("description") or ""),
    }


# ---------------------------------------------------------------------
# Database integration — self-contained, does not modify store.py.
# Adds its own `sc_*` columns to the existing `roles` table, following the
# exact same tolerant-of-races ALTER pattern store._ensure_columns() uses,
# so this is safe to run alongside anything else touching the database.
# ---------------------------------------------------------------------


def _try_alter(con, ddl: str) -> None:
    try:
        con.execute(ddl)
    except sqlite3.OperationalError as e:
        if "duplicate column" not in str(e).lower():
            raise


def _ensure_sc_columns(con) -> None:
    """Add this module's own columns to `roles`, if they aren't there yet.

    Mirrors job-radar's own convention: an integer score defaults to -1
    ("not yet judged"), which must stay distinguishable from a real 0 --
    same reasoning as rank.py's own `fit` column.
    """
    cols = {r["name"] for r in con.execute("PRAGMA table_info(roles)")}
    additions = {
        "sc_legitimacy": "INTEGER DEFAULT -1",
        "sc_legitimacy_why": "TEXT DEFAULT ''",
        "sc_ats_ready": "INTEGER DEFAULT -1",   # -1 no CV yet, 0 not ready, 1 ready
        "sc_ats_flags": "TEXT DEFAULT '[]'",
        "sc_cv_fit": "INTEGER DEFAULT -1",
        "sc_cv_fit_why": "TEXT DEFAULT ''",
        "sc_recommendation": "TEXT DEFAULT ''",
        "sc_recommendation_why": "TEXT DEFAULT ''",
        "sc_worth_applying": "INTEGER DEFAULT -1",
    }
    for name, ddl_type in additions.items():
        if name not in cols:
            _try_alter(con, f"ALTER TABLE roles ADD COLUMN {name} {ddl_type}")


def candidates(con, refresh: bool = False) -> list:
    """Roles worth running sponsor-check on. Same shape as rank.candidates().

    Costs nothing (no model call), so unlike `rank`, this is safe to run over
    every live role without asking first -- but still skips roles already
    checked unless refresh is asked for, so re-running doesn't waste time on
    a large board.
    """
    _ensure_sc_columns(con)
    from . import store
    store._ensure_columns(con)
    q = ("SELECT r.* FROM roles r LEFT JOIN role_state s ON s.uid=r.uid "
         "WHERE COALESCE(s.status,'new') NOT IN "
         "('rejected','withdrawn','skipped','closed') "
         f"AND {store.LIVE_SQL}")
    if not refresh:
        q += " AND COALESCE(r.sc_legitimacy,-1) < 0"
    return con.execute(q + " ORDER BY r.score DESC").fetchall()


def record(con, uid: str, result: dict) -> None:
    """Write one role's evaluate_job() result back to its row. Returns the
    numeric worth_applying score (or None), so callers like
    evaluate_and_store() can act on it without a second query.
    """
    _ensure_sc_columns(con)
    leg = result["legitimacy"]
    ats = result["ats"]
    cv = result["cv_fit"]
    rec = result["recommendation"]
    ats_ready_val = -1 if not ats["has_cv"] else (1 if ats["ready"] else 0)
    worth = rec.get("score")
    con.execute(
        """UPDATE roles SET sc_legitimacy=?, sc_legitimacy_why=?,
           sc_ats_ready=?, sc_ats_flags=?, sc_cv_fit=?, sc_cv_fit_why=?,
           sc_recommendation=?, sc_recommendation_why=?, sc_worth_applying=?
           WHERE uid=?""",
        (leg["percent"] if leg["percent"] is not None else -1,
         leg["verdict"],
         ats_ready_val,
         json.dumps(ats["flags"]),
         cv["percent"] if cv["percent"] is not None else -1,
         cv["reason"],
         rec["verdict"], rec["explanation"],
         worth if worth is not None else -1,
         uid))
    return worth


# ---------------------------------------------------------------------
# UK sponsor register auto-fetch (mirrors the browser extension's
# background.js logic), using `requests`, which job-radar already depends
# on -- no new dependency.
# ---------------------------------------------------------------------
UK_REGISTER_PAGE = "https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers"
UK_REGISTER_CACHE = "data/uk-sponsor-register.json"
UK_REGISTER_MAX_AGE_DAYS = 7


def _parse_csv_register(csv_text: str) -> list[RegisterEntry]:
    import csv
    import io
    reader = csv.reader(io.StringIO(csv_text))
    rows = list(reader)
    if not rows:
        return []
    header = [h.strip().lower() for h in rows[0]]
    name_idx = next((i for i, h in enumerate(header) if "organisation" in h or "organization" in h or "name" in h), 0)
    rating_idx = next((i for i, h in enumerate(header) if "rating" in h), None)
    route_idx = next((i for i, h in enumerate(header) if "route" in h), None)
    entries = []
    for row in rows[1:]:
        if len(row) <= name_idx or not row[name_idx].strip():
            continue
        rating = ""
        if rating_idx is not None and len(row) > rating_idx:
            m = re.search(r"\b([AB])\b", row[rating_idx], re.I)
            rating = m.group(1).upper() if m else ""
        route = row[route_idx].strip() if route_idx is not None and len(row) > route_idx else ""
        entries.append(RegisterEntry(name=row[name_idx].strip(), rating=rating, route=route))
    return entries


def fetch_uk_register(cache_path: str = UK_REGISTER_CACHE, max_age_days: int = UK_REGISTER_MAX_AGE_DAYS) -> Register:
    """The UK sponsor register, auto-downloaded and cached locally.

    Refreshes at most once every `max_age_days`; otherwise reads the cache,
    so this doesn't hit gov.uk on every run. Requires `requests`, which
    job-radar already depends on.
    """
    import time as _time

    cache = Path(cache_path)
    if cache.exists():
        age_days = (_time.time() - cache.stat().st_mtime) / 86400
        if age_days < max_age_days:
            try:
                data = json.loads(cache.read_text(encoding="utf-8"))
                entries = [RegisterEntry(**e) for e in data.get("entries", [])]
                return Register(country="UK", entries=entries)
            except (json.JSONDecodeError, OSError):
                pass  # fall through and refetch

    import requests
    try:
        page = requests.get(UK_REGISTER_PAGE, timeout=20)
        page.raise_for_status()
        m = re.search(r"https://assets\.publishing\.service\.gov\.uk/[^\"'\s]+\.csv", page.text, re.I)
        if not m:
            m = re.search(r'href="([^"]+\.csv)"', page.text, re.I)
            csv_url = m.group(1) if m else None
        else:
            csv_url = m.group(0)
        if not csv_url:
            raise RuntimeError("couldn't find the CSV link on the GOV.UK page — layout may have changed")
        csv_resp = requests.get(csv_url, timeout=60)
        csv_resp.raise_for_status()
        entries = _parse_csv_register(csv_resp.text)
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({
            "entries": [{"name": e.name, "rating": e.rating, "route": e.route} for e in entries],
            "fetched_at": date_str(),
        }), encoding="utf-8")
        return Register(country="UK", entries=entries)
    except Exception as e:
        if cache.exists():
            # A stale cache beats no data at all — use it and let the caller
            # know it's outdated rather than failing the whole run.
            try:
                data = json.loads(cache.read_text(encoding="utf-8"))
                entries = [RegisterEntry(**e) for e in data.get("entries", [])]
                return Register(country="UK", entries=entries)
            except (json.JSONDecodeError, OSError):
                pass
        raise RuntimeError(f"couldn't fetch or read a cached UK sponsor register: {e}")


def date_str() -> str:
    from datetime import date as _date
    return _date.today().isoformat()


def load_registers(extra_csv_paths: dict[str, str] | None = None) -> list[Register]:
    """UK auto-fetched, plus any manually supplied country: path CSVs.

    extra_csv_paths: {"NL": "sponsor_registers/NL.csv", ...}
    """
    registers = []
    try:
        registers.append(fetch_uk_register())
    except Exception as e:
        print(f"  ! sponsor-check: {e}")
    for country, path in (extra_csv_paths or {}).items():
        p = Path(path)
        if p.exists():
            entries = _parse_csv_register(p.read_text(encoding="utf-8", errors="ignore"))
            registers.append(Register(country=country, entries=entries))
    return registers


def _skip_role(con, uid: str, note: str) -> None:
    """Mark a role skipped via the same role_state table the rest of
    job-radar already uses for status changes (new/interested/applied/...).
    Written directly against the schema rather than assuming a specific
    store.py helper name for this, since store.py's own status-setting
    function (used by cmd_rescreen etc.) wasn't directly available to
    check against -- this matches the role_state table definition exactly
    as confirmed in store.py's SCHEMA.
    """
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    con.execute(
        """INSERT INTO role_state (uid, status, note, updated_at)
           VALUES (?, 'skipped', ?, ?)
           ON CONFLICT(uid) DO UPDATE SET status='skipped',
               note=excluded.note, updated_at=excluded.updated_at""",
        (uid, note, now))


def screen_summary(rec: dict) -> str:
    """A short label for the collapsed <details> pill, starting with APPLY
    or SKIP so the dashboard's existing CSS (.v.skip / .v.apply, red/green)
    picks it up automatically -- same convention a Claude-written screening
    already used there.
    """
    low = (rec.get("verdict") or "").lower()
    if any(w in low for w in ("skip", "fix your cv", "not a strong use",
                              "verify carefully")):
        prefix = "SKIP"
    elif any(w in low for w in ("worth applying", "worth a shot", "good fit")):
        prefix = "APPLY"
    else:
        prefix = "REVIEW"
    score = rec.get("score")
    score_txt = f" {score}/100" if score is not None else ""
    return f"{prefix}{score_txt} — {rec.get('verdict', '')}"


def screening_markdown(result: dict) -> str:
    """A markdown narrative from evaluate_job()'s result, for the exact
    same inline <details class="screening"> slot the dashboard already
    renders a Claude-written screening into -- generated instantly and for
    free instead, from the same underlying analysis.
    """
    leg = result["legitimacy"]
    ats = result["ats"]
    cv = result["cv_fit"]
    rec = result["recommendation"]

    lines = ["#### Legitimacy & sponsorability"]
    if leg["percent"] is not None:
        lines.append(f"**{leg['percent']}/100** — {leg['verdict']}")
    else:
        lines.append("Not enough information to score this yet.")
    for detail in leg["sponsor"].get("sub_details", []):
        lines.append(f"- {detail}")
    if leg["pattern"]["percent"] is not None:
        lines.append(f"- {leg['pattern']['reason']}")

    lines += ["", "#### ATS readiness"]
    if not ats["has_cv"]:
        lines.append("No CV loaded, so this couldn't be checked.")
    elif not ats["flags"]:
        lines.append("No issues found.")
    else:
        for flag in ats["flags"]:
            marker = "**Critical:**" if flag["severity"] == "critical" else "Warning:"
            lines.append(f"- {marker} {flag['text']}")

    lines += ["", "#### CV fit"]
    if cv["percent"] is not None:
        lines.append(f"**{cv['percent']}/100**")
        for detail in cv.get("sub_details", []):
            lines.append(f"- {detail}")
    else:
        lines.append(cv["reason"])

    lines += ["", "#### Recommendation"]
    score_txt = f" ({rec['score']}/100)" if rec.get("score") is not None else ""
    lines.append(f"**{rec['verdict']}{score_txt}**")
    lines.append(rec["explanation"])

    return "\n".join(lines)


# Matches screen.MIN_DESCRIPTION_LEN. Kept as its own copy rather than an
# import -- this module says elsewhere it is self-contained on purpose --
# but the two numbers are meant to agree: below this many characters,
# neither the dealbreaker scan nor CV-fit/legitimacy scoring here has enough
# text to mean anything, so a role that thin is a guess dressed up as a
# score either way.
MIN_DESCRIPTION_LEN = 200


def evaluate_and_store(con, cfg, refresh: bool = False, extra_registers: dict[str, str] | None = None,
                       on_progress=None, skip_below: int | None = None,
                       require_description: bool = False,
                       cv_fit_skip_below: int | None = None) -> tuple[int, int]:
    """Run sponsor-check over every unchecked candidate role. Costs nothing
    (no model call) so this is safe to run as part of a normal scan.

    Three independent, all-opt-in ways a role gets auto-skipped, checked in
    this order and each final on its own -- a role is skipped for the first
    one that applies, not scored again against the rest:

    require_description: a role whose description is still under
    MIN_DESCRIPTION_LEN characters after enrichment has nothing real to
    judge fit or legitimacy against, so `evaluate_job()`'s score for it is a
    guess wearing a number. Skipping these outright is more honest than
    keeping a "maybe" you cannot actually back up.

    cv_fit_skip_below: unlike `skip_below` below, this looks at CV fit on
    its own rather than the blended score. The blend weights legitimacy and
    CV fit 50/50, so a role from a rock-solid registered sponsor with a
    CV-fit percent of 0 can still clear a `skip_below` of 40 on legitimacy
    alone -- exactly the case this catches, since no amount of employer
    legitimacy makes a role worth writing a cover letter for if nothing on
    your CV matches it.

    skip_below: if set, any role whose worth_applying score comes back
    below this threshold is marked 'skipped' via role_state -- the same
    status a person setting it manually would produce, so it disappears
    from the board the normal way. A role that couldn't be scored at all
    (score is None -- e.g. no CV loaded) is never auto-skipped by this one,
    since there's nothing to judge it against.

    All three default to off: each is a real, visible side effect (roles
    vanish from view), not something to do silently without being asked.

    Returns (checked, skipped): how many roles were evaluated in total, and
    how many of those were auto-skipped by any of the three.
    """
    from . import cvtext

    rows = candidates(con, refresh=refresh)
    if not rows:
        return 0, 0

    registers = load_registers(extra_registers)

    cv_text = ""
    cv_meta = None
    try:
        cv_text = cvtext.cv_text(cfg, limit=0)
        cv_meta = _cv_meta_for(cfg)
    except SystemExit as e:
        print(f"  ! sponsor-check: {e} (continuing without CV-based scoring)")

    done = 0
    skipped = 0
    for r in rows:
        desc = r["description"] or ""
        job = {"title": r["title"] or "", "company": r["company"] or "",
               "location": r["location"] or "", "description": desc}
        result = evaluate_job(job, registers, cv_text, cv_meta)
        worth = record(con, r["uid"], result)
        desc_len = len(desc.strip())
        cv_pct = result["cv_fit"]["percent"]
        if require_description and desc_len < MIN_DESCRIPTION_LEN:
            _skip_role(con, r["uid"],
                      f"sponsor-check: only {desc_len} character(s) of "
                      f"description came back for this posting -- too "
                      f"thin to judge fit or legitimacy against, so it "
                      f"was skipped rather than scored on a guess")
            skipped += 1
        elif (cv_fit_skip_below is not None and cv_pct is not None
              and cv_pct < cv_fit_skip_below):
            _skip_role(con, r["uid"],
                      f"sponsor-check: CV fit was {cv_pct}%, below your "
                      f"{cv_fit_skip_below}% threshold, regardless of how "
                      f"legitimate or sponsorable the posting looks "
                      f"otherwise")
            skipped += 1
        elif skip_below is not None and worth is not None and worth < skip_below:
            _skip_role(con, r["uid"],
                      f"sponsor-check: worth-applying score {worth} was "
                      f"below your {skip_below} threshold "
                      f"({result['recommendation']['verdict']})")
            skipped += 1
        done += 1
        if on_progress:
            on_progress(done, len(rows))
    return done, skipped


def _cv_meta_for(cfg) -> dict | None:
    """Best-effort ATS metadata for the configured CV (avg chars/page for a
    PDF, used only to flag a likely-scanned PDF). Uses the same optional
    pypdf dependency rank.py already relies on; skipped gracefully if it's
    not installed or the CV isn't a PDF.
    """
    p = Path(cfg.cv_path).expanduser()
    if p.suffix.lower() != ".pdf":
        return {"method": p.suffix.lower().lstrip("."), "avg_chars_per_page": None}
    try:
        from pypdf import PdfReader
        reader = PdfReader(str(p))
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
        avg = round(len(text) / max(1, len(reader.pages)))
        return {"method": "pdf", "avg_chars_per_page": avg}
    except Exception:
        return {"method": "pdf", "avg_chars_per_page": None}
