/*
 * Sponsorability, posting-pattern, ATS-readiness and CV-fit scoring.
 *
 * A line-for-line JS port of job-radar's `sponsor_check.py`, which is itself
 * described there as "ported from the Sponsor Check browser extension into
 * job-radar's own codebase" -- this brings the same, already-battle-tested
 * logic back into the browser, so the score you see here and the score
 * job-radar's dashboard shows for the same posting are computed the same
 * way, not a re-guess of it.
 *
 * Everything here is pure and synchronous except `fetchUkRegister`, which
 * needs the network. No LLM, no API key, nothing sent anywhere except the
 * one GOV.UK request to refresh the sponsor register -- your CV and the job
 * text you are scored against never leave this browser.
 *
 * Loaded as a plain classic script (no ES module wrapper) so it works
 * unchanged from the background service worker (via importScripts) and the
 * options/popup pages (via a <script> tag) alike; everything it defines
 * hangs off `self.SponsorCheck`.
 */
(function (root) {
  "use strict";

  // -----------------------------------------------------------------
  // Country detection (GB + EU scope) -- mirrors COUNTRY_ALIASES exactly.
  // -----------------------------------------------------------------
  const COUNTRY_ALIASES = {
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
  };

  // Python 3's round() rounds half-to-even (banker's rounding), while
  // JavaScript's native Math.round() rounds half away from zero -- the two
  // disagree on exact .5 cases (round(76.5) is 76 in Python, 77 with
  // Math.round). Every percentage here is meant to match job-radar's own
  // Python scoring number for number, not just tier for tier, so every
  // score below is finalized through this instead of Math.round.
  function pyRound(x) {
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff < 0.5) return floor;
    if (diff > 0.5) return floor + 1;
    return (floor % 2 === 0) ? floor : floor + 1;
  }

  function detectCountry(text) {
    const low = (text || "").toLowerCase();
    for (const alias in COUNTRY_ALIASES) {
      if (low.includes(alias)) return COUNTRY_ALIASES[alias];
    }
    return "";
  }

  // -----------------------------------------------------------------
  // Legitimacy & sponsorability
  // -----------------------------------------------------------------
  const UK_SALARY_GENERAL = 41700;
  const UK_SALARY_NEW_ENTRANT = 33400;
  const UK_SALARY_PHD_STEM = 37500;
  const UK_SALARY_HEALTH_CARE = 25000;

  const POSITIVE_SPONSOR_PATTERNS = [
    /visa sponsorship (?:is |will be )?available/i,
    /\bwe (?:can |will |do |are able to )?sponsor\b/i,
    /sponsorship (?:is |will be )?offered/i,
    /able to sponsor/i,
    /open to sponsoring/i,
    /will sponsor/i,
  ];
  const NEGATIVE_SPONSOR_PATTERNS = [
    /(?:do|does)\s+not\s+(?:currently\s+)?(?:offer|provide)\s+(?:\w+\s+){0,2}sponsorship/i,
    /unable to (?:offer|provide)\s+(?:\w+\s+){0,2}sponsorship/i,
    /\bno\s+(?:\w+\s+){0,2}sponsorship\b/i,
    /unable to sponsor/i,
    /cannot sponsor/i,
    /must have the right to work/i,
    /must have right to work/i,
    /not sponsoring/i,
    /without the need for\s+(?:\w+\s+){0,2}sponsorship/i,
  ];
  const ENTRY_LEVEL_PHRASES = ["graduate", "junior", "intern", "internship",
    "entry level", "entry-level", "trainee"];
  const LARGE_EMPLOYER_PHRASES = ["fortune 500", "fortune 100", "multinational",
    "ftse 100", "ftse 250", "global company",
    "offices in over", "operates in over", "plc",
    "group of companies"];

  const SALARY_PATTERNS = [
    /£\s?([\d,]{4,7})(?:\.\d+)?\s?(k)?/i,
    /(?:gbp|usd|eur|\$|€)\s?([\d,]{4,7})(?:\.\d+)?\s?(k)?/i,
    /([\d,]{4,7})\s?(k)?\s?(?:per year|per annum|annually|\/year|a year)/i,
  ];

  function extractSalary(text) {
    for (const pattern of SALARY_PATTERNS) {
      const m = (text || "").match(pattern);
      if (m) {
        let val = parseInt(m[1].replace(/,/g, ""), 10);
        if (m[2]) val *= 1000;
        if (val >= 1000) return val;
      }
    }
    return null;
  }

  function normCompany(name) {
    return (name || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  }

  function findRegisterEntry(companyNorm, applicable) {
    for (const register of applicable) {
      for (const entry of register.entries) {
        const n = normCompany(entry.name);
        if (n && (n === companyNorm || companyNorm.includes(n) || n.includes(companyNorm))) {
          return { entry, country: register.country };
        }
      }
    }
    return null;
  }

  function registeredCompany(company, registers) {
    const companyNorm = normCompany(company);
    if (!companyNorm || !registers || !registers.length) return false;
    return findRegisterEntry(companyNorm, registers) !== null;
  }

  function sponsorability(job, registers) {
    const desc = (job.description || "").toLowerCase();
    const companyNorm = normCompany(job.company);
    const country = detectCountry(job.location || "") || detectCountry(job.description || "");
    const subDetails = [];

    let neg = null, pos = null;
    for (const p of NEGATIVE_SPONSOR_PATTERNS) {
      const m = desc.match(p);
      if (m) { neg = m[0]; break; }
    }
    for (const p of POSITIVE_SPONSOR_PATTERNS) {
      const m = desc.match(p);
      if (m) { pos = m[0]; break; }
    }
    if (neg) {
      return {
        percent: 5,
        reason: `This posting states outright that sponsorship isn't available ("${neg}"). Worth trusting what the employer wrote here over other signals.`,
        subDetails: [`Posting states: "${neg}"`],
        explicitNoSponsor: true,
      };
    }

    let registerScore = null, registerNote;
    if (!companyNorm) {
      registerNote = "Couldn't read a company name to check.";
    } else {
      const applicable = country ? registers.filter((r) => r.country === country) : registers;
      if (!applicable.length) {
        registerNote = country
          ? `No sponsor register is loaded for ${country} yet — add one if one is publicly available for that country.`
          : "Couldn't determine the job's country, and no registers are loaded.";
      } else {
        const found = findRegisterEntry(companyNorm, applicable);
        if (!found) {
          registerScore = 25;
          registerNote = `No match found for this company on the ${country || applicable[0].country} register loaded. This could mean the company isn't a licensed sponsor there yet, or simply that its registered name differs slightly — worth checking directly rather than ruling it out.`;
        } else {
          const { entry, country: foundCountry } = found;
          registerScore = 80;
          registerNote = `Found on the ${foundCountry} sponsor register.`;
          if (entry.rating === "A") {
            registerScore = 100;
            registerNote += " Licence rating: A.";
          } else if (entry.rating === "B") {
            registerScore = 45;
            registerNote += " Licence rating: B — sponsors with a B rating are sometimes temporarily restricted from assigning new Certificates of Sponsorship while addressing compliance requirements, so it's worth asking the employer directly about current status.";
          }
          if (entry.route) {
            const roleLooksPermanent = !/(intern|seasonal|temporary|placement)/i.test(job.title || "");
            if (entry.route.toLowerCase().includes("temporary") && roleLooksPermanent) {
              registerScore = Math.min(registerScore, 40);
              registerNote += ` Licence route is "${entry.route}", which may not cover a permanent hire.`;
            } else {
              registerNote += ` Licence route: ${entry.route}.`;
            }
          }
        }
      }
    }
    subDetails.push(registerNote);

    let salaryScore = null;
    const salary = extractSalary(job.description || "");
    if (country === "UK" && salary !== null) {
      const isHealth = /\b(nhs|health|care worker|social care|nurse)\b/.test(desc);
      const isPhd = desc.includes("phd");
      const isNewEntrant = ENTRY_LEVEL_PHRASES.some((p) => desc.includes(p));
      const floor = isHealth ? UK_SALARY_HEALTH_CARE :
        isPhd ? UK_SALARY_PHD_STEM :
          isNewEntrant ? UK_SALARY_NEW_ENTRANT : UK_SALARY_GENERAL;
      if (salary >= UK_SALARY_GENERAL) {
        salaryScore = 100;
        subDetails.push(`Advertised salary (~£${salary.toLocaleString()}) clears the general £${UK_SALARY_GENERAL.toLocaleString()} threshold.`);
      } else if (salary >= floor) {
        salaryScore = 70;
        subDetails.push(`Advertised salary (~£${salary.toLocaleString()}) is below the general threshold but may clear a discounted floor (~£${floor.toLocaleString()}) — confirm which applies.`);
      } else {
        salaryScore = 15;
        subDetails.push(`Advertised salary (~£${salary.toLocaleString()}) appears below even the discounted Skilled Worker floors — this role likely isn't sponsorable as priced. Always check the specific occupation's "going rate" too.`);
      }
    } else if (country === "UK") {
      subDetails.push("No salary figure found in the posting to check against the visa threshold.");
    } else if (country) {
      subDetails.push(`Salary-threshold checking is only implemented for the UK so far — ${country} has its own rules not modeled here.`);
    }

    let languageScore = null;
    if (pos) {
      languageScore = 100;
      subDetails.push(`The posting itself mentions sponsorship: "${pos}".`);
    }

    const titleAndDesc = ((job.title || "") + " " + (job.description || "")).toLowerCase();
    const entryPhrase = ENTRY_LEVEL_PHRASES.find((p) => titleAndDesc.includes(p));
    let seniorityScore = null;
    if (entryPhrase) {
      seniorityScore = 35;
      subDetails.push(`This reads as an entry-level/graduate/junior role ("${entryPhrase}"). Employers sponsor these less often on average, purely for cost and process reasons — it doesn't mean this specific one won't.`);
    }

    const largePhrase = LARGE_EMPLOYER_PHRASES.find((p) => desc.includes(p));
    if (largePhrase) {
      subDetails.push(`The posting suggests a larger or multinational employer ("${largePhrase}"), and bigger employers more often have existing sponsorship infrastructure — a loose statistical tendency, not a guarantee for this role.`);
    }

    const parts = [[registerScore, 0.40], [salaryScore, 0.30], [languageScore, 0.15], [seniorityScore, 0.15]]
      .filter(([p]) => p !== null);
    const weightSum = parts.reduce((s, [, w]) => s + w, 0);
    const percent = weightSum > 0 ? pyRound(parts.reduce((s, [p, w]) => s + p * w, 0) / weightSum) : null;

    return {
      percent,
      reason: subDetails[0] || "Not enough information yet to estimate sponsorship likelihood.",
      subDetails,
      explicitNoSponsor: false,
    };
  }

  // -----------------------------------------------------------------
  // Posting-pattern check
  // -----------------------------------------------------------------
  const CAUTION_PHRASES = ["wire transfer", "processing fee", "registration fee",
    "pay a fee", "training fee", "send your bank details", "whatsapp only",
    "telegram only", "no interview necessary", "immediate start no experience",
    "work from home earn", "send money", "purchase equipment yourself",
    "reply with your full name and address", "gift card"];
  const URGENCY_PHRASES = ["apply now limited spots", "only a few positions left",
    "act fast", "immediate joining only"];

  function postingPattern(description) {
    const desc = (description || "").toLowerCase();
    if (!desc.trim()) return { percent: null, reason: "No description text available to check." };
    const found = CAUTION_PHRASES.filter((p) => desc.includes(p));
    const foundUrgency = URGENCY_PHRASES.filter((p) => desc.includes(p));
    let percent = 100;
    let reason = "No notable red-flag phrasing spotted in the text.";
    if (found.length) {
      percent -= 35 * found.length;
      reason = `This posting includes phrasing sometimes seen in lower-quality or fraudulent listings (e.g. "${found[0]}"). This is not proof of anything wrong — plenty of genuine postings use ordinary business language that happens to overlap — but it's worth verifying details directly with the employer before sharing personal or financial information.`;
    }
    if (foundUrgency.length) {
      percent -= 10;
      reason += " It also leans on urgency language, which is worth noticing but isn't unusual in genuine recruiting either.";
    }
    percent = Math.max(0, Math.min(100, percent));
    return { percent, reason };
  }

  function descriptionQuality(description) {
    const desc = description || "";
    if (!desc.trim()) return { percent: null, reason: "No description text available." };
    if (desc.length < 200) return { percent: 30, reason: "The description is on the short side, so there's less here to evaluate — that's true of some genuine postings too, just worth reading the full listing directly." };
    if (desc.length > 800) return { percent: 90, reason: "Description is detailed, consistent with a genuine posting." };
    return { percent: 65, reason: "Description length is unremarkable." };
  }

  // -----------------------------------------------------------------
  // ATS readiness (flags, not a percentage) -- cvMeta: {method, avgCharsPerPage}
  // -----------------------------------------------------------------
  function atsReadiness(cvText, cvMeta) {
    if (!cvText || !cvMeta) return { hasCv: false, ready: null, flags: [] };
    const flags = [];
    if (cvMeta.method === "pdf" && cvMeta.avgCharsPerPage !== null && cvMeta.avgCharsPerPage !== undefined
      && cvMeta.avgCharsPerPage < 100) {
      flags.push({ severity: "critical", text: "This PDF looks like it may be a scanned image rather than searchable text. Many ATS platforms can't read image-based PDFs at all — this is often an instant rejection regardless of your actual experience. A text-based PDF or Word (.docx) file is much safer." });
    }
    const hasEmail = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(cvText);
    if (!hasEmail) {
      flags.push({ severity: "critical", text: "Couldn't find an email address in the extracted text — ATS platforms rely on this to file your application, so this can also mean it never reaches a person." });
    }
    if (cvText.length < 300) {
      flags.push({ severity: "warning", text: "The extracted text is quite short — worth double-checking the file uploaded correctly and includes your full CV." });
    } else if (cvText.length > 20000) {
      flags.push({ severity: "warning", text: "This is a long document — some ATS platforms truncate very long CVs, so details near the end could be missed." });
    }
    const lower = cvText.toLowerCase();
    const sections = [["experience", /\b(experience|employment history|work history)\b/],
      ["education", /\beducation\b/], ["skills", /\bskills\b/]];
    for (const [label, pattern] of sections) {
      if (!pattern.test(lower)) {
        flags.push({ severity: "warning", text: `Couldn't find a clearly labeled "${label}" section — standard headings help both ATS parsers and human reviewers scan a CV quickly.` });
      }
    }
    const lines = cvText.split("\n");
    const linesWithGaps = lines.filter((l) => /\S {4,}\S/.test(l.trim())).length;
    const totalLines = Math.max(1, lines.filter((l) => l.trim()).length);
    if (linesWithGaps / totalLines > 0.15) {
      flags.push({ severity: "warning", text: "The text extraction suggests this CV may use multi-column layout or tables. Many ATS parsers read these out of order or drop content entirely — a single-column layout is the safest bet." });
    }
    const hasCritical = flags.some((f) => f.severity === "critical");
    return { hasCv: true, ready: !hasCritical, flags };
  }

  // -----------------------------------------------------------------
  // CV fit
  // -----------------------------------------------------------------
  const SYNONYMS = {
    js: "javascript", javascript: "javascript", node: "nodejs", nodejs: "nodejs",
    "node.js": "nodejs", reactjs: "react", "react.js": "react", ts: "typescript",
    typescript: "typescript", py: "python", python: "python", postgres: "postgresql",
    postgresql: "postgresql", k8s: "kubernetes", kubernetes: "kubernetes",
    ml: "machine learning", "machine learning": "machine learning",
    ai: "artificial intelligence", aws: "amazon web services",
    "amazon web services": "amazon web services", gcp: "google cloud",
    "google cloud platform": "google cloud", "ci/cd": "cicd", cicd: "cicd",
    "continuous integration": "cicd", nlp: "natural language processing",
    db: "database", dbs: "database", excel: "microsoft excel",
    msexcel: "microsoft excel",
  };
  const STOP_WORDS = new Set(("the and a to of in for with on is are as an we you your "
    + "our will be or this that team work role company job looking experience "
    + "skills ability strong using years year knowledge based building right "
    + "candidate").split(/\s+/));

  function tokenize(s) {
    return (s || "").toLowerCase().match(/[a-z][a-z0-9+#.]{1,}/g) || [];
  }
  function canon(token) {
    return SYNONYMS[token] || token;
  }
  function extractRequirements(desc) {
    desc = desc || "";
    const m = desc.match(/(requirements|must have|required qualifications|minimum qualifications|what you'll need|you have|essential)[:\s]/i);
    if (!m) return ["", desc];
    const start = m.index + m[0].length;
    const after = desc.slice(start);
    const m2 = after.match(/(nice to have|preferred|desirable|bonus|about us|benefits|perks)[:\s]/i);
    const end = m2 ? m2.index : Math.min(after.length, 600);
    const required = after.slice(0, end);
    const rest = desc.slice(0, m.index) + after.slice(end);
    return [required, rest];
  }
  function skillOverlap(cvTokens, jobText) {
    const jobTokens = tokenize(jobText).map(canon).filter((t) => !STOP_WORDS.has(t));
    if (!jobTokens.length) return [null, []];
    const freq = {};
    for (const t of jobTokens) freq[t] = (freq[t] || 0) + 1;
    const unique = Object.keys(freq);
    const matched = unique.filter((t) => cvTokens.has(t));
    const percent = pyRound((matched.length / unique.length) * 100);
    const top = matched.slice().sort((a, b) => freq[b] - freq[a]).slice(0, 8);
    return [percent, top];
  }
  function extractYearRanges(text) {
    const ranges = [];
    const re = /(19|20)\d{2}\s*[-–]\s*((19|20)\d{2}|present|current)/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      const parts = m[0].split(/[-–]/);
      if (parts.length >= 2) {
        const startY = parseInt(parts[0].trim(), 10);
        const endRaw = parts[parts.length - 1].trim().toLowerCase();
        const endY = (endRaw.includes("present") || endRaw.includes("current")) ? 2026 : parseInt(endRaw, 10);
        if (!isNaN(startY) && !isNaN(endY) && endY >= startY) ranges.push([startY, endY]);
      }
    }
    return ranges;
  }
  function estimateCvYears(cvText) {
    const ranges = extractYearRanges(cvText);
    if (!ranges.length) {
      const m = cvText.match(/(\d+)\+?\s*years?\s*(of)?\s*experience/i);
      return m ? parseInt(m[1], 10) : null;
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of ranges) {
      if (merged.length && s <= merged[merged.length - 1][1]) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
      } else {
        merged.push([s, e]);
      }
    }
    return merged.reduce((sum, [s, e]) => sum + (e - s), 0);
  }

  function cvFit(cvText, jobDescription, jobTitle) {
    if (!cvText) return { percent: null, reason: "No CV uploaded yet.", subDetails: [] };
    const cvTokens = new Set(tokenize(cvText).map(canon).filter((t) => !STOP_WORDS.has(t)));
    const [required, rest] = extractRequirements(jobDescription || "");
    const [reqPercent, reqMatched] = required ? skillOverlap(cvTokens, required) : [null, []];
    const [nicePercent] = skillOverlap(cvTokens, rest || jobDescription || "");

    const cvYears = estimateCvYears(cvText);
    const reqYearsMatch = (jobDescription || "").match(/(\d+)\+?\s*years?/i);
    const reqYears = reqYearsMatch ? parseInt(reqYearsMatch[1], 10) : null;
    let experiencePercent = null, experienceNote = "";
    if (reqYears !== null && cvYears !== null) {
      if (cvYears >= reqYears) {
        experiencePercent = 100;
        experienceNote = `Meets the ~${reqYears}+ years requirement (estimated ${cvYears} yrs on your CV).`;
      } else {
        const gap = reqYears - cvYears;
        experiencePercent = Math.max(0, 100 - gap * 25);
        experienceNote = `Posting asks for ~${reqYears}+ years; your CV suggests around ${cvYears}, a ${gap}-year gap.`;
      }
    } else if (reqYears !== null) {
      experienceNote = `Posting asks for ~${reqYears}+ years; couldn't estimate your years of experience from the CV text.`;
    }

    const titleTokens = tokenize(jobTitle).filter((t) => !STOP_WORDS.has(t));
    const titleOverlap = titleTokens.filter((t) => cvTokens.has(canon(t)));
    const titlePercent = titleTokens.length ? pyRound((titleOverlap.length / titleTokens.length) * 100) : null;

    const parts = [[reqPercent, 0.40], [experiencePercent, 0.20], [titlePercent, 0.15], [nicePercent, 0.25]]
      .filter(([p]) => p !== null);
    const weightSum = parts.reduce((s, [, w]) => s + w, 0);
    const percent = weightSum > 0 ? pyRound(parts.reduce((s, [p, w]) => s + p * w, 0) / weightSum) : 0;

    const subDetails = [];
    if (reqPercent !== null) {
      subDetails.push(`Required-skills match: ${reqPercent}%` + (reqMatched.length ? ` (${reqMatched.slice(0, 5).join(", ")})` : ""));
    }
    if (experienceNote) subDetails.push(experienceNote);
    if (titlePercent !== null) subDetails.push(`Title alignment: ${titlePercent}%`);
    subDetails.push(`General keyword overlap: ${nicePercent}%`);

    const reason = percent >= 65
      ? `Good overall fit with your CV. ${subDetails[0]}`
      : percent <= 35
        ? `This may not be a strong fit based on your CV — worth deciding if it's worth the time to apply. ${subDetails[0]}`
        : `Partial fit — worth a closer read of the full posting. ${subDetails[0]}`;

    return { percent, reason, subDetails };
  }

  // -----------------------------------------------------------------
  // evaluateJob: the four-part result, mirroring job-radar/the original
  // extension exactly.
  // -----------------------------------------------------------------
  function evaluateJob(job, registers, cvText, cvMeta) {
    const sponsor = sponsorability(job, registers);
    const pattern = postingPattern(job.description || "");
    const descQ = descriptionQuality(job.description || "");
    const cv = cvFit(cvText, job.description || "", job.title || "");
    const ats = atsReadiness(cvText, cvMeta);

    const legParts = [[sponsor.percent, 0.55], [pattern.percent, 0.30], [descQ.percent, 0.15]]
      .filter(([p]) => p !== null);
    const legWeightSum = legParts.reduce((s, [, w]) => s + w, 0);
    const legPercent = legWeightSum > 0 ? pyRound(legParts.reduce((s, [p, w]) => s + p * w, 0) / legWeightSum) : null;

    let legVerdict = "Needs a closer look";
    if (legPercent !== null) {
      if (legPercent >= 75) legVerdict = "Looks legitimate and plausibly sponsorable";
      else if (legPercent <= 35) legVerdict = "Several concerns worth verifying before investing time";
    }

    const atsCritical = ats.hasCv && !ats.ready;
    const atsWarningsOnly = ats.hasCv && ats.ready && ats.flags.length > 0;

    const blendParts = [[legPercent, 0.5], [cv.percent, 0.5]].filter(([p]) => p !== null);
    const blendSum = blendParts.reduce((s, [, w]) => s + w, 0);
    const blended = blendSum > 0 ? pyRound(blendParts.reduce((s, [p, w]) => s + p * w, 0) / blendSum) : null;

    let recVerdict, recExplanation, worthApplying;
    if (sponsor.explicitNoSponsor) {
      recVerdict = "Probably skip — unless you don't need sponsorship";
      recExplanation = "The posting states outright that sponsorship isn't available. Everything else about fit or legitimacy is secondary to this unless your circumstances don't require sponsorship.";
      worthApplying = 5;
    } else if (atsCritical) {
      recVerdict = "Fix your CV file first";
      recExplanation = "Your uploaded CV has at least one issue that commonly causes automated rejection before a human ever sees it. Worth resolving that before spending time on an application here.";
      worthApplying = blended !== null ? Math.min(blended, 20) : 20;
    } else if (legPercent !== null && legPercent <= 30) {
      recVerdict = "Verify carefully before applying";
      recExplanation = "There are enough open questions about legitimacy or sponsorship here that it's worth confirming directly with the employer before investing time.";
      worthApplying = blended !== null ? Math.min(blended, 35) : 35;
    } else if (cv.percent !== null && cv.percent < 25) {
      recVerdict = "Probably not a strong use of your time";
      recExplanation = "Based on the required skills and experience in the posting, this doesn't look like a close match for your CV — that's a bigger factor than how legitimate or sponsorable the posting is.";
      worthApplying = blended !== null ? Math.min(blended, 30) : 30;
    } else if (legPercent === null && cv.percent === null) {
      recVerdict = "Not enough information yet";
      recExplanation = "Add your CV in the extension's options to get a real recommendation here.";
      worthApplying = null;
    } else {
      const legTier = legPercent === null ? "unknown" : legPercent >= 70 ? "high" : legPercent >= 40 ? "medium" : "low";
      const fitTier = cv.percent === null ? "unknown" : cv.percent >= 65 ? "high" : cv.percent >= 45 ? "medium" : "low";
      if (legTier === "high" && fitTier === "high") {
        recVerdict = "Worth applying"; recExplanation = "Both the legitimacy/sponsorability picture and your CV fit look solid.";
      } else if (legTier === "high" && fitTier === "medium") {
        recVerdict = "Worth a shot"; recExplanation = "Legitimacy and sponsorability look solid; your CV fit is partial — worth tailoring your application to the required skills before applying.";
      } else if (legTier === "medium" && fitTier === "high") {
        recVerdict = "Good fit — verify sponsorship details first"; recExplanation = "Your CV fits well, but double-check the sponsorship/legitimacy details directly with the employer before investing time.";
      } else if (fitTier === "unknown") {
        recVerdict = "Add your CV for a personalized read"; recExplanation = "Legitimacy looks reasonable so far, but a fit assessment needs your CV.";
      } else if (legTier === "unknown") {
        recVerdict = "Add a sponsor register for a fuller picture"; recExplanation = "CV fit is assessed, but sponsorship legitimacy needs the UK register to have loaded.";
      } else {
        recVerdict = "Mixed signals — read the full posting carefully"; recExplanation = "Neither legitimacy nor fit stands out clearly either way — worth reading the full posting yourself before deciding.";
      }
      worthApplying = blended;
      if (atsWarningsOnly && worthApplying !== null) {
        worthApplying = Math.max(0, worthApplying - 10);
        recExplanation += " Also worth a look: some CV formatting details flagged under ATS readiness could still trip up automated screening.";
      }
    }

    return {
      legitimacy: { percent: legPercent, verdict: legVerdict, sponsor, pattern, descriptionQuality: descQ },
      ats,
      cvFit: cv,
      recommendation: { verdict: recVerdict, explanation: recExplanation, score: worthApplying },
      detectedCountry: detectCountry(job.location || "") || detectCountry(job.description || ""),
    };
  }

  // -----------------------------------------------------------------
  // UK sponsor register: fetch + cache. Mirrors sponsor_check.py's
  // fetch_uk_register() exactly, using chrome.storage.local as the cache
  // instead of a JSON file on disk, and the extension's own host
  // permissions (rather than `requests`) to reach GOV.UK cross-origin.
  // -----------------------------------------------------------------
  const UK_REGISTER_PAGE = "https://www.gov.uk/government/publications/register-of-licensed-sponsors-workers";
  const UK_REGISTER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const UK_REGISTER_CACHE_KEY = "ukSponsorRegisterCache";

  function parseCsvRegister(csvText) {
    const rows = parseCsv(csvText);
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const nameIdx = header.findIndex((h) => h.includes("organisation") || h.includes("organization") || h.includes("name"));
    const ratingIdx = header.findIndex((h) => h.includes("rating"));
    const routeIdx = header.findIndex((h) => h.includes("route"));
    const idx = nameIdx === -1 ? 0 : nameIdx;
    const entries = [];
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (row.length <= idx || !row[idx] || !row[idx].trim()) continue;
      let rating = "";
      if (ratingIdx !== -1 && row.length > ratingIdx) {
        const m = row[ratingIdx].match(/\b([AB])\b/i);
        rating = m ? m[1].toUpperCase() : "";
      }
      const route = (routeIdx !== -1 && row.length > routeIdx) ? row[routeIdx].trim() : "";
      entries.push({ name: row[idx].trim(), rating, route });
    }
    return entries;
  }

  // A small RFC4180-ish CSV parser -- quoted fields, doubled-quote escapes,
  // and commas inside quotes, which is what a real GOV.UK export contains
  // (organisation names routinely have commas in them, e.g. "Foo, Bar Ltd").
  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ",") {
        row.push(field); field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
      } else {
        field += c;
      }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
  }

  // The register itself is a ~10MB CSV (GOV.UK states "10.4 MB" for the
  // current file), which is right at -- and for the JSON encoding of every
  // entry as {name, rating, route}, likely over -- chrome.storage.local's
  // default 10MB quota. That default quota is what "Resource::kQuotaBytes
  // quota exceeded" is: the write silently failing every single time,
  // meaning the register never actually cached and every job posting
  // triggered a fresh 10MB refetch. Two independent fixes, not either/or:
  // `unlimitedStorage` in the manifest lifts the quota entirely, and
  // entries are cached as compact [name, rating, route] tuples rather than
  // {name, rating, route} objects, cutting the per-entry overhead of three
  // repeated JSON keys across ~85,000 rows. `entriesToObjects` below is the
  // only place that shape difference is allowed to matter -- everything
  // else in this file (and content.js, background.js) still sees the same
  // {name, rating, route} objects it always did.
  function entriesToTuples(entries) {
    return entries.map((e) => [e.name, e.rating || "", e.route || ""]);
  }
  function entriesToObjects(stored) {
    if (!Array.isArray(stored)) return [];
    return stored.map((e) => Array.isArray(e)
      ? { name: e[0], rating: e[1] || "", route: e[2] || "" }
      : e); // already {name,rating,route} -- an older cache, read as-is
  }

  async function fetchUkRegister(storage) {
    storage = storage || (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local);
    if (storage) {
      const cached = await storageGet(storage, UK_REGISTER_CACHE_KEY);
      if (cached && cached.fetchedAt && (Date.now() - cached.fetchedAt) < UK_REGISTER_MAX_AGE_MS) {
        return { country: "UK", entries: entriesToObjects(cached.entries), fetchedAt: cached.fetchedAt, stale: false };
      }
    }
    try {
      const page = await fetch(UK_REGISTER_PAGE, { credentials: "omit" });
      if (!page.ok) throw new Error(`GOV.UK page fetch failed: ${page.status}`);
      const pageText = await page.text();
      let csvUrl = null;
      let m = pageText.match(/https:\/\/assets\.publishing\.service\.gov\.uk\/[^"'\s]+\.csv/i);
      if (m) csvUrl = m[0];
      if (!csvUrl) {
        m = pageText.match(/href="([^"]+\.csv)"/i);
        csvUrl = m ? m[1] : null;
      }
      if (!csvUrl) throw new Error("couldn't find the CSV link on the GOV.UK page — layout may have changed");
      const csvResp = await fetch(csvUrl, { credentials: "omit" });
      if (!csvResp.ok) throw new Error(`CSV fetch failed: ${csvResp.status}`);
      const csvText = await csvResp.text();
      const entries = parseCsvRegister(csvText);
      const fetchedAt = Date.now();
      if (storage) {
        const saved = await storageSet(storage, UK_REGISTER_CACHE_KEY, { entries: entriesToTuples(entries), fetchedAt });
        if (!saved.ok) {
          // Couldn't cache it (quota, or storage unavailable) -- still hand
          // back what was just fetched so this run scores correctly, it
          // just means the next call refetches instead of reading a cache.
          console.warn("Sponsor Check: couldn't cache the UK sponsor register:", saved.error);
        }
      }
      return { country: "UK", entries, fetchedAt, stale: false };
    } catch (e) {
      if (storage) {
        const cached = await storageGet(storage, UK_REGISTER_CACHE_KEY);
        if (cached && cached.entries) {
          return { country: "UK", entries: entriesToObjects(cached.entries), fetchedAt: cached.fetchedAt, stale: true, error: String(e) };
        }
      }
      throw e;
    }
  }

  // Both wrappers explicitly read `chrome.runtime.lastError` inside the
  // callback -- not reading it (the previous version of this code) is
  // exactly what turns a failed write into an "Unchecked runtime.lastError"
  // console warning instead of something this code can react to.
  function storageGet(storage, key) {
    return new Promise((resolve) => {
      storage.get([key], (res) => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) { console.warn("Sponsor Check: storage.get failed:", err.message); resolve(undefined); return; }
        resolve(res ? res[key] : undefined);
      });
    });
  }
  function storageSet(storage, key, value) {
    return new Promise((resolve) => {
      storage.set({ [key]: value }, () => {
        const err = chrome.runtime && chrome.runtime.lastError;
        if (err) { resolve({ ok: false, error: err.message }); return; }
        resolve({ ok: true });
      });
    });
  }

  root.SponsorCheck = {
    detectCountry, extractSalary, sponsorability, postingPattern,
    descriptionQuality, atsReadiness, cvFit, evaluateJob,
    registeredCompany, parseCsvRegister, parseCsv, fetchUkRegister,
    UK_REGISTER_MAX_AGE_MS,
  };
})(typeof self !== "undefined" ? self : this);
