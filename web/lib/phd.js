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
    if ((p.proposal || "").trim()) files.push({ path: dir + "/proposal.md", content: p.proposal + "\n" });
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
    deadlineInfo, stats, buildSupervisorEmailPrompt, buildProposalReviewPrompt, qualityCheckEmail,
    slug, folderPlan, exportJson, parseImport, mergeImport, normalizeAll,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = { Phd: root.Phd };
})(typeof self !== "undefined" ? self : this);
