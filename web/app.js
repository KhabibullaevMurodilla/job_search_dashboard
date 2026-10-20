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

  const LS = {
    cv: "jr_cv_text",
    cvMeta: "jr_cv_meta",
    geminiKey: "jr_gemini_key",
    status: "jr_role_status",     // {uid: "applied"|"skipped"}
    apps: "jr_applications",      // [application records, see lib/applications.js]
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
      const m = document.getElementById("ap-message");
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
    for (const t of ["roles", "score", "apps"]) {
      document.getElementById("view-" + t).hidden = t !== name;
    }
    document.getElementById("panel-filters").hidden = name !== "roles";
    if (name === "apps") renderApps();
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

  function allFiles() {
    const files = [];
    for (const a of state.apps) files.push(...A.folderPlan(a).files);
    return files;
  }

  function downloadZip() {
    if (!state.apps.length) { setApMessage("Nothing to download yet."); return; }
    const files = allFiles();
    downloadBlob(new Blob([self.Zip.build(files)], { type: "application/zip" }), "job-applications.zip");
    setApMessage(`Downloaded ${files.length} files, one folder per company and role.`);
  }

  async function saveToFolder() {
    if (!state.apps.length) { setApMessage("Nothing to save yet."); return; }
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
    document.getElementById("ap-zip").addEventListener("click", downloadZip);
    document.getElementById("ap-export").addEventListener("click", () => {
      downloadBlob(new Blob([A.exportJson(state.apps)], { type: "application/json" }), "job-applications-backup.json");
      setApMessage("Backup downloaded. Import it on any browser to continue where you left off.");
    });
    document.getElementById("ap-import").addEventListener("change", (e) => { if (e.target.files[0]) importBackup(e.target.files[0]); e.target.value = ""; });
    const folderBtn = document.getElementById("ap-folder");
    if (typeof window.showDirectoryPicker === "function") { folderBtn.hidden = false; folderBtn.addEventListener("click", saveToFolder); }
    document.getElementById("modal-close").addEventListener("click", closeModal);
    document.getElementById("modal").addEventListener("click", (e) => {
      if (e.target.id === "modal") closeModal();
    });
  }

  // Another tab changed the library or the marked-applied list: take its
  // version, so this tab's next save builds on it instead of replacing it.
  window.addEventListener("storage", (e) => {
    if (e.key !== LS.apps && e.key !== LS.status) return;
    state.apps = lsGet(LS.apps, []);
    state.statusByUid = lsGet(LS.status, {});
    render();
    if (state.tab === "apps") renderApps();
  });

  document.addEventListener("DOMContentLoaded", () => {
    wireControls();
    loadData();
  });
})();
