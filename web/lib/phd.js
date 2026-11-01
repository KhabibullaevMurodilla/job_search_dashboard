/*
 * PhD applications: one record per programme you are applying to, with a
 * checklist of what has to be ready, a deadline, a tailored research
 * proposal, and the supervisor email.
 *
 * Pure logic only (no DOM, no storage), tested in Node. app.js stores the
 * records in this browser and draws them.
 *
 * Dates are compared as calendar days in UTC, so "3 days left" does not
 * change depending on what time of day you look.
 */
(function (root) {
  "use strict";

  const STATUSES = ["researching", "contacting", "drafting", "ready", "submitted",
    "interview", "offer", "rejected", "withdrawn"];
  // Reached once you have actually sent it in.
  const SUBMITTED_ONWARD = ["submitted", "interview", "offer", "rejected"];
  // Nothing left to prepare, so no deadline warning.
  const CLOSED = SUBMITTED_ONWARD.concat(["withdrawn"]);
  const FUNDING = ["unknown", "funded studentship", "partly funded", "self-funded"];

  const CHECKLIST = [
    { key: "supervisor", label: "Contacted a possible supervisor" },
    { key: "proposal", label: "Research proposal written for this programme" },
    { key: "statement", label: "Personal statement" },
    { key: "cv", label: "CV (academic version)" },
    { key: "transcripts", label: "Transcripts" },
    { key: "certificates", label: "Degree certificates" },
    { key: "references", label: "Two references arranged" },
    { key: "english", label: "English-language evidence, if asked for" },
    { key: "id", label: "Passport or ID copy" },
    { key: "funding", label: "Fees and funding position checked" },
    { key: "form", label: "Online application form completed" },
  ];

  const DAY_MS = 86400000;

  function iso(now) { return new Date(now === undefined ? Date.now() : now).toISOString(); }
  function makeId(now) {
    return "p" + (now === undefined ? Date.now() : now).toString(36) + Math.floor(Math.random() * 1e6).toString(36);
  }
  function validDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || "") && !isNaN(Date.parse(s + "T00:00:00Z")); }

  function newPhd(fields, now) {
    const f = fields || {};
    const t = iso(now);
    const checklist = {};
    for (const c of CHECKLIST) checklist[c.key] = false;
    return {
      id: makeId(now),
      university: (f.university || "").trim() || "Unknown university",
      programme: (f.programme || "").trim() || "PhD programme",
      theme: (f.theme || "").trim(),
      supervisor: (f.supervisor || "").trim(),
      supervisorEmail: (f.supervisorEmail || "").trim(),
      funding: FUNDING.indexOf(f.funding) >= 0 ? f.funding : "unknown",
      deadline: validDate(f.deadline) ? f.deadline : "",
      url: (f.url || "").trim(),
      status: "researching",
      checklist,
      proposal: f.proposal || "",
      proposalReview: "",
      supervisorDraft: "",
      advert: f.advert || "",
      requirements: Array.isArray(f.requirements) ? f.requirements.filter((x) => typeof x === "string").slice(0, 20) : [],
      statement: "",
      tailoredProposal: "",
      referees: ["", ""],
      notes: "",
      docs: [],
      createdAt: t,
      updatedAt: t,
      submittedAt: null,
    };
  }

  function setStatus(p, status, now) {
    if (STATUSES.indexOf(status) < 0) throw new Error("unknown status: " + status);
    p.status = status;
    p.updatedAt = iso(now);
    if (SUBMITTED_ONWARD.indexOf(status) >= 0) { if (!p.submittedAt) p.submittedAt = iso(now); }
    else p.submittedAt = null;
    return p;
  }

  function setCheck(p, key, done, now) {
    if (!CHECKLIST.some((c) => c.key === key)) throw new Error("unknown checklist item: " + key);
    p.checklist[key] = !!done;
    p.updatedAt = iso(now);
    return p;
  }

  function addDoc(p, doc, now) {
    const d = { id: makeId(now), name: (doc.name || "document").trim(), kind: doc.kind || "other",
      text: doc.text || "", addedAt: iso(now) };
    p.docs.push(d);
    p.updatedAt = d.addedAt;
    return d;
  }

  // How ready the application is: ticked items out of all items.
  function readiness(p) {
    const missing = CHECKLIST.filter((c) => !p.checklist[c.key]).map((c) => c.label);
    const done = CHECKLIST.length - missing.length;
    return { done, total: CHECKLIST.length, pct: Math.round(100 * done / CHECKLIST.length), missing };
  }

  // Days from today to the deadline (negative when it has passed), or null.
  function daysLeft(p, now) {
    if (!p.deadline) return null;
    const today = Math.floor((now === undefined ? Date.now() : now) / DAY_MS);
    return Math.floor(Date.parse(p.deadline + "T00:00:00Z") / DAY_MS) - today;
  }

  // level: none | closed | overdue | soon (<= 7 days) | near (<= 21) | ok
  function deadlineInfo(p, now) {
    if (CLOSED.indexOf(p.status) >= 0) return { level: "closed", days: daysLeft(p, now), label: p.deadline ? "deadline " + p.deadline : "" };
    const d = daysLeft(p, now);
    if (d === null) return { level: "none", days: null, label: "no deadline set" };
    if (d < 0) return { level: "overdue", days: d, label: `deadline passed ${-d} day${d === -1 ? "" : "s"} ago` };
    if (d === 0) return { level: "soon", days: 0, label: "deadline today" };
    const label = `${d} day${d === 1 ? "" : "s"} left`;
    return { level: d <= 7 ? "soon" : d <= 21 ? "near" : "ok", days: d, label };
  }

  function stats(list, now) {
    const items = list || [];
    const byStatus = {};
    for (const s of STATUSES) byStatus[s] = 0;
    for (const p of items) if (byStatus[p.status] !== undefined) byStatus[p.status]++;
    const open = items.filter((p) => CLOSED.indexOf(p.status) < 0);
    const upcoming = open.filter((p) => p.deadline)
      .map((p) => ({ id: p.id, university: p.university, programme: p.programme, deadline: p.deadline, days: daysLeft(p, now), pct: readiness(p).pct }))
      .sort((a, b) => a.days - b.days || a.university.localeCompare(b.university));
    const submitted = items.filter((p) => p.submittedAt);
    const answered = items.filter((p) => ["interview", "offer", "rejected"].indexOf(p.status) >= 0);
    return {
      total: items.length,
      byStatus,
      open: open.length,
      submitted: submitted.length,
      answered: answered.length,
      overdue: upcoming.filter((u) => u.days < 0).length,
      upcoming,
      avgReadiness: open.length ? Math.round(open.reduce((s, p) => s + readiness(p).pct, 0) / open.length) : null,
      withProposal: items.filter((p) => (p.proposal || "").trim()).length,
    };
  }

  // ---- prompts. Both are told not to invent anything about the person.
  const NO_INVENT = "Use only what the CV says. Do not invent publications, grades, projects, "
    + "skills or meetings. If the CV does not support a claim, leave the claim out.";

  function buildSupervisorEmailPrompt(p, cvText) {
    return [
      "Write a short first email from a prospective PhD applicant to a possible supervisor.",
      "",
      `University: ${p.university}`,
      `Programme: ${p.programme}`,
      p.theme ? `Research theme: ${p.theme}` : "",
      p.supervisor ? `Supervisor: ${p.supervisor}` : "Supervisor: (name not known; address it to the supervisor generally)",
      "",
      "Rules:",
      "- 130 to 190 words, plain text, no markdown, no bullet points.",
      "- First line is 'Subject: ...' then a blank line, then the email.",
      "- Say who the applicant is in one sentence, why this theme and group in two, and what they bring in two.",
      "- Ask for a short call or any advice on applying. Mention the research proposal is attached.",
      "- Plain, specific, polite. No flattery, no 'I am passionate', no placeholders in square brackets.",
      "- " + NO_INVENT,
      "",
      "APPLICANT CV:",
      cvText,
      p.proposal ? "\nDRAFT RESEARCH PROPOSAL (for context only, do not paste it):\n" + p.proposal.slice(0, 4000) : "",
    ].filter((x) => x !== "").join("\n");
  }

  function buildProposalReviewPrompt(p, cvText) {
    return [
      "You are reviewing a PhD research proposal against the programme it is being sent to. Be a candid, specific reader, not an encourager.",
      "",
      `University: ${p.university}`,
      `Programme: ${p.programme}`,
      p.theme ? `Research theme advertised: ${p.theme}` : "Research theme: not given",
      p.supervisor ? `Supervisor: ${p.supervisor}` : "",
      "",
      "Reply in plain text with exactly these sections:",
      "FIT: two or three sentences on how well the proposal matches the theme above, and the single biggest mismatch.",
      "STRONG: up to three things the proposal does well, each quoting a few words from it.",
      "GAPS: up to five things a selector would ask that the proposal does not answer (research question, method, data, novelty, feasibility, timeline).",
      "EDITS: up to five concrete edits, each saying which part to change and what to put there. Do not rewrite the whole proposal.",
      "- " + NO_INVENT,
      "",
      "RESEARCH PROPOSAL:",
      p.proposal,
      cvText ? "\nAPPLICANT CV (to check the proposal is credible for this person):\n" + cvText : "",
    ].filter((x) => x !== "").join("\n");
  }

  function qualityCheckEmail(text, p) {
    const problems = [];
    const t = (text || "").trim();
    const body = t.replace(/^subject:[^\n]*\n+/i, "");
    const words = body.split(/\s+/).filter(Boolean).length;
    if (!/^subject:/i.test(t)) problems.push("It has no Subject line.");
    if (words < 80) problems.push(`It is only ${words} words, which is too thin to be a real introduction.`);
    if (words > 260) problems.push(`It is ${words} words, too long for a first email.`);
    if (/\[[^\]]+\]/.test(t)) problems.push("It still contains a [placeholder] to fill in.");
    if (p.supervisor) {
      const last = p.supervisor.replace(/^(prof(essor)?\.?|dr\.?)\s+/i, "").trim().split(/\s+/).pop().toLowerCase();
      if (last && t.toLowerCase().indexOf(last) < 0) problems.push(`It never uses the supervisor's name (${p.supervisor}).`);
    }
    return { ok: problems.length === 0, problems, words };
  }


  // ---------------------------------------------------------------- advert
  // Plain rules, no AI: does the advert say the things you need in order to
  // apply? A missing item is a question to ask, not a verdict.
  const ADVERT_CHECKS = [
    { key: "deadline", label: "A closing date", re: /(deadline|closing date|apply by|applications? (close|must be received)|closes? (on|at))/i },
    { key: "funding", label: "Funding or a stipend", re: /(stipend|studentship|scholarship|bursary|fully[- ]funded|funded (by|position|phd)|funding (is|available)|tuition fees? (are|will be) (paid|covered|waived))/i },
    { key: "supervisor", label: "A named supervisor or contact", re: /(supervis|principal investigator|enquiries to|informal (enquir|contact)|contact:)/i },
    { key: "entry", label: "Entry requirements", re: /(2:1|first[- ]class|upper second|master'?s|msc\b|bachelor|degree in|honours)/i },
    { key: "how", label: "How to apply", re: /(how to apply|apply (online|via|through|at)|application (form|portal|process)|send (your|a) (cv|application))/i },
  ];

  function advertChecks(text) {
    const t = text || "";
    const items = ADVERT_CHECKS.map((c) => ({ key: c.key, label: c.label, found: c.re.test(t) }));
    const warnings = [];
    if (!items.find((i) => i.key === "deadline").found) warnings.push("No closing date found. Check the programme page before you plan around it.");
    if (!items.find((i) => i.key === "funding").found) {
      warnings.push(/\bfees?\b/i.test(t)
        ? "It talks about fees but names no stipend or scholarship, so it may be self-funded only."
        : "No funding is mentioned. Ask whether there is a stipend or whether you pay the fees.");
    }
    if (!items.find((i) => i.key === "supervisor").found) warnings.push("No supervisor or contact named. Find who leads the project before you write to anyone.");
    return { items, warnings, words: t.split(/\s+/).filter(Boolean).length };
  }

  function buildAdvertExtractPrompt(text) {
    return [
      "Read this PhD advert and return ONLY a JSON object, no commentary and no code fence, with exactly these keys:",
      '{"university": string, "programme": string, "theme": string, "supervisor": string, "funding": "funded studentship" | "partly funded" | "self-funded" | "unknown", "deadline": "YYYY-MM-DD" or "", "requirements": [string]}',
      "",
      "Rules:",
      "- Use only what the advert says. If something is not stated, use \"\" (or \"unknown\" for funding, [] for requirements). Never guess.",
      "- programme is the degree and subject, for example \"PhD Computer Science\". theme is the project or research topic in under 15 words.",
      "- requirements: the entry requirements and documents the advert asks for, one short item each, at most 10.",
      "- deadline: only if a full date is given. Convert it to YYYY-MM-DD.",
      "",
      "ADVERT:",
      text,
    ].join("\n");
  }

  // Gemini's reply -> a clean object, or throws with a plain reason.
  function parseAdvertExtract(text) {
    let t = String(text || "").trim().replace(/^```[a-z]*\s*/i, "").replace(/```\s*$/, "").trim();
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) throw new Error("Gemini did not return the advert details in a form I can read. Try again, or fill the fields in by hand.");
    let o;
    try { o = JSON.parse(t.slice(a, b + 1)); }
    catch (e) { throw new Error("Gemini did not return the advert details in a form I can read. Try again, or fill the fields in by hand."); }
    const str = (v) => (typeof v === "string" ? v.trim() : "");
    const f = str(o.funding).toLowerCase();
    return {
      university: str(o.university), programme: str(o.programme), theme: str(o.theme), supervisor: str(o.supervisor),
      funding: FUNDING.indexOf(f) >= 0 ? f : /studentship|stipend|fully/.test(f) ? "funded studentship" : /part/.test(f) ? "partly funded" : /self/.test(f) ? "self-funded" : "unknown",
      deadline: validDate(str(o.deadline)) ? str(o.deadline) : "",
      requirements: Array.isArray(o.requirements) ? o.requirements.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()).slice(0, 10) : [],
    };
  }

  // ------------------------------------------------------------------ plan
  // Working back from the deadline. Done follows the checklist, so ticking
  // an item crosses it off here too.
  const PLAN = [
    { key: "supervisor", label: "Write to the supervisor", before: 35 },
    { key: "references", label: "Ask your two referees", before: 28 },
    { key: "proposal", label: "Tailor the research proposal", before: 21 },
    { key: "statement", label: "Draft the personal statement", before: 14 },
    { key: "transcripts", label: "Gather transcripts, certificates and ID", before: 14 },
    { key: "funding", label: "Check fees and funding", before: 10 },
    { key: "form", label: "Fill in the application form", before: 5 },
    { key: null, label: "Final read-through, then submit", before: 2 },
  ];

  function plan(p, now) {
    if (!p.deadline) return null;
    const today = Math.floor((now === undefined ? Date.now() : now) / DAY_MS);
    const dl = Math.floor(Date.parse(p.deadline + "T00:00:00Z") / DAY_MS);
    return PLAN.map((m) => {
      const day = dl - m.before;
      return {
        key: m.key, label: m.label,
        date: new Date(day * DAY_MS).toISOString().slice(0, 10),
        done: m.key ? !!p.checklist[m.key] : p.status === "submitted",
        late: day < today && !(m.key ? p.checklist[m.key] : false),
        // The deadline has passed or is too close for this step's usual lead time.
        daysFromToday: day - today,
      };
    });
  }

  // --------------------------------------------------------- drafting prompts
  function signoff(name) {
    return name ? `Sign off with the name "${name}".` : "End after the closing phrase with no name line (the sender will add it).";
  }

  function buildStatementPrompt(p, cvText, name) {
    return [
      "Write a personal statement for a PhD application, in the first person, for the applicant described by the CV below.",
      "",
      `University: ${p.university}`,
      `Programme: ${p.programme}`,
      p.theme ? `Research theme: ${p.theme}` : "",
      p.supervisor ? `Supervisor: ${p.supervisor}` : "",
      (p.requirements || []).length ? "What the advert asks for:\n- " + p.requirements.join("\n- ") : "",
      "",
      "Rules:",
      "- 450 to 700 words, plain text, four to six paragraphs, no headings, no bullet points.",
      "- Cover, in this order: what draws the applicant to this research area; the background that prepares them (from the CV, with specifics); the research they want to do here, grounded in the theme and the proposal if one is given; why this university and group; what they will contribute and what they hope to do next.",
      "- Write it in the applicant's own words, not as a rephrasing of the CV. Do not copy phrases of six or more words from the CV.",
      "- Plain, specific and honest. No flattery, no 'I am passionate', no clichés about curiosity since childhood, no placeholders in square brackets.",
      "- " + NO_INVENT,
      "- " + signoff(name),
      "",
      "APPLICANT CV:",
      cvText,
      p.proposal ? "\nTHE APPLICANT'S RESEARCH PROPOSAL (use its ideas, do not paste it):\n" + p.proposal.slice(0, 5000) : "",
      p.advert ? "\nTHE ADVERT:\n" + p.advert.slice(0, 5000) : "",
    ].filter((x) => x !== "").join("\n");
  }

  function buildTailorProposalPrompt(p, cvText) {
    return [
      "Adapt the applicant's research proposal so it is aimed at the programme below. This is an edit of THEIR proposal, not a new one.",
      "",
      `University: ${p.university}`,
      `Programme: ${p.programme}`,
      p.theme ? `Research theme: ${p.theme}` : "",
      p.supervisor ? `Supervisor: ${p.supervisor}` : "",
      (p.requirements || []).length ? "What the advert asks for:\n- " + p.requirements.join("\n- ") : "",
      "",
      "Rules:",
      "- Keep the applicant's research question, method and ideas. Change the framing, the title, the opening and the way the aims connect to this programme's theme.",
      "- Keep their section structure. Do not add new experiments, datasets, results, citations or claims that are not in the proposal or the CV.",
      "- If the proposal does not fit this theme, keep it honest: say in the first line, as 'NOTE: ...', what does not fit. Do not bend it into something it is not.",
      "- Plain text only, same length as the original within about 15 percent.",
      "- " + NO_INVENT,
      "",
      "ORIGINAL PROPOSAL:",
      p.proposal,
      "\nAPPLICANT CV:",
      cvText,
      p.advert ? "\nTHE ADVERT:\n" + p.advert.slice(0, 5000) : "",
    ].filter((x) => x !== "").join("\n");
  }

  function qualityCheckStatement(text, cvText, shared) {
    const problems = [];
    const t = (text || "").trim();
    const words = t.split(/\s+/).filter(Boolean).length;
    if (words < 350) problems.push(`It is only ${words} words, which is short for a PhD statement.`);
    if (words > 900) problems.push(`It is ${words} words, longer than most programmes allow.`);
    if (/\[[^\]]+\]/.test(t)) problems.push("It still contains a [placeholder] to fill in.");
    const phrase = shared ? shared(t, cvText || "", 6) : null;
    if (phrase) problems.push(`It repeats a phrase from your CV word for word ("${phrase}").`);
    if (/\bpassionate\b/i.test(t)) problems.push('It uses the word "passionate", which selectors read as filler.');
    return { ok: problems.length === 0, problems, words };
  }

  // Not AI: the same request every time, with the details filled in.
  function refereeRequest(p, refereeName, myName) {
    const who = (refereeName || "").trim();
    const hello = who ? `Dear ${who},` : "Dear Professor,";
    const what = `${p.programme} at ${p.university}`;
    const dl = p.deadline ? `The closing date is ${p.deadline}, so the reference would need to be in by about ${new Date(Date.parse(p.deadline + "T00:00:00Z") - 5 * DAY_MS).toISOString().slice(0, 10)}.` : "I will confirm the closing date as soon as I have it.";
    return [
      `Subject: Reference request: ${p.programme}, ${p.university}`,
      "",
      hello,
      "",
      `I hope you are well. I am applying for ${what}${p.theme ? `, working on ${p.theme}` : ""}, and I would be grateful if you would be willing to act as one of my referees.`,
      "",
      `${dl} I can send you my CV, my research proposal and a draft of my personal statement, so you can see what I am applying for. The university will usually email you a link, or ask for a signed letter on headed paper.`,
      "",
      "If you are not able to, I completely understand, and a quick reply would help me find someone else in time.",
      "",
      "Thank you for considering it.",
      "",
      "Best wishes,",
      myName || "",
    ].join("\n").replace(/\n+$/, "") + "\n";
  }


  // ------------------------------------------------------------- CV match
  // Word overlap, shown openly: which of the advert's main terms your CV
  // mentions and which it does not. It is not a judgement of your chances,
  // and a term can be missing from the CV only because you word it differently.
  const STOP = new Set(("the and for with that this from will have been are was were you your our their they them its into over under about "
    + "than then also such more most other some any all can may must should would could able each both between within across through during "
    + "including include includes included required requires require requirement requirements applicants applicant applications application apply "
    + "candidate candidates please university school department faculty phd doctoral doctorate studentship project position opportunity "
    + "research researcher programme program degree masters master bachelor honours award annual fees fee tuition stipend funded funding "
    + "deadline closing date contact information further details how who what when where which while after before work working experience "
    + "january february march april may june july august september october november december online portal supervisor supervisors hold fully email enquiries informal "
    + "skills skill knowledge strong good excellent ability years year new part full time based well join team group").split(/\s+/));

  function terms(text) {
    return (String(text || "").toLowerCase().match(/[a-z][a-z0-9+#.\-]{2,}/g) || [])
      .map((w) => w.replace(/[.\-]+$/, ""))
      .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d/.test(w));
  }
  const stem = (w) => {
    if (w.length <= 4) return w;
    if (w.endsWith("ing")) return w.slice(0, -3);
    if (w.endsWith("ies")) return w.slice(0, -3) + "y";
    return w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w;
  };

  function cvTermMatch(advert, cvText, limit) {
    const max = limit || 20;
    const count = new Map();
    for (const w of terms(advert)) { const k = stem(w); count.set(k, (count.get(k) || 0) + 1); }
    const top = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0])).slice(0, max).map((e) => e[0]);
    if (top.length < 5) return { percent: null, matched: [], missing: [], total: top.length };
    const cv = new Set(terms(cvText).map(stem));
    const matched = top.filter((t) => cv.has(t)), missing = top.filter((t) => !cv.has(t));
    return { percent: Math.round(100 * matched.length / top.length), matched, missing, total: top.length };
  }

  function slug(s) {
    const out = String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
    return out || "untitled";
  }

  // Folder layout for the zip / folder save. Everything is under phd/ so it
  // never mixes with the job-application folders:
  //   phd/<university>/<programme>-<yyyy-mm-dd>/{overview.md, proposal.md,
  //     proposal-review.md, supervisor-email.md, notes.md, details.json,
  //     documents/<name>}
  function folderPlan(p, now) {
    const day = (p.createdAt || "").slice(0, 10) || "undated";
    const dir = "phd/" + slug(p.university) + "/" + slug(p.programme) + "-" + day;
    const r = readiness(p);
    const dl = deadlineInfo(p, now);
    const lines = [
      `# ${p.programme}`, "", p.university,
      p.theme ? `\nTheme: ${p.theme}` : "",
      p.supervisor ? `Supervisor: ${p.supervisor}${p.supervisorEmail ? " <" + p.supervisorEmail + ">" : ""}` : "",
      `Funding: ${p.funding}`,
      `Status: ${p.status}`,
      p.deadline ? `Deadline: ${p.deadline} (${dl.label})` : "Deadline: not set",
      p.url ? `Link: ${p.url}` : "",
      "", `## Checklist (${r.done} of ${r.total})`, "",
    ].filter((x, i, a) => !(x === "" && a[i - 1] === ""));
    for (const c of CHECKLIST) lines.push(`- [${p.checklist[c.key] ? "x" : " "}] ${c.label}`);
    const files = [{ path: dir + "/overview.md", content: lines.join("\n") + "\n" }];
    if (p.advert) files.push({ path: dir + "/advert.md", content: p.advert + "\n" });
    if ((p.proposal || "").trim()) files.push({ path: dir + "/proposal.md", content: p.proposal + "\n" });
    if (p.tailoredProposal) files.push({ path: dir + "/proposal-tailored.md", content: p.tailoredProposal + "\n" });
    if (p.statement) files.push({ path: dir + "/personal-statement.md", content: p.statement + "\n" });
    const pl = plan(p, now);
    if (pl) files.push({ path: dir + "/plan.md", content: "# Plan, counting back from " + p.deadline + "\n\n" + pl.map((m) => `- [${m.done ? "x" : " "}] ${m.date}  ${m.label}`).join("\n") + "\n" });
    const refs = (p.referees || []).filter((r) => (r || "").trim());
    if (refs.length) files.push({ path: dir + "/referee-requests.md", content: refs.map((r) => refereeRequest(p, r, "")).join("\n---\n\n") });
    if (p.proposalReview) files.push({ path: dir + "/proposal-review.md", content: p.proposalReview + "\n" });
    if (p.supervisorDraft) files.push({ path: dir + "/supervisor-email.md", content: p.supervisorDraft + "\n" });
    if (p.notes) files.push({ path: dir + "/notes.md", content: p.notes + "\n" });
    const seen = {};
    for (const d of p.docs || []) {
      let base = slug(d.name.replace(/\.[^.]+$/, ""));
      if (seen[base]) base += "-" + (++seen[base]); else seen[base] = 1;
      files.push({ path: dir + "/documents/" + base + ".md", content: d.text + "\n" });
    }
    files.push({ path: dir + "/details.json", content: JSON.stringify({
      university: p.university, programme: p.programme, theme: p.theme, supervisor: p.supervisor,
      funding: p.funding, deadline: p.deadline, url: p.url, status: p.status,
      createdAt: p.createdAt, submittedAt: p.submittedAt, checklist: p.checklist,
    }, null, 2) + "\n" });
    return { dir, files };
  }

  function exportJson(list, now) {
    return JSON.stringify({ app: "job-radar-phd", version: 1, exportedAt: iso(now), phd: list }, null, 2);
  }

  function parseImport(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("That file is not valid JSON."); }
    if (!data || data.app !== "job-radar-phd" || !Array.isArray(data.phd)) {
      throw new Error("That file is not a PhD applications export from this dashboard.");
    }
    return data.phd.filter((p) => p && p.id && p.university && STATUSES.indexOf(p.status) >= 0)
      .map((p) => {
        // Defaults first, so an export made before a checklist item existed
        // still loads with that item present and unticked.
        const checklist = newPhd({}, 0).checklist;
        Object.assign(checklist, p.checklist || {});
        return Object.assign(newPhd({}, 0), p, { checklist, docs: Array.isArray(p.docs) ? p.docs : [] });
      });
  }

  // Records read back from browser storage: fill anything missing (a record
  // saved by an older version, or edited by hand) so the screen never breaks
  // on a missing field, and drop anything that is not a usable record.
  function normalizeAll(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((p) => p && typeof p === "object" && p.id && STATUSES.indexOf(p.status) >= 0)
      .map((p) => {
        const checklist = newPhd({}, 0).checklist;
        Object.assign(checklist, p.checklist && typeof p.checklist === "object" ? p.checklist : {});
        const out = Object.assign(newPhd({}, 0), p, { checklist, docs: Array.isArray(p.docs) ? p.docs : [] });
        if (!out.createdAt) out.createdAt = new Date().toISOString();
        if (!validDate(out.deadline)) out.deadline = "";
        if (!Array.isArray(out.referees)) out.referees = ["", ""];
        return out;
      });
  }

  function mergeImport(list, incoming) {
    let added = 0, updated = 0;
    for (const inc of incoming) {
      const i = list.findIndex((p) => p.id === inc.id);
      if (i < 0) { list.push(inc); added++; }
      else if ((inc.updatedAt || "") > (list[i].updatedAt || "")) { list[i] = inc; updated++; }
    }
    return { added, updated };
  }

  root.Phd = {
    STATUSES, FUNDING, CHECKLIST, newPhd, setStatus, setCheck, addDoc, readiness, daysLeft,
    deadlineInfo, stats, ADVERT_CHECKS, advertChecks, buildAdvertExtractPrompt, parseAdvertExtract, plan, cvTermMatch,
    buildStatementPrompt, buildTailorProposalPrompt, qualityCheckStatement, refereeRequest, buildSupervisorEmailPrompt, buildProposalReviewPrompt, qualityCheckEmail,
    slug, folderPlan, exportJson, parseImport, mergeImport, normalizeAll,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = { Phd: root.Phd };
})(typeof self !== "undefined" ? self : this);
