/*
 * The "applications" library: every role you save, score, draft a letter
 * for, apply to, or paste in by hand, kept together in this browser.
 *
 * Pure logic only (no DOM, no storage), so it is tested in Node. app.js
 * owns saving it to localStorage and drawing it.
 *
 * "Submitted" means appliedAt is set, not that status is "applied": an
 * application that later moves to interview, offer or rejected is still one
 * you submitted, and counting only status === "applied" would make every
 * success disappear from the submitted total.
 */
(function (root) {
  "use strict";

  const STATUSES = ["saved", "applied", "interview", "offer", "rejected", "withdrawn"];
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  function iso(now) { return new Date(now === undefined ? Date.now() : now).toISOString(); }

  function makeId(now, rand) {
    const r = rand === undefined ? Math.random() : rand;
    return "a" + (now === undefined ? Date.now() : now).toString(36)
      + Math.floor(r * 1e6).toString(36);
  }

  function pct(n) { return typeof n === "number" && isFinite(n) ? Math.round(n) : null; }

  // fields: title, company, location, url, description, uid?, source?,
  // sponsorPct?, fitPct?, verdict?
  function newApplication(fields, now) {
    const f = fields || {};
    const t = iso(now);
    return {
      id: makeId(now),
      uid: f.uid || null,
      source: f.source === "pasted" ? "pasted" : "scan",
      title: (f.title || "").trim() || "Untitled role",
      company: (f.company || "").trim() || "Unknown company",
      location: (f.location || "").trim(),
      url: (f.url || "").trim(),
      description: f.description || "",
      status: "saved",
      createdAt: t,
      updatedAt: t,
      appliedAt: null,
      sponsorPct: pct(f.sponsorPct),
      fitPct: pct(f.fitPct),
      verdict: f.verdict || "",
      coverLetter: "",
      notes: "",
      docs: [],
    };
  }

  function findByUid(list, uid) {
    return uid ? (list || []).find((a) => a.uid === uid) || null : null;
  }

  // Return the record for this role, making one if there is none yet. Never
  // two records for one scanned role: a letter drafted twice, or a role
  // marked applied after a letter was drafted, must land on the same row.
  function ensureForRole(list, role, scores, now) {
    let rec = findByUid(list, role.uid);
    if (rec) return rec;
    rec = newApplication({
      uid: role.uid, source: "scan", title: role.title, company: role.company,
      location: role.location, url: role.url, description: role.description,
      sponsorPct: scores && scores.sponsorPct, fitPct: scores && scores.fitPct,
      verdict: scores && scores.verdict,
    }, now);
    list.push(rec);
    return rec;
  }

  function setStatus(app, status, now) {
    if (STATUSES.indexOf(status) < 0) throw new Error("unknown status: " + status);
    app.status = status;
    app.updatedAt = iso(now);
    // The first time it reaches a submitted state. Moving applied -> interview
    // keeps the original date; moving back to "saved" clears it.
    if (status === "saved") app.appliedAt = null;
    else if (!app.appliedAt && status !== "withdrawn") app.appliedAt = iso(now);
    return app;
  }

  function addDoc(app, doc, now) {
    const d = {
      id: makeId(now),
      name: (doc.name || "document").trim(),
      kind: doc.kind || "other",   // cv | cover_letter | other
      text: doc.text || "",
      addedAt: iso(now),
    };
    app.docs.push(d);
    app.updatedAt = d.addedAt;
    return d;
  }

  function mean(xs) {
    const v = xs.filter((x) => typeof x === "number");
    return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
  }

  function weekStart(ms) {
    // Monday 00:00 UTC of the week containing ms.
    const d = new Date(ms);
    const day = (d.getUTCDay() + 6) % 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
  }

  function stats(list, now) {
    const apps = list || [];
    const byStatus = {};
    for (const s of STATUSES) byStatus[s] = 0;
    for (const a of apps) if (byStatus[a.status] !== undefined) byStatus[a.status]++;

    const submitted = apps.filter((a) => a.appliedAt);
    const interviewed = apps.filter((a) => a.status === "interview" || a.status === "offer");
    const heardBack = apps.filter((a) => ["interview", "offer", "rejected"].indexOf(a.status) >= 0);

    // Eight weekly buckets ending with the current week, oldest first.
    const thisWeek = weekStart(now === undefined ? Date.now() : now);
    const weekly = [];
    for (let i = 7; i >= 0; i--) {
      const start = thisWeek - i * WEEK_MS;
      weekly.push({ weekStart: new Date(start).toISOString().slice(0, 10), saved: 0, applied: 0 });
    }
    const idx = (iso) => {
      const w = weekStart(Date.parse(iso));
      const i = Math.round((w - (thisWeek - 7 * WEEK_MS)) / WEEK_MS);
      return i >= 0 && i < 8 ? i : -1;
    };
    for (const a of apps) {
      const c = idx(a.createdAt); if (c >= 0) weekly[c].saved++;
      if (a.appliedAt) { const p = idx(a.appliedAt); if (p >= 0) weekly[p].applied++; }
    }

    const companies = {};
    for (const a of apps) companies[a.company] = (companies[a.company] || 0) + 1;
    const topCompanies = Object.keys(companies)
      .map((name) => ({ name, count: companies[name] }))
      .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
      .slice(0, 5);

    // Does a better CV fit go with getting an interview? Reported with the
    // sample sizes beside it, because with a few applications it means little.
    const fitOf = (xs) => mean(xs.map((a) => a.fitPct));
    const notInterviewed = submitted.filter((a) => interviewed.indexOf(a) < 0);

    return {
      total: apps.length,
      byStatus,
      submitted: submitted.length,
      interviewRate: submitted.length ? Math.round(100 * interviewed.length / submitted.length) : null,
      responseRate: submitted.length ? Math.round(100 * heardBack.length / submitted.length) : null,
      avgSponsor: mean(apps.map((a) => a.sponsorPct)),
      avgFit: mean(apps.map((a) => a.fitPct)),
      fitInterviewed: { n: interviewed.length, avg: fitOf(interviewed) },
      fitNotInterviewed: { n: notInterviewed.length, avg: fitOf(notInterviewed) },
      weekly,
      topCompanies,
      withLetter: apps.filter((a) => a.coverLetter).length,
    };
  }

  function slug(s) {
    const out = String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
    return out || "untitled";
  }

  // The folder layout "Save to a folder" writes, and the same paths in the
  // JSON export, so the two never disagree about where a file lives:
  //   <company>/<role>-<yyyy-mm-dd>/{job-description.md, cover-letter.md,
  //     notes.md, details.json, documents/<name>}
  function folderPlan(app) {
    const day = (app.createdAt || "").slice(0, 10) || "undated";
    const dir = slug(app.company) + "/" + slug(app.title) + "-" + day;
    const files = [];
    const head = `# ${app.title}\n\n${app.company}${app.location ? ", " + app.location : ""}\n`
      + (app.url ? `\n${app.url}\n` : "") + "\n---\n\n";
    files.push({ path: dir + "/job-description.md", content: head + (app.description || "") + "\n" });
    if (app.coverLetter) files.push({ path: dir + "/cover-letter.md", content: app.coverLetter + "\n" });
    if (app.notes) files.push({ path: dir + "/notes.md", content: app.notes + "\n" });
    const seen = {};
    for (const d of app.docs || []) {
      let base = slug(d.name.replace(/\.[^.]+$/, ""));
      if (seen[base]) base += "-" + (++seen[base]); else seen[base] = 1;
      files.push({ path: dir + "/documents/" + base + ".md", content: d.text + "\n" });
    }
    files.push({
      path: dir + "/details.json",
      content: JSON.stringify({
        title: app.title, company: app.company, location: app.location, url: app.url,
        status: app.status, createdAt: app.createdAt, appliedAt: app.appliedAt,
        sponsorPct: app.sponsorPct, fitPct: app.fitPct, verdict: app.verdict,
      }, null, 2) + "\n",
    });
    return { dir, files };
  }

  function exportJson(list, now) {
    return JSON.stringify({ app: "job-radar-applications", version: 1,
      exportedAt: iso(now), applications: list }, null, 2);
  }

  // Returns the applications in an export, or throws with the reason, so a
  // wrong file is refused rather than quietly importing nothing.
  function parseImport(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { throw new Error("That file is not valid JSON."); }
    if (!data || data.app !== "job-radar-applications" || !Array.isArray(data.applications)) {
      throw new Error("That file is not an applications export from this dashboard.");
    }
    return data.applications.filter((a) => a && a.id && a.title && STATUSES.indexOf(a.status) >= 0)
      .map((a) => Object.assign(newApplication({}, 0), a, { docs: Array.isArray(a.docs) ? a.docs : [] }));
  }

  // Merge imported records into the list by id; the newer updatedAt wins.
  function mergeImport(list, incoming) {
    let added = 0, updated = 0;
    for (const inc of incoming) {
      const i = list.findIndex((a) => a.id === inc.id);
      if (i < 0) { list.push(inc); added++; }
      else if ((inc.updatedAt || "") > (list[i].updatedAt || "")) { list[i] = inc; updated++; }
    }
    return { added, updated };
  }

  root.Applications = {
    STATUSES, newApplication, findByUid, ensureForRole, setStatus, addDoc,
    stats, slug, folderPlan, exportJson, parseImport, mergeImport, weekStart,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = { Applications: root.Applications };
})(typeof self !== "undefined" ? self : this);
