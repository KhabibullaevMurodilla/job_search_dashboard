/*
 * DOM wiring for the public job-radar dashboard. Everything that touches
 * the network or the page lives here; the scoring (lib/scoring.js) and
 * prompt-building/quality-check logic (lib/dashboard-core.js) are both
 * pure and tested in Node without a browser.
 *
 * Nothing in this file has a server to talk to except:
 *   - this same GitHub Pages origin, for roles.json / registers.json
 *     (published by the scan workflow) and the rate-cv skill text
 *   - generativelanguage.googleapis.com, directly from this browser,
 *     using a Gemini API key the visitor types in and that stays in
 *     their own browser's localStorage -- never sent anywhere else,
 *     never embedded in this page's source.
 * There is no backend. A visitor's CV text, their Gemini key, and their
 * applied/skipped choices live only in their own browser.
 */
(function () {
  "use strict";

  const DC = self.DashboardCore;
  const SC = self.SponsorCheck;
  const A = self.Applications;
  const PH = self.Phd;

  const LS = {
    cv: "jr_cv_text",
    cvMeta: "jr_cv_meta",
    geminiKey: "jr_gemini_key",
    status: "jr_role_status",     // {uid: "applied"|"skipped"}
    apps: "jr_applications",      // [application records, see lib/applications.js]
    myName: "jr_my_name",         // string, used to sign emails and statements
    phd: "jr_phd",                // [PhD application records, see lib/phd.js]
  };

  const GEMINI_MODEL = "gemini-3.6-flash";

  // ------------------------------------------------------------- storage
  function lsGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) {
      console.warn("could not save to this browser's storage:", e);
      // A save that fails must not look like one that worked: say so where
      // the person is looking, and point at the backup that does not depend
      // on browser storage.
      const m = document.getElementById(state.tab === "phd" ? "ph-message" : "ap-message");
      if (m) m.textContent = "Your browser's storage is full, so the last change was not saved. "
        + "Use Export backup, then delete something you no longer need.";
      return false;
    }
  }

  const state = {
    roles: [],
    registers: [],
    cvText: lsGet(LS.cv, ""),
    statusByUid: lsGet(LS.status, {}),
    apps: lsGet(LS.apps, []),
    phd: self.Phd.normalizeAll(lsGet(LS.phd, [])),
    phFilter: "all", phSearch: "", openPhd: new Set(), busy: new Set(),
    tab: "roles",
    apFilter: "all", apSearch: "",
    openApps: new Set(),
    pasteRec: null,         // the application made from the pasted posting, if any
    evalCache: new Map(),   // uid -> evaluateJob() result, recomputed when CV changes
    filters: { search: "", minScore: 0, workMode: "any", country: "any", status: "all" },
    sortBy: "score",
  };

  // --------------------------------------------------------------- data
  async function loadData() {
    const [rolesRes, registersRes] = await Promise.all([
      fetch("./roles.json").catch(() => null),
      fetch("./registers.json").catch(() => null),
    ]);
    if (registersRes && registersRes.ok) {
      state.registers = DC.registersFromJson(await registersRes.json());
    }
    if (!rolesRes || !rolesRes.ok) {
      // Score a posting and My applications do not need the scan, so they
      // keep working; only the scanned-roles list is empty.
      showFatal("Could not load roles.json. If you're running this locally "
        + "rather than from the published Pages site, the data files won't "
        + "exist until a scan has run.");
      refreshAppScores();
      return;
    }
    const data = await rolesRes.json();
    // job-radar's own CLI (jobradar/output/__init__.py) writes this second
    // bucket as "matching", not "seen" -- confirmed against the real
    // scan output. On a first-ever scan every role is "new" so this bug
    // was invisible; from the second scan on, roles that were seen before
    // move into "matching" and this dashboard would silently stop showing
    // them, trending toward an empty list over time.
    state.roles = (data.new || []).concat(data.matching || []);
    state.meta = data.meta || {};
    evaluateAll();
    refreshAppScores();
    render();
  }

  function evaluateAll() {
    state.evalCache.clear();
    for (const role of state.roles) {
      const job = {
        title: role.title, company: role.company, location: role.location,
        description: role.description,
      };
      state.evalCache.set(role.uid,
        SC.evaluateJob(job, state.registers, state.cvText, null));
    }
  }

  // ------------------------------------------------------------- Gemini
  async function callGemini(prompt) {
    const key = lsGet(LS.geminiKey, "");
    if (!key) {
      throw new Error("Add your Gemini API key in Settings first "
        + "(free, no billing account needed, from aistudio.google.com/apikey).");
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/`
      + `${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((json.error && json.error.message)
        || `Gemini request failed with HTTP ${res.status}`);
    }
    return DC.stripCodeFence(DC.extractGeminiText(json));
  }

  function scoresFor(job) {
    const ev = SC.evaluateJob({
      title: job.title, company: job.company, location: job.location,
      description: job.description,
    }, state.registers, state.cvText, null);
    return {
      ev,
      sponsorPct: ev.legitimacy ? ev.legitimacy.percent : null,
      fitPct: ev.cvFit ? ev.cvFit.percent : null,
      verdict: ev.recommendation ? ev.recommendation.verdict : "",
    };
  }

  function saveApps() { return lsSet(LS.apps, state.apps); }
  function savePhd() { return lsSet(LS.phd, state.phd); }

  // Scores follow the CV you have now, so a better CV lifts every saved role.
  // Writes only when a score actually moved. This runs at page load, and an
  // unconditional write there let a second open tab (still holding the list
  // from before you saved something in the first) overwrite the library.
  function refreshAppScores() {
    let changed = false;
    for (const app of state.apps) {
      const sc = scoresFor(app);
      // A missing score (no CV saved right now) never erases one already kept.
      const sp = sc.sponsorPct != null ? sc.sponsorPct : app.sponsorPct;
      const fp = sc.fitPct != null ? sc.fitPct : app.fitPct;
      const vd = sc.fitPct != null ? sc.verdict : app.verdict;
      if (app.sponsorPct !== sp || app.fitPct !== fp || app.verdict !== vd) {
        app.sponsorPct = sp; app.fitPct = fp; app.verdict = vd;
        changed = true;
      }
    }
    if (changed) saveApps();
  }

  function appForRole(role) {
    const ev = state.evalCache.get(role.uid) || {};
    return A.ensureForRole(state.apps, role, {
      sponsorPct: ev.legitimacy && ev.legitimacy.percent,
      fitPct: ev.cvFit && ev.cvFit.percent,
      verdict: ev.recommendation && ev.recommendation.verdict,
    });
  }

  async function draftForApp(app) {
    if (!state.cvText.trim()) {
      throw new Error("Upload or paste your CV first (left panel). The letter "
        + "is written from it and checked so it does not repeat it.");
    }
    if (!(app.description || "").trim()) {
      throw new Error("This role has no description to write a letter against. "
        + "Paste the posting text into it first.");
    }
    const prompt = DC.buildCoverLetterPrompt(app, state.cvText);
    const draft = await callGemini(prompt);
    const q = DC.qualityCheckCoverLetter(draft, state.cvText);
    app.coverLetter = draft;
    app.updatedAt = new Date().toISOString();
    saveApps();
    return { draft, quality: q };
  }

  // ---------------------------------------------------------------- UI
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const child of children || []) node.appendChild(child);
    return node;
  }

  function showFatal(msg) {
    const root = document.getElementById("app");
    root.innerHTML = "";
    root.appendChild(el("div", { class: "fatal", text: msg }));
  }

  function tierClass(percent) {
    if (percent == null) return "sc-unknown";
    if (percent >= 70) return "sc-good";
    if (percent >= 40) return "sc-mid";
    return "sc-low";
  }

  function renderRoleCard(role) {
    const ev = state.evalCache.get(role.uid) || {};
    const status = state.statusByUid[role.uid] || "new";
    const sponsor = ev.legitimacy || {};
    const fit = ev.cvFit || {};

    const card = el("div", { class: `role-card status-${status}` });
    card.appendChild(el("div", { class: "role-stamp", text: `${Math.round(role.score || 0)}` }));
    const body = el("div", {}, []);
    body.appendChild(el("div", { class: "role-head" }, [
      el("div", { class: "role-title", text: role.title || "Untitled role" }),
      el("div", { class: "role-score", text: `${Math.round(role.score || 0)}` }),
    ]));
    body.appendChild(el("div", { class: "role-sub", text: `${role.company || "?"} · ${role.location || "not stated"} · ${role.salary_label || "salary not stated"}` }));

    const chips = el("div", { class: "role-chips" });
    chips.appendChild(el("span", { class: `chip ${tierClass(sponsor.percent)}`, text: `Sponsor: ${sponsor.percent == null ? "?" : sponsor.percent + "%"}` }));
    if (state.cvText.trim()) {
      chips.appendChild(el("span", { class: `chip ${tierClass(fit.percent)}`, text: `CV fit: ${fit.percent == null ? "?" : fit.percent + "%"}` }));
    }
    body.appendChild(chips);

    const actions = el("div", { class: "role-actions" });
    actions.appendChild(el("a", { href: role.url || "#", target: "_blank", rel: "noopener", class: "btn", text: "Open posting" }));
    actions.appendChild(el("button", { class: "btn", onclick: () => openLetterModal(appForRole(role)), text: "Draft cover letter" }));
    actions.appendChild(el("button", {
      class: `btn ${status === "applied" ? "btn-active" : ""}`,
      onclick: () => setStatus(role.uid, status === "applied" ? "new" : "applied"),
      text: status === "applied" ? "Applied ✓" : "Mark applied",
    }));
    actions.appendChild(el("button", {
      class: `btn ${status === "skipped" ? "btn-active" : ""}`,
      onclick: () => setStatus(role.uid, status === "skipped" ? "new" : "skipped"),
      text: status === "skipped" ? "Skipped" : "Skip",
    }));
    body.appendChild(actions);

    if (state.cvText.trim() && fit.percent != null) {
      const lines = [fit.reason].concat(fit.subDetails || []).filter(Boolean);
      body.appendChild(el("div", { class: "role-reason", text: "CV fit: " + lines.join(" | ") }));
    }
    // The reason lives on legitimacy.sponsor, not legitimacy itself; this
    // used to read legitimacy.reason, which does not exist, so the line
    // never appeared.
    const sponsorReason = sponsor.sponsor && sponsor.sponsor.reason;
    if (sponsorReason) {
      body.appendChild(el("div", { class: "role-reason", text: sponsorReason }));
    }
    card.appendChild(body);
    return card;
  }

  function setStatus(uid, status) {
    if (status === "new") delete state.statusByUid[uid];
    else state.statusByUid[uid] = status;
    lsSet(LS.status, state.statusByUid);
    // Applying to a scanned role puts it in the library; un-applying (a
    // mis-click) puts it back to saved rather than leaving a false "applied".
    const role = state.roles.find((r) => r.uid === uid);
    if (status === "applied" && role) A.setStatus(appForRole(role), "applied");
    else if (status === "new") {
      const rec = A.findByUid(state.apps, uid);
      if (rec && rec.status !== "saved") A.setStatus(rec, "saved");
    }
    saveApps();
    render();
    if (state.tab === "apps") renderApps();
  }

  function render() {
    const list = document.getElementById("role-list");
    list.innerHTML = "";
    const filtered = DC.filterRoles(state.roles, state.filters, state.statusByUid);
    let sorted = DC.sortRoles(filtered, state.sortBy);
    if (state.sortBy === "cvfit") {
      const pct = (r) => ((state.evalCache.get(r.uid) || {}).cvFit || {}).percent;
      sorted = filtered.slice().sort((a, b) => (pct(b) ?? -1) - (pct(a) ?? -1));
    }
    document.getElementById("role-count").textContent =
      `${sorted.length} of ${state.roles.length} roles`;
    for (const role of sorted) list.appendChild(renderRoleCard(role));
    if (!sorted.length) {
      list.appendChild(el("div", { class: "empty", text: "No roles match the current filters." }));
    }
  }

  // ------------------------------------------------------------- modal
  function letterActions(app) {
    const actions = el("div", { class: "modal-actions" });
    actions.appendChild(el("button", { class: "btn", onclick: () => copyText(app.coverLetter), text: "Copy" }));
    actions.appendChild(el("button", { class: "btn", onclick: () => downloadText(app.coverLetter, `cover-letter-${A.slug(app.company)}-${A.slug(app.title)}.md`), text: "Download .md" }));
    actions.appendChild(el("button", { class: "btn", onclick: () => openLetterModal(app, true), text: "Redraft" }));
    return actions;
  }

  // Shows the letter already saved for this role if there is one, because
  // drafting again spends a Gemini call and replaces what you may have edited
  // elsewhere. "Redraft" is the deliberate way to ask for a new one.
  function openLetterModal(app, force) {
    const modal = document.getElementById("modal");
    const body = document.getElementById("modal-body");
    document.getElementById("modal-title").textContent = `Cover letter draft — ${app.title}`;
    body.innerHTML = "";
    modal.classList.add("open");

    if (app.coverLetter && !force) {
      body.appendChild(el("div", { class: "small", text: "Saved earlier in My applications." }));
      body.appendChild(el("pre", { class: "draft-text", text: app.coverLetter }));
      body.appendChild(letterActions(app));
      return;
    }
    body.appendChild(el("div", { class: "modal-status", text: "Drafting with Gemini… this calls the API directly from your browser with your own key." }));
    draftForApp(app).then(({ quality }) => {
      body.innerHTML = "";
      if (!quality.ok) {
        body.appendChild(el("div", { class: "quality-warn" }, [
          el("div", { text: "This draft did not clear every check (lighter checks than the local job-radar tool runs):" }),
          el("ul", {}, quality.problems.map((p) => el("li", { text: p }))),
        ]));
      }
      body.appendChild(el("pre", { class: "draft-text", text: app.coverLetter }));
      body.appendChild(letterActions(app));
      body.appendChild(el("div", { class: "small", text: "Saved in My applications." }));
      if (state.tab === "apps") renderApps();
    }).catch((err) => {
      // A draft that could not run (no CV, no key, no description) must not
      // leave an empty record behind in My applications. Only a record with
      // nothing in it yet is removed; anything the person already put in it stays.
      if (!app.coverLetter && app.status === "saved" && !app.notes && !app.docs.length) {
        const i = state.apps.indexOf(app);
        if (i >= 0) { state.apps.splice(i, 1); if (state.pasteRec === app) state.pasteRec = null; saveApps(); }
      }
      body.innerHTML = "";
      body.appendChild(el("div", { class: "fatal", text: err.message || String(err) }));
    });
  }

  function viewTextModal(title, text) {
    document.getElementById("modal-title").textContent = title;
    const body = document.getElementById("modal-body");
    body.innerHTML = "";
    body.appendChild(el("pre", { class: "draft-text", text }));
    document.getElementById("modal").classList.add("open");
  }

  function closeModal() {
    document.getElementById("modal").classList.remove("open");
  }

  function copyText(text) {
    navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {});
  }

  function downloadBlob(blob, filename) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  function downloadText(text, filename) {
    downloadBlob(new Blob([text], { type: "text/markdown" }), filename);
  }

  // --------------------------------------------------------- CV / PDF
  async function extractPdfText(arrayBuffer) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "./lib/pdf.worker.min.js";
    const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => it.str).join(" "));
    }
    return pages.join("\n");
  }

  async function fileToText(file) {
    if (file.name.toLowerCase().endsWith(".pdf")) {
      return (await extractPdfText(await file.arrayBuffer())).replace(/\s+/g, " ").trim();
    }
    return await file.text();
  }

  // ------------------------------------------------------------- tabs
  function showTab(name) {
    state.tab = name;
    for (const b of document.querySelectorAll("#tabs [data-tab]")) {
      b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false");
    }
    for (const t of ["roles", "score", "apps", "phd"]) {
      document.getElementById("view-" + t).hidden = t !== name;
    }
    document.getElementById("panel-filters").hidden = name !== "roles";
    if (name === "apps") renderApps();
    if (name === "phd") renderPhd();
  }

  // ------------------------------------------------- score a posting
  function pasteJob() {
    return {
      title: document.getElementById("ps-title").value,
      company: document.getElementById("ps-company").value,
      location: document.getElementById("ps-location").value,
      url: document.getElementById("ps-url").value,
      description: document.getElementById("ps-desc").value,
    };
  }

  // The one record a pasted posting becomes, however many times Save or
  // Draft is pressed on the same result.
  function pasteRecord() {
    if (state.pasteRec && state.apps.indexOf(state.pasteRec) >= 0) return state.pasteRec;
    const job = pasteJob();
    const sc = scoresFor(job);
    const rec = A.newApplication(Object.assign({}, job, {
      source: "pasted", sponsorPct: sc.sponsorPct, fitPct: sc.fitPct, verdict: sc.verdict,
    }));
    state.apps.push(rec);
    state.pasteRec = rec;
    return rec;
  }

  function runPasteScore() {
    const out = document.getElementById("ps-result");
    const job = pasteJob();
    state.pasteRec = null;
    out.hidden = false;
    out.innerHTML = "";
    if (!job.description.trim()) {
      out.appendChild(el("div", { class: "fatal", text: "Paste the job description first. Without its text there is nothing to score." }));
      return;
    }
    const sc = scoresFor(job);
    const ev = sc.ev;
    const rec = ev.recommendation || {};
    const card = el("div", { class: "role-card" });
    card.appendChild(el("div", { class: "role-stamp", text: rec.score == null ? "?" : String(Math.round(rec.score)) }));
    const body = el("div", {}, []);
    body.appendChild(el("div", { class: "role-title", text: (job.title || "").trim() || "Untitled role" }));
    body.appendChild(el("div", { class: "role-sub", text: `${(job.company || "").trim() || "Unknown company"}${job.location ? ", " + job.location : ""}` }));
    body.appendChild(el("div", { class: "verdict", text: rec.verdict || "" }));
    body.appendChild(el("div", { class: "role-sub", text: rec.explanation || "" }));
    const chips = el("div", { class: "role-chips" });
    chips.appendChild(el("span", { class: `chip ${tierClass(sc.sponsorPct)}`, text: `Sponsor: ${sc.sponsorPct == null ? "?" : sc.sponsorPct + "%"}` }));
    chips.appendChild(el("span", { class: `chip ${tierClass(sc.fitPct)}`, text: `CV fit: ${sc.fitPct == null ? "no CV saved" : sc.fitPct + "%"}` }));
    body.appendChild(chips);

    const notes = [];
    const leg = ev.legitimacy || {};
    if (leg.verdict) notes.push(leg.verdict + ".");
    for (const part of [leg.sponsor, leg.pattern, leg.descriptionQuality]) {
      if (part && part.reason) notes.push(part.reason);
    }
    if (ev.cvFit) notes.push(...[ev.cvFit.reason].concat(ev.cvFit.subDetails || []).filter(Boolean));
    if (notes.length) {
      body.appendChild(el("ul", { class: "detail-list" }, notes.map((t) => el("li", { text: t }))));
    }
    const actions = el("div", { class: "role-actions" });
    actions.appendChild(el("button", { class: "btn", id: "ps-draft", onclick: () => openLetterModal(pasteRecord()), text: "Draft cover letter" }));
    actions.appendChild(el("button", { class: "btn", id: "ps-save", onclick: () => {
      pasteRecord();
      saveApps();
      document.getElementById("ps-saved").textContent = "Saved to My applications.";
    }, text: "Save to my applications" }));
    body.appendChild(actions);
    body.appendChild(el("div", { class: "small", id: "ps-saved", role: "status" }));
    card.appendChild(body);
    out.appendChild(card);
  }

  // --------------------------------------------- my applications
  function barRow(label, count, max, cls) {
    return el("div", { class: "funnel-row", title: `${label}: ${count}` }, [
      el("span", { text: label }),
      el("div", { class: "funnel-track" }, [
        el("div", { class: `funnel-bar ${cls || ""}`, style: `width:${max ? Math.round(100 * count / max) : 0}%` }),
      ]),
      el("span", { class: "funnel-count", text: String(count) }),
    ]);
  }

  function shortWeek(isoDate) {
    const d = new Date(isoDate + "T00:00:00Z");
    return d.getUTCDate() + " " + d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" });
  }

  function renderAppDashboard() {
    const root = document.getElementById("ap-dashboard");
    root.innerHTML = "";
    const st = A.stats(state.apps);
    if (!st.total) {
      root.appendChild(el("div", { class: "empty", text: "Nothing here yet. Draft a cover letter, mark a scanned role applied, or paste a posting on the Score a posting tab, and it is kept here." }));
      return;
    }
    const charts = el("div", { class: "charts" });

    const funnel = el("div", { class: "chart" }, [el("h3", { text: "Where your applications stand" })]);
    const maxCount = Math.max(1, ...A.STATUSES.map((k) => st.byStatus[k]));
    for (const k of A.STATUSES) funnel.appendChild(barRow(k[0].toUpperCase() + k.slice(1), st.byStatus[k], maxCount, k));
    charts.appendChild(funnel);

    const weekly = el("div", { class: "chart" }, [el("h3", { text: "Last eight weeks" })]);
    weekly.appendChild(el("div", { class: "legend" }, [
      el("span", {}, [el("span", { class: "swatch applied" }), document.createTextNode("Applied")]),
      el("span", {}, [el("span", { class: "swatch saved" }), document.createTextNode("Saved")]),
    ]));
    const maxW = Math.max(1, ...st.weekly.map((w) => Math.max(w.saved, w.applied)));
    const cols = el("div", { class: "weekly", role: "img", "aria-label": "Roles saved and applied to, per week, last eight weeks. The same numbers are in the table below." });
    for (const w of st.weekly) {
      cols.appendChild(el("div", { class: "week-col", title: `Week of ${w.weekStart}: ${w.saved} saved, ${w.applied} applied` }, [
        el("div", { class: "week-bar saved", style: `height:${Math.round(100 * w.saved / maxW)}%` }),
        el("div", { class: "week-bar applied", style: `height:${Math.round(100 * w.applied / maxW)}%` }),
      ]));
    }
    weekly.appendChild(cols);
    weekly.appendChild(el("div", { class: "week-labels" }, st.weekly.map((w) => el("span", { text: shortWeek(w.weekStart) }))));
    const tbl = el("table", { class: "plain" }, [
      el("tr", {}, ["Week of", "Saved", "Applied"].map((t) => el("th", { text: t }))),
    ].concat(st.weekly.map((w) => el("tr", {}, [w.weekStart, String(w.saved), String(w.applied)].map((t) => el("td", { text: t }))))));
    weekly.appendChild(el("details", { class: "small" }, [el("summary", { text: "Show these as a table" }), tbl]));
    charts.appendChild(weekly);
    root.appendChild(charts);

    const ins = el("div", { class: "insights" });
    const line = (t) => ins.appendChild(el("p", { text: t }));
    if (st.submitted) {
      line(`${st.submitted} submitted. ${st.interviewRate}% reached interview or offer; ${st.responseRate}% have had any answer, including a rejection.`);
    } else {
      line("No applications submitted yet. Mark a role applied and the response rates appear here.");
    }
    if (st.avgFit != null) line(`Average CV fit across everything saved: ${st.avgFit}%. Average sponsor score: ${st.avgSponsor == null ? "n/a" : st.avgSponsor + "%"}.`);
    if (st.fitInterviewed.avg != null && st.fitNotInterviewed.avg != null) {
      line(`CV fit where you got an interview or offer: ${st.fitInterviewed.avg}% (${st.fitInterviewed.n} roles). Where you did not: ${st.fitNotInterviewed.avg}% (${st.fitNotInterviewed.n} roles).`
        + (st.submitted < 10 ? " Too few applications yet to read much into the gap." : ""));
    }
    if (st.topCompanies.length) line("Most saved companies: " + st.topCompanies.map((c) => `${c.name} (${c.count})`).join(", ") + ".");
    line(`${st.withLetter} of ${st.total} have a cover letter. Scores use your current CV.`);
    root.appendChild(ins);
  }

  function renderAppRow(app) {
    const d = el("details", { class: "app" });
    d.dataset.id = app.id;
    if (state.openApps.has(app.id)) d.setAttribute("open", "");
    d.addEventListener("toggle", () => { if (d.open) state.openApps.add(app.id); else state.openApps.delete(app.id); });

    d.appendChild(el("summary", {}, [
      el("div", {}, [
        el("div", { class: "app-title", text: app.title }),
        el("div", { class: "app-meta", text: `${app.company}${app.location ? ", " + app.location : ""}${app.source === "pasted" ? " (pasted)" : ""}` }),
      ]),
      el("div", { class: "role-chips", style: "margin:0" }, [
        el("span", { class: `pill st-${app.status}`, text: app.status }),
        el("span", { class: `chip ${tierClass(app.fitPct)}`, text: `CV fit ${app.fitPct == null ? "?" : app.fitPct + "%"}` }),
      ]),
    ]));

    const body = el("div", { class: "app-body" });

    const sel = el("select", { "aria-label": "Status", style: "width:auto" });
    for (const k of A.STATUSES) { const o = el("option", { value: k, text: k }); if (k === app.status) o.setAttribute("selected", ""); sel.appendChild(o); }
    sel.value = app.status;
    sel.addEventListener("change", () => {
      A.setStatus(app, sel.value);
      if (app.uid) {
        if (app.status === "saved") delete state.statusByUid[app.uid];
        else if (app.status !== "withdrawn") state.statusByUid[app.uid] = "applied";
        lsSet(LS.status, state.statusByUid);
        render();
      }
      saveApps(); renderApps();
    });
    const top = el("div", { class: "row", style: "margin:0;align-items:center" }, [sel]);
    if (app.url) top.appendChild(el("a", { href: app.url, target: "_blank", rel: "noopener", class: "btn", text: "Open posting" }));
    top.appendChild(el("span", { class: "small", text: `Saved ${app.createdAt.slice(0, 10)}${app.appliedAt ? ", applied " + app.appliedAt.slice(0, 10) : ""}` }));
    body.appendChild(top);
    if (app.verdict) body.appendChild(el("div", { class: "small", text: `Verdict when scored: ${app.verdict}. Sponsor ${app.sponsorPct == null ? "?" : app.sponsorPct + "%"}.` }));

    const notes = el("textarea", { "aria-label": "Notes", placeholder: "Contacts, dates, what to ask, how it went." });
    notes.value = app.notes || "";
    notes.addEventListener("change", () => { app.notes = notes.value; app.updatedAt = new Date().toISOString(); saveApps(); });
    body.appendChild(el("div", {}, [el("h4", { text: "Notes" }), notes]));

    const letter = el("div", {}, [el("h4", { text: "Cover letter" })]);
    if (app.coverLetter) {
      letter.appendChild(el("pre", { class: "draft-text", text: app.coverLetter }));
      letter.appendChild(el("div", { class: "row" }, [
        el("button", { class: "btn", onclick: () => copyText(app.coverLetter), text: "Copy" }),
        el("button", { class: "btn", onclick: () => downloadText(app.coverLetter, `cover-letter-${A.slug(app.company)}-${A.slug(app.title)}.md`), text: "Download .md" }),
        el("button", { class: "btn", onclick: () => openLetterModal(app, true), text: "Redraft" }),
      ]));
    } else {
      letter.appendChild(el("button", { class: "btn", onclick: () => openLetterModal(app), text: "Draft cover letter" }));
    }
    body.appendChild(letter);

    const docs = el("div", {}, [el("h4", { text: "Documents you sent or received" })]);
    for (const doc of app.docs) {
      docs.appendChild(el("div", { class: "doc-row" }, [
        el("span", { text: doc.name }),
        el("span", { class: "pill", text: doc.kind.replace("_", " ") }),
        el("button", { class: "btn", onclick: () => viewTextModal(doc.name, doc.text), text: "View" }),
        el("button", { class: "btn", onclick: () => { app.docs = app.docs.filter((x) => x.id !== doc.id); saveApps(); renderApps(); }, text: "Remove" }),
      ]));
    }
    const kind = el("select", { "aria-label": "Document type", style: "width:auto" }, [
      el("option", { value: "cv", text: "CV" }), el("option", { value: "cover_letter", text: "Cover letter" }), el("option", { value: "other", text: "Other" }),
    ]);
    const attach = el("input", { type: "file", accept: ".txt,.md,.pdf", "aria-label": "Attach a document" });
    attach.addEventListener("change", async () => {
      const f = attach.files[0];
      if (!f) return;
      try {
        const text = await fileToText(f);
        if (!text.trim()) throw new Error("No text could be read from that file (a scanned PDF has none).");
        A.addDoc(app, { name: f.name, kind: kind.value, text });
        saveApps(); renderApps();
      } catch (e) { document.getElementById("ap-message").textContent = e.message || String(e); }
    });
    docs.appendChild(el("div", { class: "row" }, [kind, attach]));
    docs.appendChild(el("div", { class: "note", text: "The text of the file is stored in this browser. The original file is not kept, so keep your own copy." }));
    body.appendChild(docs);

    if (app.description) body.appendChild(el("details", {}, [el("summary", { class: "small", text: "Job description" }), el("pre", { class: "draft-text", text: app.description })]));

    body.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", onclick: () => {
      if (!window.confirm(`Delete "${app.title}" at ${app.company} and everything saved with it?`)) return;
      state.apps = state.apps.filter((x) => x !== app);
      if (state.pasteRec === app) state.pasteRec = null;
      saveApps(); renderApps();
    }, text: "Delete this application" })]));

    d.appendChild(body);
    return d;
  }

  function renderApps() {
    renderAppDashboard();
    const list = document.getElementById("ap-list");
    list.innerHTML = "";
    const q = state.apSearch.trim().toLowerCase();
    const rows = state.apps.filter((a) =>
      (state.apFilter === "all" || a.status === state.apFilter)
      && (!q || (a.title + " " + a.company + " " + a.location).toLowerCase().includes(q)))
      .sort((x, y) => (y.updatedAt || "").localeCompare(x.updatedAt || ""));
    for (const a of rows) list.appendChild(renderAppRow(a));
    if (state.apps.length && !rows.length) list.appendChild(el("div", { class: "empty", text: "No saved role matches that search or status." }));
  }

  // ------------------------------------------- keep it all locally
  function setApMessage(t) { document.getElementById("ap-message").textContent = t; }

  // Job applications and PhD applications go in one archive: jobs by company
  // at the top level, PhD applications under phd/.
  function allFiles() {
    const files = [];
    for (const a of state.apps) files.push(...A.folderPlan(a).files);
    for (const p of state.phd) files.push(...PH.folderPlan(p).files);
    return files;
  }

  function downloadZip(say) {
    const note = say || setApMessage;
    if (!state.apps.length && !state.phd.length) { note("Nothing to download yet."); return; }
    const files = allFiles();
    downloadBlob(new Blob([self.Zip.build(files)], { type: "application/zip" }), "job-applications.zip");
    note(`Downloaded ${files.length} files: one folder per company and role, and PhD applications under phd/.`);
  }

  async function saveToFolder() {
    if (!state.apps.length && !state.phd.length) { setApMessage("Nothing to save yet."); return; }
    try {
      const root = await window.showDirectoryPicker({ mode: "readwrite" });
      const files = allFiles();
      for (const f of files) {
        const parts = f.path.split("/");
        let dir = root;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const w = await fh.createWritable();
        await w.write(f.content);
        await w.close();
      }
      setApMessage(`Wrote ${files.length} files into "${root.name}". Files with the same name from an earlier save were replaced.`);
    } catch (e) {
      if (e && e.name === "AbortError") return;
      setApMessage("Could not save to that folder: " + (e.message || e));
    }
  }

  async function importBackup(file) {
    try {
      const incoming = A.parseImport(await file.text());
      const r = A.mergeImport(state.apps, incoming);
      saveApps(); renderApps();
      setApMessage(`Imported: ${r.added} new, ${r.updated} updated.`);
    } catch (e) { setApMessage(e.message || String(e)); }
  }


  // ------------------------------------------------- PhD applications
  function setPhMessage(t) { document.getElementById("ph-message").textContent = t; }

  function dlClass(info) { return info.level === "none" || info.level === "closed" ? "" : "dl-" + info.level; }

  function renderPhdDashboard() {
    const root = document.getElementById("ph-dashboard");
    root.innerHTML = "";
    const st = PH.stats(state.phd);
    if (!st.total) {
      root.appendChild(el("div", { class: "empty", text: "No programmes yet. Use Add a programme above: each one gets a checklist, a deadline, a place for your research proposal, and a supervisor email draft." }));
      return;
    }
    if (st.upcoming.length) {
      root.appendChild(el("h3", { text: "Next deadlines", style: "margin:0 0 6px;font-size:13px" }));
      const ul = el("ul", { class: "next-list" });
      for (const u of st.upcoming.slice(0, 5)) {
        const info = PH.deadlineInfo(state.phd.find((p) => p.id === u.id));
        ul.appendChild(el("li", {}, [
          el("span", { text: `${u.university}, ${u.programme}` }),
          el("span", { class: `pill ${dlClass(info)}`, text: `${u.deadline}: ${info.label}` }),
          el("span", { class: "small", text: `${u.pct}% ready` }),
        ]));
      }
      root.appendChild(ul);
    }
    const charts = el("div", { class: "charts" });
    const funnel = el("div", { class: "chart" }, [el("h3", { text: "Where your programmes stand" })]);
    const max = Math.max(1, ...PH.STATUSES.map((k) => st.byStatus[k]));
    for (const k of PH.STATUSES) funnel.appendChild(barRow(k[0].toUpperCase() + k.slice(1), st.byStatus[k], max, k));
    charts.appendChild(funnel);
    root.appendChild(charts);

    const ins = el("div", { class: "insights" });
    const line = (t) => ins.appendChild(el("p", { text: t }));
    line(`${st.total} programme${st.total === 1 ? "" : "s"}: ${st.open} still being prepared, ${st.submitted} submitted${st.answered ? `, ${st.answered} answered` : ""}.`);
    if (st.avgReadiness != null) line(`The ones still open are on average ${st.avgReadiness}% ready (ticked checklist items).`);
    if (st.overdue) line(`${st.overdue} open programme${st.overdue === 1 ? " has" : "s have"} a deadline that has passed. Mark ${st.overdue === 1 ? "it" : "them"} submitted or withdrawn, or fix the date.`);
    line(`${st.withProposal} of ${st.total} have a research proposal saved here.`);
    root.appendChild(ins);
  }

  const TASK_TEXT = {
    email: ["Draft supervisor email", "Redraft", "Drafting the supervisor email…"],
    review: ["Review against this programme", "Review again", "Reviewing the proposal…"],
    statement: ["Draft personal statement", "Redraft", "Drafting the personal statement…"],
    tailor: ["Tailor my proposal to this programme", "Tailor again", "Tailoring the proposal…"],
  };
  const myName = () => (lsGet(LS.myName, "") || "").trim();

  // One Gemini job for a record. Returns a plain-language note, or throws
  // with the reason it could not run (no CV, no key, nothing to work from).
  async function phdTask(p, kind) {
    if (!state.cvText.trim()) throw new Error("Upload or paste your CV first (left panel). Everything here is written against it.");
    if ((kind === "review" || kind === "tailor") && !(p.proposal || "").trim()) throw new Error("Paste your research proposal into this programme first.");
    if (kind === "email" && !(p.theme || p.supervisor || p.programme)) throw new Error("Add the theme or supervisor first.");
    const prompt = {
      email: () => PH.buildSupervisorEmailPrompt(p, state.cvText),
      review: () => PH.buildProposalReviewPrompt(p, state.cvText),
      statement: () => PH.buildStatementPrompt(p, state.cvText, myName()),
      tailor: () => PH.buildTailorProposalPrompt(p, state.cvText),
    }[kind]();
    const text = await callGemini(prompt);
    let note;
    if (kind === "email") {
      p.supervisorDraft = text;
      const q = PH.qualityCheckEmail(text, p);
      note = q.ok ? `Supervisor email drafted (${q.words} words).` : "Supervisor email drafted, but check: " + q.problems.join(" ");
    } else if (kind === "statement") {
      p.statement = text;
      const q = PH.qualityCheckStatement(text, state.cvText, DC.sharedNgram);
      note = q.ok ? `Personal statement drafted (${q.words} words).` : "Personal statement drafted, but check: " + q.problems.join(" ");
    } else if (kind === "tailor") {
      p.tailoredProposal = text;
      note = /^\s*NOTE:/i.test(text) ? "Proposal tailored. Read the NOTE on the first line: it says what does not fit this programme." : "Proposal tailored. Your original is untouched.";
    } else {
      p.proposalReview = text;
      note = "Proposal review saved.";
    }
    p.updatedAt = new Date().toISOString();
    savePhd();
    return note;
  }

  async function phdGenerate(p, kind) {
    const key = p.id + ":" + kind;
    if (state.busy.has(key) || state.busy.has(p.id + ":all")) return;
    state.busy.add(key);
    setPhMessage(TASK_TEXT[kind][2]);
    renderPhd();
    try { setPhMessage(await phdTask(p, kind)); }
    catch (e) { setPhMessage(e.message || String(e)); }
    finally { state.busy.delete(key); state.openPhd.add(p.id); renderPhd(); }
  }

  // Everything that can be drafted, in order. A missing CV or key stops the
  // run at once; a step that has nothing to work from (no proposal) is skipped.
  async function phdPrepareAll(p) {
    const key = p.id + ":all";
    if (state.busy.has(key)) return;
    state.busy.add(key);
    const done = [], skipped = [];
    renderPhd();
    try {
      for (const kind of ["statement", "tailor", "email", "review"]) {
        if ((kind === "tailor" || kind === "review") && !(p.proposal || "").trim()) { skipped.push(kind === "tailor" ? "tailored proposal" : "proposal review"); continue; }
        setPhMessage(`Preparing everything: ${TASK_TEXT[kind][2].replace("…", "")} (${done.length + skipped.length + 1} of 4)…`);
        try { await phdTask(p, kind); done.push(kind); }
        catch (e) {
          if (/CV first|Gemini API key|API key|quota|HTTP/i.test(e.message || "")) { setPhMessage((done.length ? `Stopped after ${done.length} of 4: ` : "") + (e.message || String(e))); return; }
          skipped.push(kind);
        }
      }
      const names = { statement: "personal statement", tailor: "tailored proposal", email: "supervisor email", review: "proposal review" };
      setPhMessage("Prepared: " + (done.map((k) => names[k]).join(", ") || "nothing")
        + (skipped.length ? `. Not done: ${skipped.join(", ")}${(p.proposal || "").trim() ? "" : " (paste your research proposal to get these)"}` : "")
        + ". Read each draft and edit it before you use it.");
    } finally { state.busy.delete(key); state.openPhd.add(p.id); renderPhd(); }
  }

  function genButton(p, kind) {
    const busy = state.busy.has(p.id + ":" + kind) || state.busy.has(p.id + ":all");
    const has = { email: p.supervisorDraft, review: p.proposalReview, statement: p.statement, tailor: p.tailoredProposal }[kind];
    const b = el("button", { class: "btn", text: busy ? "Working…" : TASK_TEXT[kind][has ? 1 : 0], onclick: () => phdGenerate(p, kind) });
    if (busy) b.setAttribute("disabled", "");
    return b;
  }

  function textBlock(p, label, field, extra) {
    const wrap = el("div", {}, [el("h4", { text: label })]);
    if (p[field]) {
      const ta = el("textarea", { "aria-label": label, style: "min-height:180px" });
      ta.value = p[field];
      ta.addEventListener("change", () => { p[field] = ta.value; p.updatedAt = new Date().toISOString(); savePhd(); });
      wrap.appendChild(ta);
    }
    const row = el("div", { class: "row" }, [genButton(p, extra)]);
    if (p[field]) row.appendChild(el("button", { class: "btn", text: "Copy", onclick: () => copyText(p[field]) }));
    wrap.appendChild(row);
    return wrap;
  }

  function downloadOne(p) {
    const files = PH.folderPlan(p).files;
    downloadBlob(new Blob([self.Zip.build(files)], { type: "application/zip" }), `phd-${PH.slug(p.university)}-${PH.slug(p.programme)}.zip`);
    setPhMessage(`Downloaded ${files.length} files for ${p.programme} at ${p.university}.`);
  }

  // ---- start from an advert
  function cvMatchFor(advert) {
    if (!state.cvText.trim()) return { percent: null, matched: [], missing: [], total: 0, noCv: true };
    return PH.cvTermMatch(advert, state.cvText);
  }

  async function readAdvert() {
    const text = document.getElementById("ph-advert-text").value;
    const out = document.getElementById("ph-advert-result");
    out.hidden = false; out.innerHTML = "";
    if (text.trim().length < 120) { out.appendChild(el("p", { text: "Paste the whole advert first. That is too short to read." })); return; }
    const checks = PH.advertChecks(text);
    let fit = cvMatchFor(text);
    let found = null, foundNote = "";
    if (lsGet(LS.geminiKey, "")) {
      out.appendChild(el("p", { class: "small", text: "Reading the advert with Gemini…" }));
      try { found = PH.parseAdvertExtract(await callGemini(PH.buildAdvertExtractPrompt(text))); }
      catch (e) { foundNote = e.message || String(e); }
      out.innerHTML = "";
    } else {
      foundNote = "Add your Gemini key (left panel) and I will read out the details for you. For now, fill them in below.";
    }
    const f = found || { university: "", programme: "", theme: "", supervisor: "", funding: "unknown", deadline: "", requirements: [] };

    if (fit.noCv) {
      out.appendChild(el("h4", { text: "CV match: not scored", style: "margin:0 0 4px" }));
      out.appendChild(el("p", { class: "small", text: "Save your CV in the left panel to see which of this advert's main terms it mentions." }));
    } else if (fit.percent == null) {
      out.appendChild(el("h4", { text: "CV match: not enough text", style: "margin:0 0 4px" }));
      out.appendChild(el("p", { class: "small", text: "The advert has too few distinctive terms to compare." }));
    } else {
      out.appendChild(el("h4", { text: `Your CV mentions ${fit.matched.length} of the advert's ${fit.total} main terms (${fit.percent}%)`, style: "margin:0 0 4px" }));
      out.appendChild(el("p", { class: "small", text: "Found in your CV: " + (fit.matched.join(", ") || "none") }));
      out.appendChild(el("p", { class: "small", text: "Not in your CV: " + (fit.missing.join(", ") || "none") + ". This is word overlap, not a judgement of your chances: a term can be missing only because you word it differently." }));
    }
    out.appendChild(el("h4", { text: "What the advert says", style: "margin:12px 0 2px" }));
    const ul = el("ul", { class: "found-list" });
    for (const i of checks.items) ul.appendChild(el("li", { text: (i.found ? "Yes: " : "Not found: ") + i.label }));
    out.appendChild(ul);
    if (checks.warnings.length) out.appendChild(el("ul", { class: "warn-list" }, checks.warnings.map((w) => el("li", { text: w }))));
    if (f.requirements.length) {
      out.appendChild(el("h4", { text: "What it asks of you", style: "margin:12px 0 2px" }));
      out.appendChild(el("ul", { class: "found-list" }, f.requirements.map((r) => el("li", { text: r }))));
    }
    if (foundNote) out.appendChild(el("p", { class: "small", text: foundNote }));

    const inputs = {};
    const grid = el("div", { class: "form-grid" });
    const add = (key, label, type, wide) => {
      const input = el("input", { type: type || "text", "aria-label": label });
      input.value = f[key] || "";
      inputs[key] = input;
      grid.appendChild(el("div", { class: wide ? "wide" : "" }, [el("label", { text: label }), input]));
    };
    add("university", "University"); add("programme", "Programme"); add("theme", "Research theme", "text", true);
    add("supervisor", "Supervisor"); add("deadline", "Deadline", "date");
    const fund = el("select", { "aria-label": "Funding" });
    for (const x of PH.FUNDING) fund.appendChild(el("option", { value: x, text: x }));
    fund.value = f.funding; inputs.funding = fund;
    grid.appendChild(el("div", {}, [el("label", { text: "Funding" }), fund]));
    out.appendChild(el("h4", { text: "Check these, then add it", style: "margin:12px 0 2px" }));
    out.appendChild(grid);
    out.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "ph-advert-add", text: "Add as a programme", onclick: () => {
      if (!inputs.university.value.trim()) { setPhMessage("Add the university's name first."); return; }
      const p = PH.newPhd({
        university: inputs.university.value, programme: inputs.programme.value, theme: inputs.theme.value,
        supervisor: inputs.supervisor.value, funding: inputs.funding.value, deadline: inputs.deadline.value,
        advert: text, requirements: f.requirements,
      });
      state.phd.push(p);
      if (savePhd()) {
        state.openPhd.add(p.id);
        document.getElementById("ph-advert-text").value = ""; out.hidden = true; out.innerHTML = "";
        setPhMessage(`Added ${p.programme} at ${p.university}. Open it and press Prepare everything.`);
      }
      renderPhd();
    } })]));
  }

  function renderPhdRow(p) {
    const d = el("details", { class: "app" });
    d.dataset.id = p.id;
    if (state.openPhd.has(p.id)) d.setAttribute("open", "");
    d.addEventListener("toggle", () => { if (d.open) state.openPhd.add(p.id); else state.openPhd.delete(p.id); });
    const touch = () => { p.updatedAt = new Date().toISOString(); savePhd(); };
    const r = PH.readiness(p);
    const info = PH.deadlineInfo(p);

    const chips = [el("span", { class: `pill st-${p.status}`, text: p.status })];
    if (info.level !== "closed" && info.level !== "none") chips.push(el("span", { class: `pill ${dlClass(info)}`, text: info.label }));
    chips.push(el("span", { class: "chip" }, [
      el("span", { class: "meter", role: "img", "aria-label": `${r.pct}% of the checklist ticked` }, [el("i", { style: `width:${r.pct}%` })]),
      document.createTextNode(`${r.done}/${r.total}`),
    ]));
    d.appendChild(el("summary", {}, [
      el("div", {}, [
        el("div", { class: "app-title", text: p.programme }),
        el("div", { class: "app-meta", text: p.university + (p.theme ? ", " + p.theme : "") }),
      ]),
      el("div", { class: "role-chips", style: "margin:0" }, chips),
    ]));

    const body = el("div", { class: "app-body" });

    const sel = el("select", { "aria-label": "Status", style: "width:auto" });
    for (const k of PH.STATUSES) sel.appendChild(el("option", { value: k, text: k }));
    sel.value = p.status;
    sel.addEventListener("change", () => { PH.setStatus(p, sel.value); savePhd(); renderPhd(); });
    const top = el("div", { class: "row", style: "margin:0;align-items:center" }, [sel]);
    if (p.url) top.appendChild(el("a", { href: p.url, target: "_blank", rel: "noopener", class: "btn", text: "Open programme page" }));
    top.appendChild(el("span", { class: "small", text: `Added ${p.createdAt.slice(0, 10)}${p.submittedAt ? ", submitted " + p.submittedAt.slice(0, 10) : ""}` }));
    body.appendChild(top);

    const field = (label, value, type, apply) => {
      const input = el("input", { type: type || "text", "aria-label": label });
      input.value = value || "";
      input.addEventListener("change", () => { apply(input.value); touch(); renderPhd(); });
      return el("div", {}, [el("label", { text: label }), input]);
    };
    const fundSel = el("select", { "aria-label": "Funding" });
    for (const f of PH.FUNDING) fundSel.appendChild(el("option", { value: f, text: f }));
    fundSel.value = p.funding;
    fundSel.addEventListener("change", () => { p.funding = fundSel.value; touch(); });
    body.appendChild(el("div", { class: "form-grid" }, [
      field("Deadline", p.deadline, "date", (v) => { p.deadline = /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : ""; }),
      el("div", {}, [el("label", { text: "Funding" }), fundSel]),
      field("Supervisor", p.supervisor, "text", (v) => { p.supervisor = v.trim(); }),
      field("Supervisor email", p.supervisorEmail, "text", (v) => { p.supervisorEmail = v.trim(); }),
      field("Research theme", p.theme, "text", (v) => { p.theme = v.trim(); }),
      field("Programme page", p.url, "text", (v) => { p.url = v.trim(); }),
    ]));

    const checks = el("div", {}, [el("h4", { text: `Before you submit (${r.done} of ${r.total} done)` })]);
    const grid = el("div", { class: "check-grid" });
    for (const c of PH.CHECKLIST) {
      const cb = el("input", { type: "checkbox", id: `ck-${p.id}-${c.key}` });
      cb.checked = !!p.checklist[c.key];
      cb.addEventListener("change", () => { PH.setCheck(p, c.key, cb.checked); savePhd(); state.openPhd.add(p.id); renderPhd(); });
      grid.appendChild(el("label", { for: cb.id }, [cb, document.createTextNode(c.label)]));
    }
    checks.appendChild(grid);
    body.appendChild(checks);

    // ---- the application pack
    const allBusy = state.busy.has(p.id + ":all");
    const pack = el("div", { class: "pack" }, [el("h4", { text: "Application pack" })]);
    pack.appendChild(el("p", { class: "small", text: "Prepare everything writes the personal statement, tailors your proposal to this programme, drafts the supervisor email and reviews the proposal. They are drafts from your CV and proposal: read and edit each before you use it." }));
    const allBtn = el("button", { class: "btn", text: allBusy ? "Preparing…" : "Prepare everything", onclick: () => phdPrepareAll(p) });
    if (allBusy) allBtn.setAttribute("disabled", "");
    pack.appendChild(el("div", { class: "row" }, [allBtn, el("button", { class: "btn", text: "Download this pack (.zip)", onclick: () => downloadOne(p) })]));
    body.appendChild(pack);

    const pl = PH.plan(p);
    const planBox = el("div", {}, [el("h4", { text: "Plan, counting back from the deadline" })]);
    if (!pl) planBox.appendChild(el("div", { class: "small", text: "Set a deadline above and the dated plan appears here." }));
    else {
      const ul = el("ul", { class: "plan" });
      for (const m of pl) {
        ul.appendChild(el("li", { class: m.done ? "done" : "" }, [
          el("span", { text: m.done ? "✓" : "" }), el("span", { text: m.date }), el("span", { text: m.label }),
          m.late && !m.done ? el("span", { class: "late-tag", text: "behind" }) : el("span"),
        ]));
      }
      planBox.appendChild(ul);
    }
    body.appendChild(planBox);

    if (p.requirements.length || p.advert) {
      const ad = el("details", {}, [el("summary", { class: "small", text: "The advert" })]);
      if (p.requirements.length) ad.appendChild(el("ul", { class: "found-list" }, p.requirements.map((r) => el("li", { text: r }))));
      if (p.advert) ad.appendChild(el("pre", { class: "draft-text", text: p.advert }));
      body.appendChild(ad);
    }

    const prop = el("textarea", { "aria-label": "Research proposal", placeholder: "Paste the research proposal you are sending to this programme, or attach it below. Your original is never changed by the tailoring." });
    prop.value = p.proposal || "";
    prop.addEventListener("change", () => { p.proposal = prop.value; touch(); });
    const propFile = el("input", { type: "file", accept: ".txt,.md,.pdf", "aria-label": "Load a proposal from a file" });
    propFile.addEventListener("change", async () => {
      const f = propFile.files[0];
      if (!f) return;
      try {
        const text = await fileToText(f);
        if (!text.trim()) throw new Error("No text could be read from that file (a scanned PDF has none).");
        p.proposal = text; touch(); state.openPhd.add(p.id); renderPhd();
      } catch (e) { setPhMessage(e.message || String(e)); }
    });
    const proposal = el("div", {}, [el("h4", { text: "Your research proposal" }), prop,
      el("div", { class: "row" }, [propFile, genButton(p, "review")]),
      el("div", { class: "note", text: "The review is a second reader, not a rewrite: how well the proposal fits this theme, what a selector would ask, what to change." })]);
    if (p.proposalReview) proposal.appendChild(el("pre", { class: "draft-text", text: p.proposalReview }));
    body.appendChild(proposal);

    body.appendChild(textBlock(p, "Proposal tailored to this programme", "tailoredProposal", "tailor"));
    body.appendChild(textBlock(p, "Personal statement", "statement", "statement"));

    const mail = el("div", {}, [el("h4", { text: "Email to the supervisor" })]);
    const mailRow = el("div", { class: "row" }, [genButton(p, "email")]);
    if (p.supervisorDraft) {
      mail.appendChild(el("pre", { class: "draft-text", text: p.supervisorDraft }));
      mailRow.appendChild(el("button", { class: "btn", text: "Copy", onclick: () => copyText(p.supervisorDraft) }));
      if (p.supervisorEmail) {
        const m = p.supervisorDraft.match(/^subject:\s*(.*)\n+([\s\S]*)$/i);
        const href = "mailto:" + encodeURIComponent(p.supervisorEmail) + "?subject=" + encodeURIComponent(m ? m[1] : "") + "&body=" + encodeURIComponent(m ? m[2] : p.supervisorDraft);
        mailRow.appendChild(el("a", { class: "btn", href, text: "Open in email app" }));
      }
    }
    mail.appendChild(mailRow);
    body.appendChild(mail);

    const refs = el("div", {}, [el("h4", { text: "Referee request emails" })]);
    const refGrid = el("div", { class: "form-grid" });
    for (let i = 0; i < 2; i++) {
      const inp = el("input", { type: "text", "aria-label": `Referee ${i + 1}`, placeholder: "e.g. Dr Jane Smith" });
      inp.value = (p.referees && p.referees[i]) || "";
      inp.addEventListener("change", () => { p.referees = p.referees || ["", ""]; p.referees[i] = inp.value.trim(); touch(); state.openPhd.add(p.id); renderPhd(); });
      refGrid.appendChild(el("div", {}, [el("label", { text: `Referee ${i + 1}` }), inp]));
    }
    refs.appendChild(refGrid);
    const named = (p.referees || []).filter((r) => (r || "").trim());
    for (const r of named) {
      const mailText = PH.refereeRequest(p, r, myName());
      refs.appendChild(el("details", {}, [el("summary", { class: "small", text: `Request to ${r}` }), el("pre", { class: "draft-text", text: mailText }),
        el("div", { class: "row" }, [el("button", { class: "btn", text: "Copy", onclick: () => copyText(mailText) })])]));
    }
    if (!named.length) refs.appendChild(el("div", { class: "note", text: "Enter your referees' names and a ready-to-send request appears for each. These are written from a fixed template, not by AI." }));
    body.appendChild(refs);

    const notes = el("textarea", { "aria-label": "Notes", placeholder: "Replies, calls, portal login hints, what the supervisor said." });
    notes.value = p.notes || "";
    notes.addEventListener("change", () => { p.notes = notes.value; touch(); });
    body.appendChild(el("div", {}, [el("h4", { text: "Notes" }), notes]));

    const docs = el("div", {}, [el("h4", { text: "Documents for this application" })]);
    for (const doc of p.docs) {
      docs.appendChild(el("div", { class: "doc-row" }, [
        el("span", { text: doc.name }),
        el("span", { class: "pill", text: doc.kind.replace("_", " ") }),
        el("button", { class: "btn", onclick: () => viewTextModal(doc.name, doc.text), text: "View" }),
        el("button", { class: "btn", onclick: () => { p.docs = p.docs.filter((x) => x.id !== doc.id); touch(); renderPhd(); }, text: "Remove" }),
      ]));
    }
    const kind = el("select", { "aria-label": "Document type", style: "width:auto" }, [
      el("option", { value: "transcript", text: "Transcript" }), el("option", { value: "reference", text: "Reference" }),
      el("option", { value: "statement", text: "Personal statement" }), el("option", { value: "cv", text: "CV" }), el("option", { value: "other", text: "Other" }),
    ]);
    const attach = el("input", { type: "file", accept: ".txt,.md,.pdf", "aria-label": "Attach a document" });
    attach.addEventListener("change", async () => {
      const f = attach.files[0];
      if (!f) return;
      try {
        const text = await fileToText(f);
        if (!text.trim()) throw new Error("No text could be read from that file (a scanned PDF has none).");
        PH.addDoc(p, { name: f.name, kind: kind.value, text });
        savePhd(); state.openPhd.add(p.id); renderPhd();
      } catch (e) { setPhMessage(e.message || String(e)); }
    });
    docs.appendChild(el("div", { class: "row" }, [kind, attach]));
    docs.appendChild(el("div", { class: "note", text: "The text of the file is stored in this browser. The original file is not kept, so keep your own copy." }));
    body.appendChild(docs);

    body.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", onclick: () => {
      if (!window.confirm(`Delete ${p.programme} at ${p.university} and everything saved with it?`)) return;
      state.phd = state.phd.filter((x) => x !== p);
      savePhd(); renderPhd();
    }, text: "Delete this programme" })]));

    d.appendChild(body);
    return d;
  }

  function renderPhd() {
    renderPhdDashboard();
    const list = document.getElementById("ph-list");
    list.innerHTML = "";
    const q = state.phSearch.trim().toLowerCase();
    // Soonest deadline first among the open ones, then the rest by last change.
    const open = (p) => ["submitted", "interview", "offer", "rejected", "withdrawn"].indexOf(p.status) < 0;
    const rows = state.phd.filter((p) =>
      (state.phFilter === "all" || p.status === state.phFilter)
      && (!q || (p.university + " " + p.programme + " " + p.theme + " " + p.supervisor).toLowerCase().includes(q)))
      .sort((a, b) => (open(b) - open(a))
        || (open(a) ? (a.deadline || "9999").localeCompare(b.deadline || "9999") : (b.updatedAt || "").localeCompare(a.updatedAt || "")));
    for (const p of rows) list.appendChild(renderPhdRow(p));
    if (state.phd.length && !rows.length) list.appendChild(el("div", { class: "empty", text: "No programme matches that search or status." }));
  }

  function wirePhd() {
    document.getElementById("ph-advert-read").addEventListener("click", readAdvert);
    document.getElementById("ph-advert-clear").addEventListener("click", () => {
      document.getElementById("ph-advert-text").value = "";
      const o = document.getElementById("ph-advert-result"); o.hidden = true; o.innerHTML = "";
    });
    const nameBox = document.getElementById("ph-myname");
    nameBox.value = myName();
    nameBox.addEventListener("change", () => { lsSet(LS.myName, nameBox.value.trim()); renderPhd(); });
    document.getElementById("ph-search").addEventListener("input", (e) => { state.phSearch = e.target.value; renderPhd(); });
    document.getElementById("ph-filter").addEventListener("change", (e) => { state.phFilter = e.target.value; renderPhd(); });
    document.getElementById("ph-zip").addEventListener("click", () => downloadZip(setPhMessage));
    document.getElementById("ph-export").addEventListener("click", () => {
      downloadBlob(new Blob([PH.exportJson(state.phd)], { type: "application/json" }), "phd-applications-backup.json");
      setPhMessage("Backup downloaded. Import it on any browser to continue where you left off.");
    });
    document.getElementById("ph-import").addEventListener("change", async (e) => {
      const file = e.target.files[0]; e.target.value = "";
      if (!file) return;
      try {
        const r = PH.mergeImport(state.phd, PH.parseImport(await file.text()));
        savePhd(); renderPhd();
        setPhMessage(`Imported: ${r.added} new, ${r.updated} updated.`);
      } catch (err) { setPhMessage(err.message || String(err)); }
    });
    document.getElementById("ph-save").addEventListener("click", () => {
      const v = (id) => document.getElementById(id).value;
      if (!v("ph-university").trim()) { setPhMessage("Add the university's name first."); return; }
      const p = PH.newPhd({
        university: v("ph-university"), programme: v("ph-programme"), theme: v("ph-theme"),
        supervisor: v("ph-supervisor"), supervisorEmail: v("ph-semail"), funding: v("ph-funding"),
        deadline: v("ph-deadline"), url: v("ph-url"),
      });
      state.phd.push(p);
      if (savePhd()) {
        for (const id of ["ph-university", "ph-programme", "ph-theme", "ph-supervisor", "ph-semail", "ph-deadline", "ph-url"]) document.getElementById(id).value = "";
        document.getElementById("ph-funding").value = "unknown";
        document.getElementById("ph-add").open = false;
        state.openPhd.add(p.id);
        setPhMessage(`Added ${p.programme} at ${p.university}. Tick things off in its checklist as you get them ready.`);
      }
      renderPhd();
    });
  }

  // ------------------------------------------------------------- setup
  function wireControls() {
    const cvBox = document.getElementById("cv-text");
    cvBox.value = state.cvText;
    document.getElementById("cv-save").addEventListener("click", () => {
      state.cvText = cvBox.value;
      lsSet(LS.cv, state.cvText);
      evaluateAll();
      refreshAppScores();
      render();
      if (state.tab === "apps") renderApps();
    });
    document.getElementById("cv-clear").addEventListener("click", () => {
      cvBox.value = "";
      state.cvText = "";
      lsSet(LS.cv, "");
      evaluateAll();
      refreshAppScores();
      render();
      if (state.tab === "apps") renderApps();
    });
    document.getElementById("cv-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      cvBox.value = await fileToText(file);
      // Uploading used to only fill the box; the CV did nothing until you
      // also found and clicked Save, so scores never appeared.
      document.getElementById("cv-save").click();
    });

    const keyInput = document.getElementById("gemini-key");
    keyInput.value = lsGet(LS.geminiKey, "");
    document.getElementById("gemini-key-save").addEventListener("click", () => {
      lsSet(LS.geminiKey, keyInput.value.trim());
    });

    document.getElementById("search").addEventListener("input", (e) => {
      state.filters.search = e.target.value; render();
    });
    document.getElementById("min-score").addEventListener("input", (e) => {
      state.filters.minScore = Number(e.target.value) || 0;
      document.getElementById("min-score-label").textContent = state.filters.minScore;
      render();
    });
    document.getElementById("status-filter").addEventListener("change", (e) => {
      state.filters.status = e.target.value; render();
    });
    document.getElementById("sort-by").addEventListener("change", (e) => {
      state.sortBy = e.target.value; render();
    });
    for (const b of document.querySelectorAll("#tabs [data-tab]")) {
      b.addEventListener("click", () => showTab(b.dataset.tab));
    }
    document.getElementById("ps-score").addEventListener("click", runPasteScore);
    document.getElementById("ps-clear").addEventListener("click", () => {
      for (const id of ["ps-title", "ps-company", "ps-location", "ps-url", "ps-desc"]) document.getElementById(id).value = "";
      state.pasteRec = null;
      const out = document.getElementById("ps-result"); out.hidden = true; out.innerHTML = "";
    });
    document.getElementById("ap-search").addEventListener("input", (e) => { state.apSearch = e.target.value; renderApps(); });
    document.getElementById("ap-filter").addEventListener("change", (e) => { state.apFilter = e.target.value; renderApps(); });
    document.getElementById("ap-zip").addEventListener("click", () => downloadZip(setApMessage));
    document.getElementById("ap-export").addEventListener("click", () => {
      downloadBlob(new Blob([A.exportJson(state.apps)], { type: "application/json" }), "job-applications-backup.json");
      setApMessage("Backup downloaded. Import it on any browser to continue where you left off.");
    });
    document.getElementById("ap-import").addEventListener("change", (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ""; });
    const folderBtn = document.getElementById("ap-folder");
    if (typeof window.showDirectoryPicker === "function") { folderBtn.hidden = false; folderBtn.addEventListener("click", saveToFolder); }
    wirePhd();
    document.getElementById("modal-close").addEventListener("click", closeModal);
    document.getElementById("modal").addEventListener("click", (e) => {
      if (e.target.id === "modal") closeModal();
    });
  }

  // Another tab changed the library or the marked-applied list: take its
  // version, so this tab's next save builds on it instead of replacing it.
  window.addEventListener("storage", (e) => {
    if (e.key !== LS.apps && e.key !== LS.status && e.key !== LS.phd) return;
    state.apps = lsGet(LS.apps, []);
    state.phd = PH.normalizeAll(lsGet(LS.phd, []));
    state.statusByUid = lsGet(LS.status, {});
    render();
    if (state.tab === "apps") renderApps();
    if (state.tab === "phd") renderPhd();
  });

  document.addEventListener("DOMContentLoaded", () => {
    wireControls();
    loadData();
  });
})();
