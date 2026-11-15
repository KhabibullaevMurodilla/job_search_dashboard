// "Response outlook": a transparent guide to how likely an application is to
// get a reply, built from what can actually be seen: how well the CV fits the
// posting, how legitimate and open to sponsorship the employer looks, whether a
// tailored letter exists, whether someone inside is helping, and how early the
// application went in. It is an index, not a probability. No tool can know an
// employer's pipeline, so every factor is shown with its reason and the one
// thing that would raise it, and the applicant's own history is shown beside
// it once there is enough of it to say anything. Pure logic.
(function (root) {
  "use strict";

  const DAY = 86400000;
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const round = (n) => Math.round(n);
  const words = (t) => (String(t || "").match(/\S+/g) || []).length;
  const STOP = new Set("with that this from your have will they their about into over such also more than been were what when which while within across able work working team teams role job position company must should would could include including required requirements skills experience years year good strong using use used knowledge understanding ability looking join help support provide ensure need needs well other these those our you are for and the".split(" "));

  function keywords(desc, n) {
    const count = {};
    for (const t of String(desc || "").toLowerCase().match(/[a-z][a-z0-9+#.\-]{3,}/g) || []) { if (STOP.has(t)) continue; count[t] = (count[t] || 0) + 1; }
    return Object.entries(count).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n || 12).map((x) => x[0]);
  }

  // How closely a letter is written for this posting, 0 to 100.
  function letterTailoring(letter, desc, company) {
    const l = String(letter || "").toLowerCase(); if (!l.trim()) return null;
    const kws = keywords(desc, 12);
    const hit = kws.filter((k) => l.includes(k)).length;
    const kwPart = kws.length ? (hit / kws.length) * 100 : 50;
    const c = String(company || "").toLowerCase().replace(/\b(ltd|limited|plc|llp|inc|llc|group|uk)\b/g, "").trim();
    const namePart = c && c.length > 2 ? (l.includes(c) ? 100 : 0) : 50;
    const w = words(letter), lenPart = w >= 180 && w <= 450 ? 100 : w >= 120 && w <= 550 ? 60 : 20;
    return { percent: round(kwPart * 0.5 + namePart * 0.3 + lenPart * 0.2), hit, of: kws.length, named: namePart === 100, words: w };
  }

  const BANDS = [
    { min: 70, id: "strong", label: "Strong" },
    { min: 50, id: "fair", label: "Fair" },
    { min: 30, id: "weak", label: "Weak" },
    { min: 0, id: "long", label: "Long shot" },
  ];
  const bandOf = (score) => BANDS.find((b) => score >= b.min);

  function finish(factors, caps, kind) {
    const used = factors.filter((f) => f.score !== null);
    const wsum = used.reduce((s, f) => s + f.weight, 0);
    if (used.length < 3 || wsum < 40) return { ok: false, factors, reason: "Not enough is known yet to judge this. Add the missing pieces below." };
    let score = round(used.reduce((s, f) => s + f.score * f.weight, 0) / wsum);
    const capNotes = [];
    for (const c of caps) if (c.when && score > c.max) { score = c.max; capNotes.push(c.note); }
    const b = bandOf(score);
    const byGap = used.filter((f) => f.score < 70 && f.action).sort((x, y) => (100 - y.score) * y.weight - (100 - x.score) * x.weight);
    return { ok: true, kind, score, band: b.id, bandLabel: b.label, factors, unknown: factors.filter((f) => f.score === null).map((f) => f.label), helps: byGap.slice(0, 3).map((f) => f.action), capNotes };
  }

  // ctx: { cvText, now }
  function scoreJob(app, ctx) {
    const c = ctx || {}, now = c.now === undefined ? Date.now() : c.now;
    const f = [];
    const fit = typeof app.fitPct === "number" ? app.fitPct : null;
    f.push({ key: "fit", label: "How well your CV fits the posting", weight: 30, score: fit, note: fit === null ? (c.cvText ? "Not scored yet." : "No CV saved.") : `CV fit ${fit}%.`, action: fit !== null && fit < 70 ? "Close the gap on the skills the posting asks for, or apply to roles that match your CV more closely." : "" });
    const emp = typeof app.sponsorPct === "number" ? app.sponsorPct : null;
    f.push({ key: "employer", label: "Employer legitimacy and sponsorship", weight: 15, score: emp, note: emp === null ? "Not checked." : `Employer check ${emp}%.`, action: emp !== null && emp < 60 ? "Check that this employer is genuine and holds a sponsor licence before spending time on it." : "" });
    const lt = letterTailoring(app.coverLetter, app.description, app.company);
    f.push({ key: "letter", label: "A cover letter written for this role", weight: 15, score: lt ? lt.percent : 0, note: lt ? `${lt.words} words, ${lt.named ? "names the company" : "does not name the company"}, uses ${lt.hit} of the posting's ${lt.of} key terms.` : "No letter drafted yet.", action: !lt ? "Draft a cover letter for this role." : lt.percent < 70 ? "Redraft the letter: name the company and use the posting's own key terms where they are true of you." : "" });
    f.push({ key: "referral", label: "Someone inside helping", weight: 15, score: app.referral ? 100 : 30, note: app.referral ? "You have a referral or a named contact." : "No referral or contact recorded.", action: app.referral ? "" : "Find one person at the company on LinkedIn, ask a short question about the team, and ask for a referral if it goes well." });
    let timing = null, tnote = "Posting date not known.";
    const posted = app.postedAt || app.posted_at ? Date.parse(app.postedAt || app.posted_at) : NaN;
    if (!isNaN(posted)) {
      const at = app.appliedAt ? Date.parse(app.appliedAt) : now, d = Math.max(0, Math.floor((at - posted) / DAY));
      timing = d <= 2 ? 100 : d <= 7 ? 80 : d <= 14 ? 55 : d <= 30 ? 30 : 15;
      tnote = `${app.appliedAt ? "Applied" : "Would apply"} ${d} day${d === 1 ? "" : "s"} after it was posted.`;
    }
    f.push({ key: "timing", label: "How early you applied", weight: 10, score: timing, note: tnote, action: timing !== null && timing < 70 && !app.appliedAt ? "Apply soon: early applications are read first." : "" });
    const caps = [
      { when: emp !== null && emp < 20, max: 35, note: "Capped: the employer check is very low." },
      { when: fit !== null && fit < 35, max: 45, note: "Capped: your CV is a weak match for what the posting asks." },
    ];
    return finish(f, caps, "job");
  }

  const REQUIRED = ["supervisor", "proposal", "statement", "cv", "transcripts", "certificates", "references", "english", "id", "form"];

  // ctx: { fitPct, researchDocs, now }
  function scorePhd(p, ctx) {
    const c = ctx || {}, now = c.now === undefined ? Date.now() : c.now, cl = p.checklist || {};
    const f = [];
    f.push({ key: "supervisor", label: "A supervisor knows you", weight: 25, score: cl.supervisor ? 100 : 20, note: cl.supervisor ? "You have contacted a possible supervisor." : "No supervisor contacted yet.", action: cl.supervisor ? "" : "Email the supervisor with a short, specific note about the theme before you apply." });
    const pw = words(p.proposalFull || p.tailoredProposal), ow = words(p.proposal);
    const ps = pw >= 600 ? 100 : pw >= 250 ? 70 : ow >= 250 ? 55 : ow > 0 ? 30 : 0;
    f.push({ key: "proposal", label: "A research proposal for this programme", weight: 20, score: ps, note: pw >= 250 ? `A written proposal of ${pw} words.` : ow > 0 ? `Only your own notes (${ow} words).` : "No proposal yet.", action: ps >= 70 ? "" : "Write a full proposal for this theme from the advert and your own research." });
    const sw = words(p.statement);
    f.push({ key: "statement", label: "A personal statement", weight: 15, score: sw >= 350 ? 100 : sw >= 150 ? 60 : 0, note: sw ? `${sw} words.` : "No statement yet.", action: sw >= 350 ? "" : "Write the personal statement." });
    const done = REQUIRED.filter((k) => cl[k]).length;
    f.push({ key: "complete", label: "Application complete", weight: 15, score: round((done / REQUIRED.length) * 100), note: `${done} of ${REQUIRED.length} required items ticked.`, action: done < REQUIRED.length ? "Finish the remaining items on the checklist." : "" });
    const rf = (p.referees || []).filter((x) => String(x || "").trim()).length;
    f.push({ key: "referees", label: "References arranged", weight: 10, score: cl.references ? 100 : rf >= 2 ? 70 : rf === 1 ? 40 : 10, note: cl.references ? "Two references arranged." : `${rf} referee${rf === 1 ? "" : "s"} named.`, action: cl.references ? "" : "Ask two referees now and give them the advert and your CV." });
    const fit = typeof c.fitPct === "number" ? c.fitPct : null;
    f.push({ key: "fit", label: "Your background against the advert", weight: 15, score: fit, note: fit === null ? "Needs an advert and your CV." : `Advert and CV overlap ${fit}%.`, action: fit !== null && fit < 70 ? "Show in the proposal and statement how your coursework and projects meet what the advert asks." : "" });
    const rd = c.researchDocs || 0;
    f.push({ key: "research", label: "Your own research on file", weight: 10, score: rd > 0 ? 100 : 30, note: rd > 0 ? `${rd} thesis or report digested.` : "No thesis or report added.", action: rd > 0 ? "" : "Add your thesis under My research so the proposal can build on real results." });
    if (p.deadline && !p.submittedAt && p.status !== "withdrawn") {
      const d = Math.ceil((Date.parse(p.deadline + "T00:00:00Z") - now) / DAY);
      f.push({ key: "time", label: "Time before the deadline", weight: 10, score: d < 0 ? 0 : d >= 21 ? 100 : d >= 14 ? 80 : d >= 7 ? 55 : d >= 3 ? 30 : 15, note: d < 0 ? "The deadline has passed." : `${d} day${d === 1 ? "" : "s"} left.`, action: d < 14 && d >= 0 ? "Time is short: finish the missing items in order of how much they weigh." : "" });
    }
    const caps = [{ when: !cl.supervisor && pw < 250 && sw < 150, max: 40, note: "Capped: no supervisor contact, proposal or statement yet." }];
    return finish(f, caps, "phd");
  }

  // The applicant's own record, to set beside the index.
  const HEARD = ["interview", "offer", "rejected"], POSITIVE = ["interview", "offer"];
  function history(apps, phds, now) {
    const t = now === undefined ? Date.now() : now, rows = [];
    for (const a of apps || []) if (a.appliedAt) rows.push({ at: Date.parse(a.appliedAt), status: a.status });
    for (const p of phds || []) if (p.submittedAt) rows.push({ at: Date.parse(p.submittedAt), status: p.status });
    const old = rows.filter((r) => (!isNaN(r.at) && t - r.at >= 21 * DAY) || HEARD.indexOf(r.status) >= 0);
    const heard = old.filter((r) => HEARD.indexOf(r.status) >= 0).length, pos = old.filter((r) => POSITIVE.indexOf(r.status) >= 0).length;
    const n = old.length;
    return { n, heard, positive: pos, enough: n >= 8, replyRate: n ? round((heard / n) * 100) : null, positiveRate: n ? round((pos / n) * 100) : null };
  }

  const api = { BANDS, bandOf, keywords, letterTailoring, scoreJob, scorePhd, history };
  root.Outlook = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
