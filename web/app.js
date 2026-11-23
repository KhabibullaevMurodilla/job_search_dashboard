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
  const PR = self.Proposal;
  const AN = self.Answers;

  const LS = {
    cv: "jr_cv_text",
    cvMeta: "jr_cv_meta",
    geminiKey: "jr_gemini_key",
    status: "jr_role_status",     // {uid: "applied"|"skipped"}
    apps: "jr_applications",      // [application records, see lib/applications.js]
    research: "jr_research",       // array: digests of the applicant's own theses and reports
    lang: "jr_lang",               // object: language courses, XP, streak, badges
    letterStyle: "jr_letter_style", // "classic" | "balanced" | "direction"
    profile: "jr_profile",        // object: direction and character answers, in their own words
    style: "jr_style_samples",    // string: the applicant's own writing, to match their voice
    oaKey: "jr_openalex_key",     // string: optional free OpenAlex key
    myName: "jr_my_name",         // string, used to sign emails and statements
    phd: "jr_phd",                // [PhD application records, see lib/phd.js]
    train: "jr_training",         // practice progress: topic scores, sessions, readiness maps
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
    styleText: lsGet(LS.style, ""),
    profile: self.Profile ? self.Profile.normalize(lsGet(LS.profile, {})) : null,
    research: self.Research ? self.Research.normalizeWorks(lsGet(LS.research, [])) : [],
    lang: self.Lang ? self.Lang.normalizeState(lsGet(LS.lang, {})) : null,
    train: (self.Training ? self.Training.normalizeStats(lsGet(LS.train, {})) : { topics: {}, sessions: [], readiness: {} }),
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
    // The applicant's own written account (Your writing and background) is a
    // second source of facts for the letter, alongside the CV.
    const story = (state.styleText || "").trim();
    const hasStory = story.split(/\s+/).length >= 150;
    let prompt = DC.buildCoverLetterPrompt(app, state.cvText);
    if (hasStory) {
      prompt += `

--- the candidate's own written account of their background ---
${story.slice(0, 40000)}

ABOUT THAT ACCOUNT. It is a second record of what the candidate has done, in
their own words. Use it to choose which parts of the candidate's history matter
most for THIS role and to give the letter their real motivation and way of
working. Weight things in proportion: lead with what this role needs, give minor
things a clause, leave out the rest. Facts and numbers may come from the CV or
this account and from nowhere else. Where the account shows a gap against the
posting, do not hide it or invent a fix: either leave it unmentioned or name it
briefly with what the candidate does about it. No six-word sequence may be
copied from the account either. Write in a professional register.`;
    }
    const PFL = self.Profile;
    const pf = PFL && state.profile ? state.profile : null;
    const brief = PFL && pf ? PFL.coverBrief(pf, app.companyNotes, letterStyle()) : "";
    if (brief) prompt += brief;
    const rbl = researchBlock();
    if (rbl) prompt += "\n\n--- the candidate's own research (digest of their theses) ---\n" + rbl + "\n" + RS.rules() + " Mention it only if the role involves research, analysis or modelling, or it clearly supports the role, and then in a clause or two.";
    const draft = await callGemini(prompt);
    const q = DC.qualityCheckCoverLetter(draft, state.cvText);
    const own = brief && letterStyle() !== "classic" ? PFL.corpus(pf) : "";
    if (brief && own) {
      const copiedOwn = DC.sharedNgram(draft, own, 6);
      if (copiedOwn) { q.problems.push(`shares "${copiedOwn}" with your own answers word-for-word`); q.ok = false; }
    }
    if (hasStory) {
      const copied = DC.sharedNgram(draft, story, 6);
      if (copied) { q.problems.push(`shares "${copied}" with your written account word-for-word`); q.ok = false; }
    }
    if (hasStory || brief || rbl) {
      const nums = PR.numberCheck(draft, state.cvText + "\n" + story + "\n" + own + "\n" + (app.companyNotes || "") + "\n" + (app.description || "") + "\n" + researchCorpus());
      if (nums.length) { q.problems.push(`these figures are not in your CV, your account, your answers or the posting, so check them: ${nums.join(", ")}`); q.ok = false; }
    }
    app.coverLetter = draft;
    app.updatedAt = new Date().toISOString();
    saveApps();
    return { draft, quality: q };
  }

  // ---------------------------------------------------------------- UI
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
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
  // How far the cover letter follows the About me answers. Shared by every letter.
  function letterStyle() { const v = lsGet(LS.letterStyle, "balanced"); return self.Profile && self.Profile.LETTER_STYLES.some((x) => x.id === v) ? v : "balanced"; }
  function setLetterStyle(v) { lsSet(LS.letterStyle, v); const pf = document.getElementById("pf-letter-style"); if (pf && pf.value !== v) pf.value = v; syncLetterHint(); }
  function syncLetterHint() { const h = document.getElementById("pf-letter-hint"); if (h && self.Profile) { const s = self.Profile.LETTER_STYLES.find((x) => x.id === letterStyle()); h.textContent = s ? s.hint : ""; } }

  function letterActions(app) {
    const actions = el("div", { class: "modal-actions" });
    actions.appendChild(el("button", { class: "btn", onclick: () => copyText(app.coverLetter), text: "Copy" }));
    actions.appendChild(el("button", { class: "btn", onclick: () => downloadText(app.coverLetter, `cover-letter-${A.slug(app.company)}-${A.slug(app.title)}.md`), text: "Download .md" }));
    if (self.Profile) {
      const sel = el("select", { id: "letter-style-modal", "aria-label": "Letter style for the next redraft" }, self.Profile.LETTER_STYLES.map((x) => el("option", { value: x.id, text: x.label })));
      sel.value = letterStyle(); sel.addEventListener("change", () => setLetterStyle(sel.value));
      actions.appendChild(el("label", { for: "letter-style-modal", class: "small", text: "Style for redraft:" }));
      actions.appendChild(sel);
    }
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
    for (const t of ["roles", "score", "apps", "phd", "train", "docs", "lang"]) {
      document.getElementById("view-" + t).hidden = t !== name;
    }
    document.getElementById("panel-filters").hidden = name !== "roles";
    if (name === "apps") renderApps();
    if (name === "phd") renderPhd();
    if (name === "docs") renderDocs();
    if (name === "train") renderTrain();
    if (name === "lang") renderLang();
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

    const olChip = el("span", { class: "chip" });
    const renderChip = () => { const r = outlookFor("job", app); olChip.textContent = "Outlook: " + (r && r.ok ? r.bandLabel : "?"); };
    renderChip();
    d.appendChild(el("summary", {}, [
      el("div", {}, [
        el("div", { class: "app-title", text: app.title }),
        el("div", { class: "app-meta", text: `${app.company}${app.location ? ", " + app.location : ""}${app.source === "pasted" ? " (pasted)" : ""}` }),
      ]),
      el("div", { class: "role-chips", style: "margin:0" }, [
        el("span", { class: `pill st-${app.status}`, text: app.status }),
        el("span", { class: `chip ${tierClass(app.fitPct)}`, text: `CV fit ${app.fitPct == null ? "?" : app.fitPct + "%"}` }),
        olChip,
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

    const olSlot = el("div", {});
    const drawOutlook = () => { olSlot.textContent = ""; olSlot.appendChild(outlookPanel("job", app, () => { drawOutlook(); renderChip(); })); };
    drawOutlook();
    body.appendChild(olSlot);

    const cn = el("textarea", { "aria-label": "What you know about this company", placeholder: "Paste what you know: their About page, mission, recent news, a product launch, something a person there said. The cover letter and answers may use this and the posting, and nothing else, so it can be specific without guessing." });
    cn.value = app.companyNotes || "";
    cn.addEventListener("change", () => { app.companyNotes = cn.value.slice(0, 8000); app.updatedAt = new Date().toISOString(); saveApps(); });
    body.appendChild(el("div", {}, [el("h4", { text: "What you know about this company" }), cn]));

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

  // ---------------------------------------------------------------- application questions
  function aqFill() {
    const sel = document.getElementById("aq-role");
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = "";
    sel.appendChild(el("option", { value: "", text: "Not saved: I will paste the posting" }));
    for (const a of state.apps) sel.appendChild(el("option", { value: a.id, text: `${a.title} at ${a.company}` }));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    document.getElementById("aq-free").hidden = !!sel.value;
  }

  async function aqWrite() {
    const msg = document.getElementById("aq-msg"), out = document.getElementById("aq-out");
    const sel = document.getElementById("aq-role");
    const question = document.getElementById("aq-question").value.trim();
    out.textContent = "";
    try {
      if (!AN) throw new Error("This tool needs web/lib/answers.js. Add it next to the other files in web/lib/, push, and refresh.");
      if (!state.cvText.trim()) throw new Error("Upload or paste your CV first (left panel). The answer is written from it.");
      if (!question) throw new Error("Paste the question first.");
      const app = state.apps.find((a) => a.id === sel.value) || null;
      const posting = app ? (app.description || "") : document.getElementById("aq-posting").value.trim();
      const story = (state.styleText || "").trim().split(/\s+/).length >= 150 ? state.styleText.trim() : "";
      const st = myStyle();
      const o = {
        question, limit: parseInt(document.getElementById("aq-limit").value, 10) || 0,
        title: app ? app.title : "", company: app ? app.company : document.getElementById("aq-company").value.trim(),
        posting, cv: state.cvText, story, styleText: st ? PR.describeStyle(st) : "",
        profile: self.Profile && state.profile && self.Profile.hasAny(state.profile) ? [self.Profile.block(state.profile), self.Profile.traitsBlock(state.profile)].filter(Boolean).join("\n\n") : "",
        companyNotes: app ? (app.companyNotes || "") : "",
        research: researchBlock(),
      };
      msg.textContent = "Writing from your CV" + (story ? " and your background" : "") + "…";
      const raw = await callGemini(AN.buildAnswerPrompt(o));
      const { answer, note } = AN.splitNote(raw);
      const q = AN.checkAnswer(answer, o);
      msg.textContent = q.ok ? `Done: ${q.words} words (limit ${q.limit}). Read it once, and change anything that is not how you would say it.` : `Written (${q.words} words, limit ${q.limit}), but check: ${q.problems.join("; ")}.`;
      out.appendChild(el("pre", { class: "draft-text", text: answer }));
      if (note) out.appendChild(el("div", { class: "quality-warn", text: "Add to your background: " + note }));
      if (!story) out.appendChild(el("div", { class: "small", text: "No written background is loaded, so this used your CV only. Load it in the PhD tab, under Your writing and background, for richer answers." }));
      const row = el("div", { class: "row" }, [el("button", { class: "btn", text: "Copy", onclick: () => { copyText(answer); msg.textContent = "Copied."; } })]);
      if (app) row.appendChild(el("button", { class: "btn", text: "Save to this role's notes", onclick: () => {
        app.notes = (app.notes ? app.notes + "\n\n" : "") + `Q: ${question}\nA: ${answer}`; app.updatedAt = new Date().toISOString(); saveApps(); msg.textContent = "Saved to the role's notes.";
      } }));
      out.appendChild(row);
    } catch (e) { msg.textContent = e.message || String(e); }
  }

  function renderApps() {
    aqFill();
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
      statement: () => {
        const st = myStyle();
        const rb = researchBlock({ passages: true });
        const ex = st ? { story: state.styleText, styleText: PR.describeStyle(st), excerpts: PR.styleExcerpts(state.styleText, 3, 130) } : {};
        if (rb) ex.research = rb;
        return PH.buildStatementPrompt(p, state.cvText, myName(), st || rb ? ex : null);
      },
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
      const nums = PR.numberCheck(text, [state.cvText, state.styleText, p.proposal, p.advert, researchCorpus()].join("\n"));
      if (nums.length) q.problems.push(`These figures are not in your CV or your own account, so check them: ${nums.join(", ")}.`);
      note = q.problems.length ? "Personal statement drafted, but check: " + q.problems.join(" ") : `Personal statement drafted (${q.words} words).`;
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


  // ------------------------------------------- your writing + the proposal
  let styleCache = { text: null, prof: null };
  function styleProf() {
    if (styleCache.text !== state.styleText) styleCache = { text: state.styleText, prof: PR.styleProfile(state.styleText) };
    return styleCache.prof;
  }
  function myStyle() { const p = styleProf(); return p.words >= PR.MIN_STYLE_WORDS ? p : null; }

  function renderStyleStats() {
    const box = document.getElementById("ph-style-stats");
    const pf = styleProf();
    if (!state.styleText.trim()) { box.textContent = "Nothing saved yet."; return; }
    if (pf.words < PR.MIN_STYLE_WORDS) { box.textContent = `${pf.words} words saved. Add at least ${PR.MIN_STYLE_WORDS - pf.words} more so there is enough to read a style from.`; return; }
    box.textContent = `${pf.words} words saved. You write sentences of about ${pf.avgSentence} words (spread ${pf.sdSentence}), ${pf.spelling === "UK" ? "British" : pf.spelling === "US" ? "American" : "mixed or unclear"} spelling, and start most often with "${(pf.openers[0] || {}).word || "-"}".`;
  }

  async function fetchJson(url) {
    let res;
    try { res = await fetch(url); } catch (e) { const err = new Error("could not connect"); err.network = true; throw err; }
    if (!res.ok) { const err = new Error("HTTP " + res.status); err.status = res.status; throw err; }
    return res.json();
  }
  const OA_SELECT = "id,doi,title,display_name,publication_year,type,cited_by_count,authorships,primary_location,biblio,abstract_inverted_index,best_oa_location,open_access";
  function oaUrl(path, params) {
    const q = Object.entries(params || {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    const key = (lsGet(LS.oaKey, "") || "").trim();
    if (key) q.push("api_key=" + encodeURIComponent(key));
    return `https://api.openalex.org/${path}${q.length ? "?" + q.join("&") : ""}`;
  }
  const CR_SELECT = "DOI,title,author,issued,container-title,volume,issue,page,abstract,is-referenced-by-count,type";

  async function searchLiterature(queries) {
    const lists = []; let oaFailed = 0, crUsed = 0; let lastErr = null;
    for (const q of queries) {
      try {
        const j = await fetchJson(oaUrl("works", { search: q, per_page: 10, filter: "from_publication_date:2012-01-01", select: OA_SELECT }));
        lists.push((j.results || []).map(PR.fromOpenAlex).filter(Boolean));
      } catch (e) {
        oaFailed++; lastErr = e;
        try {
          const j = await fetchJson(`https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(q)}&rows=10&filter=from-pub-date:2012,type:journal-article&select=${CR_SELECT}`);
          lists.push(((j.message && j.message.items) || []).map(PR.fromCrossref).filter(Boolean)); crUsed++;
        } catch (e2) { lists.push([]); lastErr = e2; }
      }
    }
    const merged = PR.mergeSources(lists, 16);
    if (!merged.length) {
      throw new Error("Could not get any papers from OpenAlex or Crossref. "
        + (lastErr && lastErr.status === 429 || lastErr && lastErr.status === 403 ? "The free search allowance may be used up for today: a free OpenAlex key (in Your writing) raises it. " : lastErr && lastErr.network ? "This page could not connect: check your network or ad blocker. " : "")
        + "You can still add papers one by one by DOI below.");
    }
    return { sources: merged, via: oaFailed === 0 ? "OpenAlex" : crUsed && oaFailed < queries.length ? "OpenAlex and Crossref" : "Crossref (OpenAlex did not answer)" };
  }

  async function lookupDoi(raw) {
    const doi = PR.cleanDoi(raw);
    if (!doi) throw new Error("That does not look like a DOI. A DOI starts with 10. followed by numbers, a slash and a code.");
    try {
      const j = await fetchJson(oaUrl("works/https://doi.org/" + doi, { select: OA_SELECT }));
      const s = PR.fromOpenAlex(j); if (s) return s;
    } catch (e) { /* fall through to Crossref */ }
    try {
      const j = await fetchJson("https://api.crossref.org/works/" + encodeURIComponent(doi));
      const s = PR.fromCrossref(j.message); if (s) return s;
    } catch (e) { /* fall through */ }
    throw new Error("Could not find that DOI in OpenAlex or Crossref.");
  }

  function nextSourceId(p) { return "S" + (1 + Math.max(0, ...p.sources.map((x) => parseInt(String(x.id).slice(1), 10) || 0))); }
  function addSources(p, list) {
    let added = 0;
    const keyOf = (x) => (x.doi ? x.doi.toLowerCase() : x.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
    const have = new Set(p.sources.map(keyOf));
    for (const s of list) {
      const k = keyOf(s);
      if (have.has(k)) continue;
      have.add(k);
      p.sources.push(Object.assign({}, s, { id: nextSourceId(p), abstract: (s.abstract || "").slice(0, 1500), use: (s.abstract || "").length >= 150 }));
      added++;
    }
    return added;
  }

  async function findSources(p) {
    const key = p.id + ":sources";
    if (state.busy.has(key)) return;
    state.busy.add(key); renderPhd();
    try {
      const prob = PR.briefProblem(p.brief, p.proposal);
      if (prob) throw new Error(prob);
      setPhMessage("Choosing search terms with Gemini…");
      const queries = PR.parseQueries(await callGemini(PR.buildQueryPrompt(p, p.brief || p.proposal)));
      setPhMessage(`Searching for papers: ${queries.join("; ")}…`);
      const r = await searchLiterature(queries);
      const added = addSources(p, r.sources);
      p.updatedAt = new Date().toISOString(); savePhd();
      setPhMessage(`Found ${r.sources.length} papers on ${r.via}; ${added} new. Papers with an abstract are ticked. Untick any you do not want, and add others by DOI.`);
    } catch (e) { setPhMessage(e.message || String(e)); }
    finally { state.busy.delete(key); state.openPhd.add(p.id); renderPhd(); }
  }

  async function addByDoi(p, raw) {
    try {
      setPhMessage("Looking that DOI up…");
      const s = await lookupDoi(raw);
      const n = addSources(p, [s]);
      p.updatedAt = new Date().toISOString(); savePhd();
      setPhMessage(n ? `Added: ${PR.authorYear(s).who} (${s.year}) ${s.title}` : "That paper is already in the list.");
    } catch (e) { setPhMessage(e.message || String(e)); }
    state.openPhd.add(p.id); renderPhd();
  }

  async function suggestDirections(p) {
    const key = p.id + ":dir";
    if (state.busy.has(key)) return;
    state.busy.add(key); renderPhd();
    try {
      if (!myStyle()) throw new Error(`Load your own written account first (the "Your writing and background" box above, at least ${PR.MIN_STYLE_WORDS} words). The directions are drawn from what you have actually done, so they need it.`);
      setPhMessage("Reading your account and this advert for research directions…");
      const text = await callGemini(PR.buildDirectionsPrompt({ programme: p, story: state.styleText, cv: state.cvText, base: p.proposal, research: researchBlock() }));
      const dirs = PR.parseDirections(text, [state.styleText, state.cvText, p.proposal, researchBlock()].join("\n"));
      p.directions = dirs; p.updatedAt = new Date().toISOString(); savePhd();
      const dropped = dirs.reduce((n, d) => n + d.unverified, 0);
      setPhMessage(`${dirs.length} direction${dirs.length === 1 ? "" : "s"} suggested. Each quote shown is copied from your own text${dropped ? ` (${dropped} quote${dropped === 1 ? "" : "s"} the AI offered could not be found in your text and were removed)` : ""}. Pick one to build the proposal from.`);
    } catch (e) { setPhMessage(e.message || String(e)); }
    finally { state.busy.delete(key); state.openPhd.add(p.id); renderPhd(); }
  }

  function directionCards(p) {
    const wrap = el("div", {});
    p.directions.forEach((d, i) => {
      const chosen = p.chosenDirection === d.title;
      const card = el("div", { class: "dir" }, [
        el("h5", { text: `${i + 1}. ${d.title}${chosen ? " (chosen)" : ""}` }),
        el("div", { text: d.question, style: "font-weight:700;font-size:13px" }),
        el("div", { class: "small", text: d.approach }),
      ]);
      if (d.fit) card.appendChild(el("div", { class: "small", text: "Fit: " + d.fit }));
      if (d.quotes.length) {
        card.appendChild(el("div", { class: "small", text: "Why you, in your own words (each quote checked against your text):" }));
        for (const q of d.quotes) card.appendChild(el("blockquote", { text: q }));
      }
      if (d.weak) card.appendChild(el("div", { class: "weak", text: "None of the evidence the AI offered could be found in your text. Treat this as a bare suggestion, not something your background supports." }));
      if (d.gaps.length) card.appendChild(el("div", { class: "small", text: "Still to learn or not yet done: " + d.gaps.join("; ") }));
      card.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", text: chosen ? "Use again" : "Use this direction", onclick: () => {
        if ((p.brief || "").trim() && p.chosenDirection !== d.title && !window.confirm("Replace the notes in Your ideas with this direction?")) return;
        p.brief = PR.directionToBrief(d); p.chosenDirection = d.title; p.updatedAt = new Date().toISOString(); savePhd();
        state.openPhd.add(p.id); setPhMessage("Direction chosen. Your ideas now holds it: edit it if you like, then Find sources."); renderPhd();
      } })]));
      wrap.appendChild(card);
    });
    return wrap;
  }

  // Full paper texts live in memory only (they are large). What is saved is
  // the set of passages chosen from them, which is what the proposal and the
  // checks use, so a refresh does not lose the work already done.
  const paperText = new Map();
  const paperKey = (p, s) => p.id + ":" + s.id;
  const projectQuery = (p) => [p.brief, p.theme, p.programme, (p.requirements || []).join(" ")].join(" ");

  async function attachPaper(p, s, file) {
    try {
      if (!file) return;
      if (!/\.pdf$/i.test(file.name)) throw new Error("Attach the paper as a PDF.");
      setPhMessage(`Reading ${file.name}…`);
      const raw = await extractPdfText(await file.arrayBuffer());
      const text = PR.cleanPaperText(raw);
      const words = text.split(/\s+/).filter(Boolean).length;
      if (words < 600) throw new Error(`Only ${words} words could be read from that file. It may be a scan or a short preview. Use a PDF with selectable text (try the open-access link, or the publisher's full PDF).`);
      paperText.set(paperKey(p, s), text);
      s.paperWords = words; s.paperName = file.name; s.use = true;
      s.passages = PR.pickPassages(text, projectQuery(p), 7000);
      p.updatedAt = new Date().toISOString(); savePhd();
      setPhMessage(`Read ${words.toLocaleString()} words of ${s.id}. ${s.passages.length.toLocaleString()} characters of the passages that matter for your project will be used.`);
    } catch (e) { setPhMessage(e.message || String(e)); }
    state.openPhd.add(p.id); renderPhd();
  }

  // Re-choose the passages against the notes as they are now.
  function refreshPassages(p) {
    for (const s of p.sources) { const t = paperText.get(paperKey(p, s)); if (t) s.passages = PR.pickPassages(t, projectQuery(p), 7000); }
  }

  function usedSources(p) { return p.sources.filter((x) => x.use).sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10)); }
  function targetFor(p) { return p.targetWords > 0 ? p.targetWords : PR.targetWords(p.advert); }

  async function writeProposal(p) {
    const key = p.id + ":write";
    if (state.busy.has(key)) return;
    state.busy.add(key); renderPhd();
    try {
      if (!state.cvText.trim()) throw new Error("Upload or paste your CV first (left panel).");
      const prob = PR.briefProblem(p.brief, p.proposal);
      if (prob) throw new Error(prob);
      const style = myStyle();
      if (!style) throw new Error(`Add your own writing first (the "Your writing" box above, at least ${PR.MIN_STYLE_WORDS} words). Without it the draft cannot be matched to your voice and would come out in a generic one.`);
      const sources = usedSources(p);
      refreshPassages(p);
      const withText = sources.filter((x) => (x.abstract || "").length >= 150 || x.notes || x.passages);
      if (withText.length < 4) throw new Error("Tick at least 4 sources that have an abstract (or the paper attached, or a passage you pasted). Everything in the proposal is written from those papers, and a paper with only a title gives nothing to write from. Find sources, or add papers by DOI.");
      const target = targetFor(p);
      const styleText = PR.describeStyle(style);
      const excerpts = PR.styleExcerpts(state.styleText, 3, 130);

      setPhMessage("Writing the proposal with Gemini (1 of up to 3 steps)…");
      const facts = [state.styleText, state.cvText, p.brief, p.proposal, p.advert, researchCorpus()].join("\n");
      let draft = await callGemini(PR.buildProposalPrompt({ programme: p, cv: state.cvText, brief: p.brief, base: p.proposal, sources, target, styleText, excerpts, story: state.styleText, research: researchBlock({ passages: true }) }));
      let report = PR.checkDraft(draft, sources, style, target, facts);
      let best = { draft, report }, passes = 0;
      while (best.report.problems.length && passes < 2) {
        passes++;
        setPhMessage(`Checking found ${best.report.problems.length} thing${best.report.problems.length === 1 ? "" : "s"} to fix. Revising (step ${passes + 1} of up to 3)…`);
        const revised = await callGemini(PR.buildRevisePrompt({ problems: best.report.problems, draft: best.draft, sources, styleText }));
        const rr = PR.checkDraft(revised, sources, style, target, facts);
        if (rr.score < best.report.score) best = { draft: revised, report: rr }; else break;
      }
      const f = PR.finalize(best.draft, sources, best.report);
      p.proposalFull = f.text; p.proposalNote = f.note;
      p.proposalReport = {
        words: best.report.words, target, passes, at: new Date().toISOString(),
        cited: best.report.cites.cited, remaining: best.report.problems, style: best.report.style.rows,
        evidence: (best.report.evidence && best.report.evidence.rows) || [],
      };
      p.updatedAt = new Date().toISOString(); savePhd();
      setPhMessage(best.report.problems.length
        ? `Proposal written, but ${best.report.problems.length} problem${best.report.problems.length === 1 ? " is" : "s are"} still flagged below. Fix ${best.report.problems.length === 1 ? "it" : "them"} by hand.`
        : "Proposal written and every check passed: the references exist, each factual sentence is cited or about you, and the wording matches you. The checks cannot tell whether a paper really says what it is cited for. Read each one.");
    } catch (e) { setPhMessage(e.message || String(e)); }
    finally { state.busy.delete(key); state.openPhd.add(p.id); renderPhd(); }
  }

  // The reference list marks journal titles with *asterisks*. This copies it as
  // formatted text so they arrive italic in Word, and plain if the browser will not.
  async function copyReferences(p) {
    const refs = (p.proposalFull.split(/\n\nReferences\n\n/)[1] || "").split(/\n\n/).map((x) => x.trim()).filter(Boolean);
    if (!refs.length) { setPhMessage("There is no reference list in the text."); return; }
    try {
      if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([new window.ClipboardItem({
          "text/html": new Blob([refs.map((r) => `<p>${PR.referenceHtml(r)}</p>`).join("")], { type: "text/html" }),
          "text/plain": new Blob([refs.map((r) => r.replace(/\*/g, "")).join("\n\n")], { type: "text/plain" }),
        })]);
        setPhMessage(`Copied ${refs.length} references with journal titles in italics.`);
      } else { copyText(refs.map((r) => r.replace(/\*/g, "")).join("\n\n")); setPhMessage("Copied the references as plain text: your browser cannot copy italics. Italicise the journal titles in Word."); }
    } catch (e) { setPhMessage("Could not copy: " + (e.message || e)); }
  }

  function recheckWording(p) {
    const r = PR.checkWording(p.proposalFull, myStyle(), targetFor(p), [state.styleText, state.cvText, p.brief, p.proposal, p.advert, ...p.sources.map((x) => PR.sourceText(x))].join("\n"));
    p.proposalReport = Object.assign({}, p.proposalReport || {}, { words: r.words, target: targetFor(p), remaining: r.problems, style: r.style.rows });
    savePhd();
    setPhMessage(r.problems.length ? `${r.problems.length} wording problem${r.problems.length === 1 ? "" : "s"} found.` : "Wording checks pass.");
    state.openPhd.add(p.id); renderPhd();
  }

  function proposalBuilder(p) {
    const wrap = el("div", { class: "pack" }, [el("h4", { text: "Write a full proposal" })]);
    wrap.appendChild(el("p", { class: "small", text: "Built from your own account, your CV, this advert, real papers found in OpenAlex, and the way you write. Everything about the field must come from the papers on the list below and carry a citation; sentences that do not are flagged. The reference list is made in Harvard style from the paper records, not typed by the AI." }));

    const dirBusy = state.busy.has(p.id + ":dir");
    const dirBtn = el("button", { class: "btn", text: dirBusy ? "Reading your account…" : (p.directions.length ? "Suggest directions again" : "Suggest research directions"), onclick: () => suggestDirections(p) });
    if (dirBusy) dirBtn.setAttribute("disabled", "");
    wrap.appendChild(el("div", { class: "row" }, [dirBtn]));
    wrap.appendChild(el("div", { class: "note", text: "Drawn from your own account of what you have done, weighed against this advert. You choose; nothing is invented about you, and every quote is checked against your text." }));
    if (p.directions.length) wrap.appendChild(directionCards(p));

    const brief = el("textarea", { "aria-label": "Your notes for the proposal", placeholder: "In your own words: what you want to investigate, what you have done that supports it, the method you have in mind, and anything you do not want included. Rough notes are fine, the more specific the better." });
    brief.value = p.brief || "";
    brief.addEventListener("change", () => { p.brief = brief.value; p.updatedAt = new Date().toISOString(); savePhd(); });
    wrap.appendChild(el("div", {}, [el("label", { text: "Your ideas (filled in when you choose a direction, or write your own)" }), brief]));

    const tgt = el("input", { type: "number", min: "300", max: "6000", step: "50", "aria-label": "Target length in words", style: "width:110px" });
    tgt.value = String(targetFor(p));
    tgt.addEventListener("change", () => { p.targetWords = Math.max(300, Math.min(6000, parseInt(tgt.value, 10) || 0)); savePhd(); renderPhd(); });
    wrap.appendChild(el("div", {}, [el("label", { text: "Length in words (read from the advert if it says; otherwise 1500)" }), tgt]));

    const finding = state.busy.has(p.id + ":sources");
    const findBtn = el("button", { class: "btn", text: finding ? "Searching…" : (p.sources.length ? "Find more sources" : "Find sources"), onclick: () => findSources(p) });
    if (finding) findBtn.setAttribute("disabled", "");
    const doi = el("input", { type: "text", placeholder: "add a paper by DOI, e.g. 10.1109/…", "aria-label": "Add a paper by DOI", style: "max-width:260px" });
    wrap.appendChild(el("div", { class: "row" }, [findBtn, doi, el("button", { class: "btn", text: "Add DOI", onclick: () => addByDoi(p, doi.value) })]));

    if (p.sources.length) {
      const ul = el("ul", { class: "src-list" });
      for (const s of p.sources) {
        const cb = el("input", { type: "checkbox", id: `src-${p.id}-${s.id}`, "aria-label": `Use ${s.title}` });
        cb.checked = !!s.use;
        cb.addEventListener("change", () => { s.use = cb.checked; savePhd(); state.openPhd.add(p.id); renderPhd(); });
        const a = PR.authorYear(s);
        ul.appendChild(el("li", {}, [
          cb,
          el("div", {}, [
            el("label", { for: cb.id, style: "margin:0;color:var(--carbon);font-size:12.5px" }, [
              document.createTextNode(`${s.id}: ${a.who} (${s.year}) ${s.title}${s.venue ? ", " + s.venue : ""}`),
              s.abstract && s.abstract.length >= 150 ? document.createTextNode("") : el("span", { class: "tag", text: s.passages || s.notes ? "paper text" : "no abstract" }),
            ]),
            (() => {
              const have = paperText.has(paperKey(p, s));
              const d = el("details", {}, [el("summary", { class: "small", text: s.paperWords ? `Full paper attached (${s.paperWords.toLocaleString()} words)${have ? "" : ", attach again after a refresh to re-pick passages"}` : "Attach the full paper (PDF) so the proposal is written from it" })]);
              const fi = el("input", { type: "file", accept: ".pdf,application/pdf", "aria-label": `Full paper PDF for ${s.title}` });
              fi.addEventListener("change", () => { const f = fi.files[0]; fi.value = ""; attachPaper(p, s, f); });
              d.appendChild(fi);
              if (s.oaUrl) d.appendChild(el("div", { class: "small" }, [document.createTextNode("A free copy may be here: "), el("a", { href: s.oaUrl, target: "_blank", rel: "noopener", text: "open the free copy" }), document.createTextNode(", save it as PDF, then attach it above.")]));
              else d.appendChild(el("div", { class: "small", text: "No free copy was found. If your university library gives you access, download the PDF there and attach it." }));
              d.appendChild(el("div", { class: "small", text: "Or paste passages by hand:" }));
              const ta = el("textarea", { "aria-label": `Passages from ${s.title}`, placeholder: "Paste sentences from the paper that matter for your proposal. The proposal may then draw on them as well as the abstract." });
              ta.value = s.notes || "";
              ta.addEventListener("change", () => { s.notes = ta.value.slice(0, 3000); savePhd(); state.openPhd.add(p.id); renderPhd(); });
              d.appendChild(ta); return d;
            })(),
          ]),
          el("span", {}, [
            s.doi ? el("a", { href: "https://doi.org/" + s.doi, target: "_blank", rel: "noopener", text: "open" }) : document.createTextNode(""),
            document.createTextNode(" "),
            el("button", { class: "btn", style: "padding:0 6px", "aria-label": `Remove ${s.title}`, text: "×", onclick: () => { p.sources = p.sources.filter((x) => x !== s); savePhd(); state.openPhd.add(p.id); renderPhd(); } }),
          ]),
        ]));
      }
      wrap.appendChild(ul);
      wrap.appendChild(el("div", { class: "small", text: `${usedSources(p).length} of ${p.sources.length} ticked. The proposal is written only from the ticked papers' abstracts and any passages you paste, so tick the ones you will really read. Papers with no abstract are not ticked by default.` }));
    }

    const writing = state.busy.has(p.id + ":write");
    const wbtn = el("button", { class: "btn", text: writing ? "Writing…" : (p.proposalFull ? "Write it again" : "Write the proposal"), onclick: () => writeProposal(p) });
    if (writing) wbtn.setAttribute("disabled", "");
    wrap.appendChild(el("div", { class: "row" }, [wbtn]));

    if (p.proposalFull) {
      if (p.proposalNote) wrap.appendChild(el("div", { class: "quality-warn", text: p.proposalNote }));
      const ta = el("textarea", { "aria-label": "Full research proposal", style: "min-height:380px" });
      ta.value = p.proposalFull;
      ta.addEventListener("change", () => { p.proposalFull = ta.value; p.updatedAt = new Date().toISOString(); savePhd(); });
      wrap.appendChild(ta);
      wrap.appendChild(el("div", { class: "row" }, [
        el("button", { class: "btn", text: "Copy", onclick: () => copyText(p.proposalFull) }),
        el("button", { class: "btn", text: "Download .md", onclick: () => downloadText(p.proposalFull, `research-proposal-${PH.slug(p.university)}.md`) }),
        el("button", { class: "btn", text: "Copy references with italics", onclick: () => copyReferences(p) }),
        el("button", { class: "btn", text: "Re-check wording after my edits", onclick: () => recheckWording(p) }),
      ]));
      wrap.appendChild(proposalReport(p));
    }
    return wrap;
  }

  function proposalReport(p) {
    const r = p.proposalReport;
    const box = el("div", { class: "report" });
    if (!r) return box;
    box.appendChild(el("h4", { text: "What the checks found" }));
    box.appendChild(el("p", { class: "small", text: `${r.words} words (target ${r.target}). ${r.passes ? `Revised ${r.passes} time${r.passes === 1 ? "" : "s"} to fix checker findings.` : ""}` }));
    if (r.remaining && r.remaining.length) {
      box.appendChild(el("p", { text: "Still flagged:", style: "margin:4px 0;font-weight:700" }));
      box.appendChild(el("ul", { class: "warn-list" }, r.remaining.map((x) => el("li", { text: x }))));
    } else box.appendChild(el("p", { class: "small", text: "No stock phrases, unlisted citations or voice mismatches found." }));
    if (r.style && r.style.length) {
      const t = el("table", { class: "cmp" }, [el("tr", {}, ["How it reads", "You", "This draft", ""].map((x) => el("th", { text: x })))]);
      for (const row of r.style) t.appendChild(el("tr", {}, [row.label, String(row.yours), String(row.draft), row.flag ? "differs" : ""].map((x, i) => el("td", { text: x, class: i === 3 && x ? "flag" : "" }))));
      box.appendChild(t);
    }
    if (r.evidence && r.evidence.length) {
      box.appendChild(el("h4", { text: "Where each source says it", style: "margin-top:10px" }));
      box.appendChild(el("p", { class: "small", text: "Words the draft quoted from the attached papers to back its claims. A tick means the words were found in that paper's text; a cross means they were not." }));
      box.appendChild(el("ul", { class: "warn-list" }, r.evidence.map((e) => el("li", { text: `${e.found ? "✓" : "✗"} [${e.id}] “${e.quote}”` }))));
    }
    const cited = (r.cited || []).map((id) => p.sources.find((x) => x.id === id)).filter(Boolean);
    if (cited.length) {
      const read = cited.filter((s) => p.readSources[s.id]).length;
      box.appendChild(el("h4", { text: `Sources cited: ${read} of ${cited.length} marked read`, style: "margin-top:10px" }));
      box.appendChild(el("p", { class: "small", text: "The references are real records. Whether each paper supports the sentence it is cited for is for you to check: open it, read it, then tick it. You will be asked about these at interview." }));
      const ul = el("ul", { class: "src-list" });
      for (const s of cited) {
        const cb = el("input", { type: "checkbox", id: `read-${p.id}-${s.id}`, "aria-label": `I have read ${s.title}` });
        cb.checked = !!p.readSources[s.id];
        cb.addEventListener("change", () => { p.readSources[s.id] = cb.checked; savePhd(); state.openPhd.add(p.id); renderPhd(); });
        const gaps = PR.referenceGaps(s);
        ul.appendChild(el("li", {}, [cb, el("div", {}, [el("label", { for: cb.id, style: "margin:0;color:var(--carbon);font-size:12.5px", text: PR.referenceLine(s).replace(/\*/g, "") }),
          gaps.length ? el("div", { class: "weak", style: "font-size:12px;color:var(--caution)", text: "Complete by hand in the reference list: " + gaps.join(", ") + "." }) : document.createTextNode("")]),
          s.doi ? el("a", { href: "https://doi.org/" + s.doi, target: "_blank", rel: "noopener", text: "open" }) : document.createTextNode("")]));
      }
      box.appendChild(ul);
    }
    return box;
  }

  function wireStyle() {
    const box = document.getElementById("ph-style-text");
    box.value = state.styleText;
    const okey = document.getElementById("ph-oakey");
    okey.value = lsGet(LS.oaKey, "") || "";
    okey.addEventListener("change", () => { lsSet(LS.oaKey, okey.value.trim()); });
    renderStyleStats();
    document.getElementById("ph-style-save").addEventListener("click", () => {
      state.styleText = box.value; lsSet(LS.style, state.styleText); renderStyleStats(); renderPhd();
    });
    document.getElementById("ph-style-clear").addEventListener("click", () => {
      box.value = ""; state.styleText = ""; lsSet(LS.style, ""); renderStyleStats(); renderPhd();
    });
    document.getElementById("ph-style-file").addEventListener("change", async (e) => {
      const files = [...e.target.files]; e.target.value = "";
      try {
        for (const f of files) {
          const t = await fileToText(f);
          if (!t.trim()) throw new Error(`No text could be read from ${f.name} (a scanned PDF has none).`);
          box.value = (box.value.trim() ? box.value.trim() + "\n\n" : "") + t.trim();
        }
        state.styleText = box.value; lsSet(LS.style, state.styleText); renderStyleStats(); renderPhd();
      } catch (err) { document.getElementById("ph-style-stats").textContent = err.message || String(err); }
    });
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
    const olr = outlookFor("phd", p);
    chips.push(el("span", { class: "chip", text: "Outlook: " + (olr && olr.ok ? olr.bandLabel : "?") }));
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
    body.appendChild(proposalBuilder(p));
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
    body.appendChild(outlookPanel("phd", p, () => {}));

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
    wireStyle();
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



  // ---------------------------------------------------------------- My research
  const RS = self.Research;
  const researchTexts = new Map();            // full text, memory only
  const rq = (id) => document.getElementById(id);
  const saveResearch = () => lsSet(LS.research, state.research);
  const researchBlock = (opts) => (RS && state.research.length ? RS.block(state.research, opts) : "");
  const researchCorpus = () => (RS && state.research.length ? RS.corpus(state.research) : "");
  const rsMsg = (t) => { const m = rq("rs-msg"); if (m) m.textContent = t || ""; };

  async function rsAddText(rawText, fileName) {
    try {
      if (!RS) throw new Error("This box needs web/lib/research.js.");
      if (!lsGet(LS.geminiKey, "")) throw new Error("Add your Gemini key first (top of the page). The digest is written by Gemini and then checked against the text.");
      if (state.research.length >= RS.MAX_WORKS) throw new Error(`You can keep ${RS.MAX_WORKS} documents. Delete one first.`);
      const text = PR.cleanPaperText(rawText);
      const words = RS.wordCount(text);
      if (words < RS.MIN_WORDS) throw new Error(`Only ${words.toLocaleString()} words could be read. A thesis or report needs at least ${RS.MIN_WORDS.toLocaleString()}. If the PDF is a scan with no selectable text, paste the text instead.`);
      const kind = rq("rs-kind").value;
      rsMsg(`Reading ${words.toLocaleString()} words and writing a digest…`);
      const raw = await callGemini(RS.buildDigestPrompt({ kind, text }));
      const d = RS.parseDigest(raw, text);
      if (!d) throw new Error("The digest could not be read. Try again.");
      if (!d.ok) throw new Error(d.reason + " Nothing was saved. Try again, or paste the main chapters only.");
      const id = "r" + Date.now().toString(36);
      const w = { id, title: d.title || (fileName || "Untitled").replace(/\.[a-z0-9]+$/i, ""), kind, year: d.year, file: fileName || "pasted text", words, summary: d.summary, mineNote: "", passages: RS.keyPassages(text, 4000), items: d.items, at: new Date().toISOString() };
      researchTexts.set(id, text);
      state.research.push(w); saveResearch();
      rsMsg(`Done: ${d.items.length} statements, each tied to a quote from the document${d.dropped ? ` (${d.dropped} the AI offered could not be found in it and were dropped)` : ""}. Untick any that are wrong, mark what was shared, and say what was your own.`);
      renderResearch();
    } catch (e) { rsMsg(e.message || String(e)); }
  }

  function renderResearch() {
    const list = rq("rs-list"); if (!list) return; list.textContent = "";
    for (const w of state.research) {
      const card = el("div", { class: "tr-card" });
      card.appendChild(el("h4", { text: `${w.title} (${w.kind}${w.year ? ", " + w.year : ""})` }));
      card.appendChild(el("div", { class: "small", text: `${w.file}, ${w.words.toLocaleString()} words. ${w.items.filter((i) => i.keep).length} of ${w.items.length} statements in use.` }));
      if (w.summary) card.appendChild(el("p", { text: w.summary }));
      w.items.forEach((it, i) => {
        const cb = el("input", { type: "checkbox", id: `rs-k-${w.id}-${i}`, "aria-label": "Use: " + it.text });
        cb.checked = it.keep; cb.addEventListener("change", () => { it.keep = cb.checked; saveResearch(); renderResearch(); });
        const mine = el("select", { "aria-label": "Whose work: " + it.text }, [el("option", { value: "1", text: "my own work" }), el("option", { value: "0", text: "shared or others'" })]);
        mine.value = it.mine ? "1" : "0"; mine.addEventListener("change", () => { it.mine = mine.value === "1"; saveResearch(); });
        card.appendChild(el("div", { class: "tr-req" }, [el("div", {}, [cb, document.createTextNode(" "), el("span", { class: "tr-badge thin", text: it.kind }), document.createTextNode(" "), el("strong", { text: it.text }), document.createTextNode(" "), mine]), el("div", { class: "small", text: "From the document: “" + it.quote + "”" })]));
      });
      const note = el("textarea", { id: "rs-note-" + w.id, "aria-label": "What was your own in this work", placeholder: "What exactly was yours? What did a supervisor, co-author or team do, and what data or tools were provided to you? One or two sentences, in your words." });
      note.value = w.mineNote || "";
      note.addEventListener("change", () => { w.mineNote = note.value.trim().slice(0, 1500); saveResearch(); });
      card.appendChild(el("label", { for: "rs-note-" + w.id, text: "What was your own, and what was shared", style: "margin-top:8px" })); card.appendChild(note);
      card.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", text: "Delete this document", onclick: () => { if (!window.confirm("Delete this digest? The document itself is not stored.")) return; state.research = state.research.filter((x) => x.id !== w.id); researchTexts.delete(w.id); saveResearch(); renderResearch(); } })]));
      list.appendChild(card);
    }
  }

  function wireResearch() {
    if (!rq("rs-box")) return;
    if (!RS) { rsMsg("This box needs web/lib/research.js. Add it next to the other files in web/lib/, push, and refresh."); return; }
    const sel = rq("rs-kind"); RS.KINDS.forEach((k) => sel.appendChild(el("option", { value: k, text: k })));
    rq("rs-file").addEventListener("change", async (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = ""; if (!f) return;
      try {
        rsMsg(`Reading ${f.name}…`);
        const raw = /\.pdf$/i.test(f.name) ? await extractPdfText(await f.arrayBuffer()) : await f.text();
        await rsAddText(raw, f.name);
      } catch (err) { rsMsg(err.message || String(err)); }
    });
    rq("rs-add-paste").addEventListener("click", async () => { const t = rq("rs-paste").value; if (!t.trim()) { rsMsg("Paste the text first."); return; } await rsAddText(t, "pasted text"); if (!/^Done/.test(rq("rs-msg").textContent)) return; rq("rs-paste").value = ""; });
    renderResearch();
  }


  // ---------------------------------------------------------------- Response outlook
  const OL = self.Outlook;
  function researchDocCount() { return self.Research ? self.Research.usable(state.research).length : 0; }
  function phdFit(p) { try { return p.advert && state.cvText ? SC.cvFit(state.cvText, p.advert, p.programme || "").percent : null; } catch (e) { return null; } }
  function outlookFor(kind, rec) {
    if (!OL) return null;
    return kind === "job" ? OL.scoreJob(rec, { cvText: state.cvText }) : OL.scorePhd(rec, { fitPct: phdFit(rec), researchDocs: researchDocCount() });
  }
  function historyLine() {
    if (!OL) return null;
    const h = OL.history(state.apps, state.phd);
    if (!h.n) return null;
    if (!h.enough) return el("div", { class: "small", text: `Your own reply rate will show here once you have 8 applications that are three weeks old or have had a reply (${h.n} so far).` });
    return el("div", { class: "small", text: `From your own record: of ${h.n} applications three weeks old or answered, ${h.heard} got any reply (${h.replyRate}%) and ${h.positive} an interview or offer (${h.positiveRate}%). Ghosting counts as no reply.` });
  }
  function outlookPanel(kind, rec, onChange) {
    const box = el("div", { class: "tr-card", id: "ol-" + rec.id });
    box.appendChild(el("h4", { text: "Response outlook" }));
    if (kind === "job") {
      const cb = el("input", { type: "checkbox", id: "ol-ref-" + rec.id, "aria-label": "I have a referral or know someone there" });
      cb.checked = !!rec.referral;
      cb.addEventListener("change", () => { rec.referral = cb.checked; rec.updatedAt = new Date().toISOString(); saveApps(); onChange(); });
      box.appendChild(el("div", {}, [cb, document.createTextNode(" "), el("label", { for: "ol-ref-" + rec.id, text: "I have a referral or know someone there", style: "display:inline" })]));
    }
    const r = outlookFor(kind, rec);
    if (!r) { box.appendChild(el("div", { class: "small", text: "This panel needs web/lib/outlook.js." })); return box; }
    if (!r.ok) { box.appendChild(el("p", { class: "small", text: r.reason })); for (const f of r.factors.filter((x) => x.score === null)) box.appendChild(el("div", { class: "small", text: `${f.label}: ${f.note}` })); return box; }
    box.appendChild(el("p", {}, [el("span", { class: `tr-badge ${r.band === "strong" ? "strong" : r.band === "fair" ? "thin" : "missing"}`, text: r.bandLabel }), document.createTextNode(` ${r.score} of 100. `), el("span", { class: "small", text: "An index built from what can be seen, not a probability. No one can see the employer's pipeline." })]));
    for (const f of r.factors) {
      box.appendChild(el("div", { class: "small", style: "max-width:560px;margin-top:6px" }, [el("strong", { text: `${f.label}${f.score === null ? "" : ": " + f.score}` }), document.createTextNode(` ${f.note}`), f.score === null ? null : el("div", { class: "tr-bar" }, [el("i", { style: `width:${f.score}%` })])].filter(Boolean)));
    }
    if (r.capNotes.length) box.appendChild(el("div", { class: "note", text: r.capNotes.join(" ") }));
    if (r.helps.length) { box.appendChild(el("h5", { text: "Worth doing first" })); box.appendChild(el("ul", {}, r.helps.map((h) => el("li", { text: h })))); }
    const hl = historyLine(); if (hl) box.appendChild(hl);
    return box;
  }

  // ---------------------------------------------------------------- About me
  const PF = self.Profile;
  const pq = (id) => document.getElementById(id);
  const saveProfile = () => { if (state.profile) { state.profile.at = new Date().toISOString(); lsSet(LS.profile, state.profile); } };

  function renderProfile() {
    const box = pq("pf-box"); if (!box) return;
    if (!PF || !state.profile) { pq("pf-msg").textContent = "This box needs web/lib/profile.js. Add it next to the other files in web/lib/, push, and refresh."; return; }
    const qs = pq("pf-questions");
    if (!qs.childNodes.length) {
      let group = "";
      for (const q of PF.QUESTIONS) {
        if (q.group !== group) { group = q.group; qs.appendChild(el("h4", { text: group === "direction" ? "Where you are going" : "How you work", style: "margin-top:12px" })); }
        const ta = el("textarea", { id: "pf-q-" + q.id, "aria-label": q.q, placeholder: q.hint, style: "min-height:70px" });
        ta.value = state.profile.answers[q.id] || "";
        ta.addEventListener("change", () => { const v = ta.value.trim().slice(0, 3000); if (v) state.profile.answers[q.id] = v; else delete state.profile.answers[q.id]; saveProfile(); renderProfileProgress(); });
        qs.appendChild(el("label", { for: "pf-q-" + q.id, text: q.q, style: "margin-top:8px" }));
        qs.appendChild(ta);
      }
    }
    const ls = pq("pf-letter-style");
    if (ls && !ls.options.length) { PF.LETTER_STYLES.forEach((x) => ls.appendChild(el("option", { value: x.id, text: x.label }))); ls.addEventListener("change", () => setLetterStyle(ls.value)); }
    if (ls) ls.value = letterStyle();
    syncLetterHint();
    renderProfileProgress(); renderTraits(); renderScale();
  }
  function renderProfileProgress() {
    const p = PF.progress(state.profile);
    pq("pf-progress").textContent = `Direction: ${p.direction} of ${p.directionTotal} answered. How you work: ${p.character} of ${p.characterTotal}. A line of five words or more counts.`;
  }
  function renderTraits() {
    const box = pq("pf-traits"); box.textContent = "";
    const t = state.profile.traits;
    if (!t.length) return;
    box.appendChild(el("h4", { text: "How you come across, from your own words" }));
    box.appendChild(el("p", { class: "small", style: "max-width:64ch", text: "A reflection of what you wrote, not a test result. Keep only what is true of you; kept ones are given to the letter writer as confirmed. Each rests on a quote from your answers." }));
    t.forEach((x, i) => {
      const cb = el("input", { type: "checkbox", id: "pf-t-" + i, "aria-label": "Keep: " + x.text });
      cb.checked = x.keep;
      cb.addEventListener("change", () => { x.keep = cb.checked; saveProfile(); });
      box.appendChild(el("div", { class: "tr-req" }, [el("div", {}, [cb, document.createTextNode(" "), el("strong", { text: x.text })]), el("div", { class: "small", text: "From: “" + x.quote + "”" })]));
    });
  }

  function renderScale() {
    const items = pq("pf-scale-items"); if (!items) return;
    if (!items.childNodes.length) {
      for (const it of PF.ITEMS) {
        const sel = el("select", { id: "pf-s-" + it.n, "aria-label": `${it.n}. ${it.text}` }, [el("option", { value: "", text: "choose" })].concat(PF.SCALE.map((t, i) => el("option", { value: String(i + 1), text: `${i + 1} ${t}` }))));
        sel.value = state.profile.test[it.n] ? String(state.profile.test[it.n]) : "";
        sel.addEventListener("change", () => { if (sel.value) state.profile.test[it.n] = Number(sel.value); else delete state.profile.test[it.n]; saveProfile(); renderScale(); });
        items.appendChild(el("div", { class: "tr-req", style: "display:flex;gap:10px;flex-wrap:wrap;align-items:center" }, [el("label", { for: "pf-s-" + it.n, text: `${it.n}. ${it.text}`, style: "flex:1 1 220px;margin:0" }), sel]));
      }
    } else {
      for (const it of PF.ITEMS) { const sel = pq("pf-s-" + it.n); const v = state.profile.test[it.n] ? String(state.profile.test[it.n]) : ""; if (sel && sel.value !== v) sel.value = v; }
    }
    const n = PF.scaleCount(state.profile.test);
    pq("pf-scale-progress").textContent = `${n} of 50 answered.` + (n < 50 ? " Each of the five results needs its own ten statements answered." : "");
    const res = pq("pf-scale-result"); res.textContent = "";
    const sc = PF.scoreScale(state.profile.test);
    if (!Object.values(sc).some(Boolean)) return;
    res.appendChild(el("h4", { text: "Your result" }));
    res.appendChild(el("p", { class: "small", style: "max-width:64ch", text: "Read each as low, middle or high on the 1 to 5 scale itself. No population norms are applied, so this says how you rated yourself, not how you compare with other people." }));
    for (const d of Object.keys(PF.DIMS)) {
      const r = sc[d];
      if (!r) { res.appendChild(el("div", { class: "small", text: `${PF.DIMS[d].name}: answer all ten of its statements to see this.` })); continue; }
      res.appendChild(el("div", { class: "small", style: "max-width:560px" }, [el("strong", { text: `${PF.DIMS[d].name}: ${r.band} (${r.mean} of 5). ` }), document.createTextNode(`This person ${PF.DIMS[d][r.band]}.`), el("div", { class: "tr-bar" }, [el("i", { style: `width:${(r.mean - 1) * 25}%` })])]));
    }
  }

  async function pfMirror() {
    const msg = pq("pf-msg");
    try {
      if (!state.profile) throw new Error("This box needs web/lib/profile.js.");
      const story = (state.styleText || "").trim().split(/\s+/).length >= 150 ? state.styleText.trim() : "";
      if (PF.answered(state.profile).length < 4 && !story) throw new Error("There is not enough of your own writing yet. Answer at least four of the questions above, or load your written background (Your writing and background, PhD tab), then try again.");
      msg.textContent = "Reading your answers" + (story ? ", your background" : "") + " and your CV…";
      const t = PF.parseMirror(await callGemini(PF.buildMirrorPrompt(state.profile, state.cvText, story)), state.profile, state.cvText, story);
      if (!t.length) throw new Error("Nothing came back that rests on your own words. Add more detail and try again.");
      state.profile.traits = t; saveProfile(); renderTraits();
      msg.textContent = `${t.length} observations, each tied to a quote from you. Untick any that are not true.`;
    } catch (e) { msg.textContent = e.message || String(e); }
  }
  function wireProfile() {
    if (!pq("pf-box")) return;
    pq("pf-mirror").addEventListener("click", pfMirror);
    pq("pf-clear").addEventListener("click", () => {
      if (!window.confirm("Delete all your answers here and the observations?")) return;
      state.profile = PF ? PF.empty() : null; saveProfile(); pq("pf-questions").textContent = ""; pq("pf-scale-items").textContent = ""; pq("pf-msg").textContent = ""; renderProfile();
    });
    renderProfile();
  }


  // ---------------------------------------------------------------- Languages
  const LG = self.Lang;
  const lg = (id) => document.getElementById(id);
  let run = null;               // the lesson or review in progress
  let lgBusy = false;
  const saveLang = () => lsSet(LS.lang, state.lang);
  const lgMsg = (t) => { const m = lg("lg-msg"); if (m) m.textContent = t || ""; };
  const lgCourse = () => (state.lang ? state.lang.courses.find((c) => c.id === state.lang.active) || null : null);
  const tgt = (text, tag, cls) => el("span", { lang: tag || undefined, dir: "auto", class: cls || "", text });

  function voiceFor(tag) {
    try { if (!tag || !self.speechSynthesis || !self.SpeechSynthesisUtterance) return false; const p = tag.slice(0, 2).toLowerCase(); return (self.speechSynthesis.getVoices() || []).some((v) => String(v.lang || "").toLowerCase().startsWith(p)); } catch (e) { return false; }
  }
  function say(text, tag) { try { self.speechSynthesis.cancel(); const u = new self.SpeechSynthesisUtterance(text); if (tag) u.lang = tag; self.speechSynthesis.speak(u); } catch (e) { /* no voice */ } }
  const recogClass = () => self.SpeechRecognition || self.webkitSpeechRecognition || null;
  const hearBtn = (text, tag) => el("button", { class: "btn", type: "button", "aria-label": "Hear it: " + text, text: "Hear it", onclick: () => say(text, tag) });

  function lgStatsView() {
    const box = lg("lg-stats"); if (!box || !state.lang) return; box.textContent = "";
    const s = state.lang.stats, today = LG.dayKey();
    const dayXp = s.day && s.day.date === today ? s.day.xp : 0, lv = LG.levelOf(s.xp), next = LG.levelStart(lv + 1), cur = LG.levelStart(lv);
    const learned = state.lang.courses.reduce((n, c) => n + LG.learnedCount(c.srs), 0);
    box.appendChild(el("div", {}, [
      el("strong", { text: `Level ${lv}.` }), document.createTextNode(` ${s.xp} XP, ${next - s.xp} to reach level ${lv + 1}.  `),
      el("strong", { text: `${LG.streakNow(s)} day streak` }), document.createTextNode(` (best ${s.streak.best}).  ${learned} words learned.`),
    ]));
    box.appendChild(el("div", { class: "tr-bar", "aria-hidden": "true" }, [el("i", { style: `width:${Math.min(100, Math.round(((s.xp - cur) / (next - cur)) * 100))}%` })]));
    const goalRow = el("div", { class: "row", style: "align-items:center;margin:8px 0 0" });
    goalRow.appendChild(el("span", { class: "small", text: `Today: ${dayXp} of ${s.goal} XP${dayXp >= s.goal ? ". Goal reached." : ""}` }));
    const gs = el("select", { id: "lg-goalxp", "aria-label": "Daily XP goal", style: "width:auto" }, LG.DAILY_GOALS.map((g) => el("option", { value: String(g), text: `${g} XP a day` })));
    gs.value = String(s.goal); gs.addEventListener("change", () => { s.goal = Number(gs.value); saveLang(); lgStatsView(); });
    goalRow.appendChild(gs);
    box.appendChild(goalRow);
    box.appendChild(el("div", { class: "tr-bar", "aria-hidden": "true" }, [el("i", { style: `width:${Math.min(100, Math.round((dayXp / s.goal) * 100))}%` })]));
    const badges = el("div", { style: "margin-top:8px" });
    for (const b of LG.BADGES) badges.appendChild(el("span", { class: "lg-chip" + (s.badges.indexOf(b.id) >= 0 ? "" : " off"), text: (s.badges.indexOf(b.id) >= 0 ? "" : "locked: ") + b.label }));
    box.appendChild(badges);
  }

  function lgCourseView() {
    const box = lg("lg-course"); if (!box) return; box.textContent = "";
    const c = lgCourse();
    lg("lg-new").open = !c;
    if (!c) return;
    const head = el("div", { class: "row", style: "align-items:center" });
    if (state.lang.courses.length > 1) {
      const pick = el("select", { id: "lg-pick", "aria-label": "Switch course", style: "width:auto" }, state.lang.courses.map((x) => el("option", { value: x.id, text: `${x.name}${x.from ? " (from " + x.from + ")" : ""}` })));
      pick.value = c.id; pick.addEventListener("change", () => { if (run && !run.finished && !window.confirm("Leave this lesson?")) { pick.value = c.id; return; } run = null; state.lang.active = pick.value; saveLang(); renderLang(); });
      head.appendChild(pick);
    }
    head.appendChild(el("button", { class: "btn", id: "lg-delete", text: "Delete this course", onclick: () => { if (!window.confirm(`Delete the ${c.name} course and its progress? Your XP and streak stay.`)) return; state.lang.courses = state.lang.courses.filter((x) => x.id !== c.id); state.lang.active = state.lang.courses[0] ? state.lang.courses[0].id : ""; run = null; saveLang(); renderLang(); } }));
    box.appendChild(el("h3", { style: "margin:8px 0 4px" }, [tgt(c.nativeName || c.name, c.tag), document.createTextNode(`  ${c.name}, from ${c.from}`)]));
    if (c.warning || c.confidence === "low") box.appendChild(el("div", { class: "note", text: (c.confidence === "low" ? "The AI is not confident in this language. " : "") + (c.warning || "") + " Check words against a dictionary or a speaker before relying on them." }));
    if (!voiceFor(c.tag)) box.appendChild(el("div", { class: "small", text: "No voice for this language was found in your browser, so listening exercises are off and the Hear it buttons may be silent." }));
    box.appendChild(head);
    box.appendChild(fxLevelRow(c));
    box.appendChild(lgModeBar(c));
    if (lgMode !== "words") return;
    const due = LG.dueIds(c.srs).filter((id) => LG.courseItems(c).some((i) => i.id === id)).length;
    box.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "lg-review", disabled: due ? undefined : "", text: due ? `Review ${due} word${due === 1 ? "" : "s"} that are due` : "No words due for review", onclick: () => lgStartReview() })]));
    const nextUp = c.units.findIndex((u) => u.stars === 0);
    c.units.forEach((u, i) => {
      const done = u.stars > 0;
      box.appendChild(el("div", { class: "tr-req", id: "lg-unit-" + i }, [
        el("div", {}, [
          el("span", { class: "tr-badge " + (done ? "strong" : i === nextUp ? "" : "missing"), text: done ? "done" : i === nextUp ? "next up" : "open" }),
          el("strong", { text: `${i + 1}. ${u.title}` }), document.createTextNode(" "), el("span", { class: "lg-star", "aria-label": `${u.stars} of 3 stars`, text: "★".repeat(u.stars) + "☆".repeat(3 - u.stars) }),
        ]),
        el("div", { class: "small", text: u.focus + (u.items ? ` (${u.items.length} words)` : "") }),
        el("div", { class: "row", style: "margin:4px 0 0" }, [el("button", { class: "btn", text: u.items ? (done ? "Practise again" : "Start") : "Write this unit and start", disabled: lgBusy ? "" : undefined, onclick: () => lgOpenUnit(i) })]),
      ]));
    });
    box.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "lg-more", disabled: lgBusy || c.units.length >= LG.MAX_UNITS ? "" : undefined, text: `Add 6 more units at ${c.cefr}`, onclick: () => lgMoreUnits() })]));
  }

  function renderLang() { if (!state.lang) return; lgStatsView(); lgCourseView(); lgFxView(); lgStageView(); }

  async function lgCreate() {
    if (lgBusy) return;
    try {
      if (!LG) throw new Error("This tab needs web/lib/lang.js. Add it next to the other files in web/lib/, push, and refresh.");
      if (!lsGet(LS.geminiKey, "")) throw new Error("Add your Gemini key first (top of the page). The course is written by Gemini.");
      const learn = lg("lg-learn").value.trim(), from = lg("lg-from").value.trim() || "English";
      if (!learn) throw new Error("Type the language you want to learn.");
      if (state.lang.courses.length >= LG.MAX_COURSES) throw new Error(`You can keep ${LG.MAX_COURSES} courses. Delete one first.`);
      const goal = LG.GOALS.find((g) => g.id === lg("lg-goal").value), extra = lg("lg-extra").value.trim();
      const goalText = (goal ? goal.label : "Everyday life") + (extra ? ", " + extra : "");
      lgBusy = true; lgMsg(`Planning your ${learn} course…`);
      const p = LG.parseCourse(await callGemini(LG.buildCoursePrompt({ learn, from, level: lg("lg-level").value, goalText, extra })));
      if (!p) throw new Error("The course plan could not be read. Press the button again.");
      const c = { id: "c" + Date.now().toString(36), name: p.name, nativeName: p.nativeName, tag: p.tag, script: p.script, confidence: p.confidence, warning: p.warning, from, level: lg("lg-level").value, goalText, cefr: LG.startCefr(lg("lg-level").value), fx: LG.normalizeFx({}), units: p.units.map((u) => ({ title: u.title, focus: u.focus, note: "", stars: 0, items: null, dropped: 0 })), srs: {}, removed: [], reviews: 0, at: new Date().toISOString() };
      state.lang.courses.push(c); state.lang.active = c.id; run = null; saveLang();
      lgMsg(`Your ${p.name} course is ready: ${p.units.length} units. Start with the first.`);
      lg("lg-learn").value = "";
    } catch (e) { lgMsg(e.message || String(e)); }
    lgBusy = false; renderLang();
  }

  async function lgOpenUnit(i) {
    if (lgBusy) return;
    const c = lgCourse(); if (!c || !c.units[i]) return;
    if (run && !run.finished && !window.confirm("Leave the lesson you are in?")) return;
    const u = c.units[i]; run = null;
    if (!u.items) {
      lgBusy = true; renderLang();
      try {
        if (!lsGet(LS.geminiKey, "")) throw new Error("Add your Gemini key first.");
        lgMsg(`Writing unit ${i + 1}: ${u.title}…`);
        const have = LG.courseItems(c).map((x) => x.id);
        const parsed = LG.parseUnit(await callGemini(LG.buildUnitPrompt({ course: c, unit: u, known: LG.courseItems(c).map((x) => x.target) })), { removed: c.removed, have });
        if (!parsed) throw new Error("The unit could not be read. Press Start again.");
        if (!parsed.ok) throw new Error(parsed.reason + " Press Start again.");
        lgMsg("Having a second reviewer check every item…");
        let items = parsed.items, dropped = 0;
        try {
          const bad = LG.parseCheck(await callGemini(LG.buildCheckPrompt(c, items)), items.length);
          if (bad) { items = items.filter((x, k) => !(k in bad)); dropped = parsed.items.length - items.length; } else u.unreviewed = true;
        } catch (e) { /* unreviewed: shown as such */ u.unreviewed = true; }
        if (items.length < 5) throw new Error("Too many items in that unit failed review. Press Start again for a fresh set.");
        u.items = items; u.note = parsed.note; u.dropped = dropped; saveLang();
        lgMsg(dropped ? `${dropped} item${dropped === 1 ? "" : "s"} failed review and ${dropped === 1 ? "was" : "were"} left out.` : "");
      } catch (e) { lgMsg(e.message || String(e)); lgBusy = false; renderLang(); return; }
      lgBusy = false;
    } else lgMsg("");
    run = { mode: "study", unit: i, c: c.id };
    renderLang();
    const st = lg("lg-stage"); if (st && st.scrollIntoView) { try { st.scrollIntoView({ block: "start" }); } catch (e) { /* ignore */ } }
  }

  function lgStudyView(stage, c, u) {
    stage.appendChild(el("h3", { text: `Unit ${run.unit + 1}: ${u.title}` }));
    if (u.note) stage.appendChild(el("p", { class: "small", style: "max-width:64ch", text: u.note }));
    if (u.unreviewed) stage.appendChild(el("div", { class: "note", text: "The review pass could not run for this unit. Treat it with extra care." }));
    for (const it of u.items) {
      const card = el("div", { class: "tr-card", id: "lg-w-" + it.id });
      card.appendChild(el("div", { class: "lg-key" }, [tgt(it.target, c.tag)]));
      if (it.roman) card.appendChild(el("div", { class: "small", text: it.roman }));
      card.appendChild(el("div", { text: it.meaning }));
      if (it.example) card.appendChild(el("div", { class: "small", style: "margin-top:6px" }, [tgt(it.example.target, c.tag), document.createTextNode(` ${it.example.roman ? "(" + it.example.roman + ") " : ""}= ${it.example.meaning}`)]));
      card.appendChild(el("div", { class: "row", style: "margin:6px 0 0" }, [hearBtn(it.target, c.tag), el("button", { class: "btn", type: "button", "aria-label": "Report as wrong: " + it.target, text: "This is wrong", onclick: () => lgReport(it.id) })]));
      stage.appendChild(card);
    }
    stage.appendChild(el("div", { class: "row" }, [
      el("button", { class: "btn", id: "lg-go", text: "Start practice", onclick: () => lgStartLesson() }),
      el("button", { class: "btn", text: "Close", onclick: () => { run = null; renderLang(); } }),
    ]));
  }

  function lgReport(id) {
    const c = lgCourse(); if (!c) return;
    if (!window.confirm("Remove this item from your course for good?")) return;
    if (c.removed.indexOf(id) < 0) c.removed.push(id);
    for (const u of c.units) if (u.items) u.items = u.items.filter((i) => i.id !== id);
    delete c.srs[id]; saveLang(); lgMsg("Removed. Thank you: it will not come back.");
    if (run && run.mode === "study") { const u = c.units[run.unit]; if (!u.items || u.items.length < 3) { run = null; } }
    renderLang();
  }

  function lgBuildRun(c, items, mode, unitIdx) {
    const all = LG.courseItems(c);
    const questions = LG.buildSession(items, { n: mode === "review" ? Math.min(12, Math.max(6, items.length * 2)) : 12, pool: all, hasSpaces: LG.hasSpaces(all), canListen: voiceFor(c.tag), canSpeak: !!recogClass() && !!c.tag, name: c.name });
    return { mode, unit: unitIdx, c: c.id, questions, i: 0, hearts: mode === "review" ? null : 3, correct: 0, wrong: 0, combo: 0, xp: 0, answered: null, finished: false, failed: false, seen: {} };
  }
  function lgStartLesson() {
    const c = lgCourse(), u = c && c.units[run.unit]; if (!u || !u.items || u.items.length < 3) return;
    run = lgBuildRun(c, u.items, "lesson", run.unit); renderLang();
  }
  function lgStartReview() {
    const c = lgCourse(); if (!c) return;
    const all = LG.courseItems(c), ids = LG.dueIds(c.srs).slice(0, 10), items = ids.map((id) => all.find((i) => i.id === id)).filter(Boolean);
    if (items.length < 2) { lgMsg("Too few words are due. Practise a unit instead."); return; }
    if (run && !run.finished && !window.confirm("Leave the lesson you are in?")) return;
    run = lgBuildRun(c, items, "review", -1); renderLang();
  }

  function lgStageView() {
    const stage = lg("lg-stage"); if (!stage) return; stage.textContent = "";
    const c = lgCourse(); if (!c || !run || run.c !== c.id || lgMode !== "words") return;
    if (run.mode === "study") { const u = c.units[run.unit]; if (u && u.items) lgStudyView(stage, c, u); return; }
    if (run.finished) return lgSummaryView(stage, c);
    const q = run.questions[run.i];
    if (!q) return;
    const card = el("div", { class: "tr-card", id: "lg-card" });
    card.appendChild(el("div", { class: "small", role: "status", text: `${run.mode === "review" ? "Review" : "Lesson"}: question ${run.i + 1} of ${run.questions.length}.${run.hearts === null ? "" : "  Hearts: " + "♥".repeat(run.hearts) + "♡".repeat(3 - run.hearts) + "."}  ${run.xp} XP so far.` }));
    card.appendChild(el("div", { class: "tr-bar", "aria-hidden": "true" }, [el("i", { style: `width:${Math.round((run.i / run.questions.length) * 100)}%` })]));
    card.appendChild(el("div", { class: "lg-q", text: q.prompt }));
    const item = LG.courseItems(c).find((i) => i.id === q.itemId);
    const meaningShown = q.type === "mc-target" || q.type === "type" || q.type === "order";
    if (q.show) card.appendChild(el("div", { class: "lg-key" }, [meaningShown ? el("span", { text: q.show }) : tgt(q.show, c.tag)]));
    if (q.roman) card.appendChild(el("div", { class: "small", text: q.roman }));
    if (q.audio && (q.type === "listen" || q.type === "mc-meaning")) card.appendChild(el("div", { class: "row", style: "margin:4px 0" }, [hearBtn(q.audio, c.tag)]));
    if (q.type === "listen") setTimeout(() => say(q.audio, c.tag), 50);
    const body = el("div", { id: "lg-body" });
    let read = () => null;
    if (q.options) {
      q.options.forEach((o, k) => {
        const id = `lg-o-${run.i}-${k}`;
        const rb = el("input", { type: "radio", name: "lg-choice", id, value: String(k) });
        body.appendChild(el("div", { class: "tr-opt" }, [rb, el("label", { for: id }, [q.type === "mc-target" ? tgt(o, c.tag) : el("span", { text: o })])]));
      });
      read = () => { const r = body.querySelector('input[name="lg-choice"]:checked'); return r ? Number(r.value) : null; };
    } else if (q.type === "type") {
      const inp = el("input", { type: "text", id: "lg-answer", "aria-label": "Your answer", autocomplete: "off", autocapitalize: "off", spellcheck: "false", lang: c.tag || undefined, dir: "auto" });
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lgCheck(read()); } });
      body.appendChild(inp); read = () => (inp.value.trim() ? inp.value : null);
      if (item && item.roman) body.appendChild(el("div", { class: "small", text: "You may type the romanisation." }));
    } else if (q.type === "order") {
      const chosen = [], line = el("div", { id: "lg-line", class: "lg-q", "aria-label": "Your sentence", style: "min-height:34px" }), bank = el("div", {});
      const paint = () => { line.textContent = ""; chosen.forEach((w, k) => line.appendChild(el("button", { class: "lg-word", type: "button", "aria-label": "Remove " + w, text: w, onclick: () => { chosen.splice(k, 1); paint(); } }))); bank.textContent = ""; q.bank.forEach((w, k) => bank.appendChild(el("button", { class: "lg-word", type: "button", id: `lg-b-${k}`, "aria-pressed": chosen.indexOf(k) >= 0 ? "true" : "false", disabled: chosen.indexOf(k) >= 0 ? "" : undefined, text: w, onclick: () => { chosen.push(k); paint(); } }))); };
      chosen.length = 0; const ids = [];
      const paint2 = () => { line.textContent = ""; ids.forEach((k, n) => line.appendChild(el("button", { class: "lg-word", type: "button", "aria-label": "Remove " + q.bank[k], text: q.bank[k], onclick: () => { ids.splice(n, 1); paint2(); } }))); bank.textContent = ""; q.bank.forEach((w, k) => { const used = ids.indexOf(k) >= 0; bank.appendChild(el("button", { class: "lg-word", type: "button", "aria-pressed": used ? "true" : "false", disabled: used ? "" : undefined, text: w, onclick: () => { ids.push(k); paint2(); } })); }); };
      paint2(); body.appendChild(line); body.appendChild(bank);
      read = () => (ids.length ? ids.map((k) => q.bank[k]) : null);
    } else if (q.type === "speak") {
      const RC = recogClass();
      body.appendChild(el("div", { class: "small", text: q.meaning ? "It means: " + q.meaning : "" }));
      const out = el("div", { id: "lg-heard", class: "small", "aria-live": "polite" });
      const btn = el("button", { class: "btn", id: "lg-mic", type: "button", text: "Speak now", onclick: () => {
        try { const r = new RC(); r.lang = c.tag; r.interimResults = false; r.maxAlternatives = 3; r.onresult = (e) => { const t = (e.results[0][0] || {}).transcript || ""; out.textContent = "Heard: " + t; lgCheck(t); }; r.onerror = () => { out.textContent = "Could not hear you. Try again or skip."; }; r.start(); out.textContent = "Listening…"; } catch (e) { out.textContent = "Speech recognition is not available here. Skip this one."; }
      } });
      body.appendChild(btn); body.appendChild(out);
      body.appendChild(el("button", { class: "btn", id: "lg-skip", type: "button", text: "Skip (no penalty)", onclick: () => lgSkip() }));
    }
    card.appendChild(body);
    if (q.type !== "speak") card.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "lg-check", text: "Check", onclick: () => lgCheck(read()) })]));
    stage.appendChild(card);
    stage.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", text: "Leave this lesson", onclick: () => { if (!window.confirm("Leave? Your answers so far are kept.")) return; run = null; saveLang(); renderLang(); } })]));
    const first = card.querySelector("#lg-answer, input[type=radio]"); if (first && first.focus) first.focus();
  }

  function lgCheck(response) {
    const c = lgCourse(); if (!c || !run || run.finished || run.answered) return;
    if (response === null || response === undefined || response === "") { lgMsg("Choose or type an answer first."); return; }
    lgMsg("");
    const q = run.questions[run.i], g = LG.gradeQuestion(q, response);
    run.answered = g;
    LG.srsRecord(c.srs, q.itemId, g.correct);
    let gain = 0;
    if (g.correct) { run.combo += 1; run.correct += 1; gain = LG.xpForAnswer(run.combo, g.almost); run.xp += gain; if (run.mode === "review") state.lang.stats.reviews += 1; }
    else { run.combo = 0; run.wrong += 1; if (run.hearts !== null) run.hearts -= 1; }
    saveLang();
    const stage = lg("lg-stage"), card = lg("lg-card");
    const fb = el("div", { class: g.correct ? "lg-good" : "lg-bad", role: "status", id: "lg-feedback" }, [
      el("div", { text: g.correct ? (g.almost ? "Close enough. " + (g.note || "") : "Correct.") + `  +${gain} XP` : "Not quite." }),
    ]);
    if (!g.correct || g.almost) fb.appendChild(el("div", {}, [document.createTextNode("Answer: "), q.type === "mc-meaning" || q.type === "listen" ? el("span", { text: g.expected }) : tgt(g.expected, c.tag)]));
    const it = LG.courseItems(c).find((i) => i.id === q.itemId);
    if (it && (!g.correct || q.type === "listen")) fb.appendChild(el("div", { class: "small" }, [tgt(it.target, c.tag), document.createTextNode(` = ${it.meaning}`)]));
    card.appendChild(fb);
    for (const x of card.querySelectorAll("input, button#lg-check, .lg-word")) x.setAttribute("disabled", "");
    const out = run.hearts !== null && run.hearts <= 0;
    card.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "lg-next", text: out ? "Out of hearts" : run.i + 1 >= run.questions.length ? "Finish" : "Continue", onclick: () => lgNext(out) })]));
    const nb = card.querySelector("#lg-next"); if (nb && nb.focus) nb.focus();
  }
  function lgSkip() { if (!run || run.finished) return; run.questions.splice(run.i, 1); if (run.i >= run.questions.length) return lgFinish(false); renderLang(); }
  function lgNext(out) {
    if (out) return lgFinish(true);
    run.answered = null; run.i += 1;
    if (run.i >= run.questions.length) return lgFinish(false);
    renderLang();
  }

  function lgFinish(failed) {
    const c = lgCourse(); if (!c || !run) return;
    const total = run.correct + run.wrong, res = LG.finishLesson({ correct: run.correct, total, wrong: run.wrong, failed });
    const stats = state.lang.stats, bonus = failed ? 0 : res.bonus;
    run.xp += bonus; run.result = res; run.bonus = bonus; run.failed = failed; run.finished = true;
    LG.addXp(stats, run.xp);
    if (run.mode === "lesson" && !failed) { const u = c.units[run.unit]; if (u && res.stars > u.stars) u.stars = res.stars; stats.lessons += 1; if (res.stars === 3 && run.wrong === 0) stats.perfect += 1; }
    c.reviews = (c.reviews || 0) + (run.mode === "review" ? run.correct : 0);
    const counts = lgCounts();
    run.badges = LG.newBadges(stats, counts); for (const b of run.badges) stats.badges.push(b.id);
    saveLang(); renderLang();
    const nb = lg("lg-stage").querySelector("button"); if (nb && nb.focus) nb.focus();
  }

  function lgSummaryView(stage, c) {
    const r = run.result, s = state.lang.stats;
    const card = el("div", { class: "tr-card", id: "lg-summary" });
    card.appendChild(el("h3", { text: run.failed ? "Out of hearts" : run.mode === "review" ? "Review finished" : "Lesson finished" }));
    if (run.failed) card.appendChild(el("p", { text: "Run out of hearts before the end. What you got right still counts as practice and your XP is kept. Look at the words again and try once more." }));
    else card.appendChild(el("p", {}, [el("span", { class: "lg-star", "aria-label": `${r.stars} of 3 stars`, text: "★".repeat(r.stars) + "☆".repeat(3 - r.stars) }), document.createTextNode(`  ${r.accuracy}% right.`)]));
    card.appendChild(el("p", { text: `+${run.xp} XP${run.bonus ? ` (including a ${run.bonus} XP bonus)` : ""}. ${LG.streakNow(s)} day streak. Level ${LG.levelOf(s.xp)}.` }));
    for (const b of run.badges || []) card.appendChild(el("div", { class: "lg-good", text: "New badge: " + b.label }));
    const row = el("div", { class: "row" });
    const nextIdx = run.mode === "lesson" && !run.failed ? c.units.findIndex((u, k) => k > run.unit && u.stars === 0) : -1;
    if (run.mode === "lesson" && run.failed) row.appendChild(el("button", { class: "btn", id: "lg-retry", text: "Look at the words again", onclick: () => { run = { mode: "study", unit: run.unit, c: c.id }; renderLang(); } }));
    if (nextIdx >= 0) row.appendChild(el("button", { class: "btn", id: "lg-nextunit", text: "Next unit: " + c.units[nextIdx].title, onclick: () => lgOpenUnit(nextIdx) }));
    row.appendChild(el("button", { class: "btn", text: "Back to the course", onclick: () => { run = null; renderLang(); } }));
    card.appendChild(row); stage.appendChild(card);
  }

  // ---------------------------------------------------------------- Fluency (reading, grammar, conversation, level check)
  const FX = self.Fluency;
  let lgMode = "words";         // words | read | grammar | talk | check
  let fxRun = null;             // the reading, grammar lesson, conversation or check in progress
  const fxOf = (c) => c.fx;
  const lgCounts = () => { const s = state.lang.stats; return { lessons: s.lessons, perfect: s.perfect, best: s.streak.best, learned: state.lang.courses.reduce((n, x) => n + LG.learnedCount(x.srs), 0), xp: s.xp, reviews: s.reviews, courses: state.lang.courses.length, reads: s.reads, convos: s.convos, grammar: s.grammar, checks: s.checks, ups: s.ups }; };
  // Add XP, award badges, save. Returns the new badges.
  function lgGain(xp) {
    const s = state.lang.stats; if (xp > 0) LG.addXp(s, xp);
    const nb = LG.newBadges(s, lgCounts()); for (const b of nb) s.badges.push(b.id);
    saveLang(); lgStatsView(); return nb;
  }
  const badgeLines = (list) => (list || []).map((b) => el("div", { class: "lg-good", text: "New badge: " + b.label }));
  const fxHome = () => { fxRun = null; renderLang(); };

  // Ask Gemini to solve each question without seeing the key; keep the ones it agrees with.
  async function fxBlindCheck(c, questions) {
    try {
      const ans = FX.parseSolve(await callGemini(FX.buildSolvePrompt(c, questions)), questions.length);
      if (!ans) return { kept: questions, dropped: [], unreviewed: true };
      const r = FX.applySolve(questions, ans); return { kept: r.kept, dropped: r.dropped, unreviewed: false };
    } catch (e) { return { kept: questions, dropped: [], unreviewed: true }; }
  }
  function fxNeed(c) {
    if (!FX) throw new Error("This needs web/lib/fluency.js. Add it next to the other files in web/lib/, push, and refresh.");
    if (!lsGet(LS.geminiKey, "")) throw new Error("Add your Gemini key first (top of the page).");
  }
  async function fxBusy(text, fn) {
    if (lgBusy) return; lgBusy = true; lgMsg(text); renderLang();
    try { await fn(); } catch (e) { lgMsg(e.message || String(e)); }
    lgBusy = false; renderLang();
  }
  // One question with options, graded when you press Check.
  function fxChoiceCard(q, tag, onDone, opts) {
    const card = el("div", { class: "tr-card" });
    if (opts && opts.head) card.appendChild(el("div", { class: "small", role: "status", text: opts.head }));
    if (q.context) card.appendChild(el("div", { class: "lg-key", style: "font-size:18px" }, [tgt(q.context, tag)]));
    if (q.sentence) card.appendChild(el("div", { class: "lg-key" }, [tgt(q.sentence, tag)]));
    if (q.meaning) card.appendChild(el("div", { class: "small", text: "Meaning: " + q.meaning }));
    card.appendChild(el("div", { class: "lg-q", text: q.q }));
    const body = el("div", {}); card.appendChild(body);
    q.options.forEach((o, k) => { const id = `fx-o-${Math.random().toString(36).slice(2, 7)}-${k}`; body.appendChild(el("div", { class: "tr-opt" }, [el("input", { type: "radio", name: "fx-choice", id, value: String(k) }), el("label", { for: id }, [tgt(o, tag)])])); });
    const row = el("div", { class: "row" }); const check = el("button", { class: "btn", type: "button", id: "fx-check", text: "Check" }); row.appendChild(check); card.appendChild(row);
    check.addEventListener("click", () => {
      const r = body.querySelector('input[name="fx-choice"]:checked'); if (!r) { lgMsg("Choose an answer first."); return; }
      lgMsg(""); const idx = Number(r.value), ok = idx === q.answer;
      for (const x of card.querySelectorAll("input")) x.setAttribute("disabled", ""); check.setAttribute("disabled", "");
      card.appendChild(el("div", { class: ok ? "lg-good" : "lg-bad", id: "fx-feedback", role: "status" }, [el("div", { text: ok ? "Correct." : "Not quite." }), ok ? null : el("div", {}, [document.createTextNode("Answer: "), tgt(q.options[q.answer], tag)])].filter(Boolean)));
      if (q.evidence) card.appendChild(el("div", { class: "small", text: "The text says: " + q.evidence }));
      const nx = el("button", { class: "btn", id: "fx-next", type: "button", text: (opts && opts.last) ? "Finish" : "Continue", onclick: () => onDone(ok) }); card.appendChild(el("div", { class: "row" }, [nx])); if (nx.focus) nx.focus();
    });
    return card;
  }

  // ---- shared: level, more units
  function fxLevelRow(c) {
    const row = el("div", { class: "row", style: "align-items:center" });
    row.appendChild(el("span", { class: "small", text: "My level: " }));
    const sel = el("select", { id: "lg-cefr", "aria-label": "My level", style: "width:auto" }, LG.CEFR.map((k) => el("option", { value: k, text: k + " " + (({ A1: "first steps", A2: "basic", B1: "independent", B2: "confident", C1: "advanced", C2: "near-native" })[k]) })));
    sel.value = c.cefr; sel.addEventListener("change", () => { if (LG.CEFR.indexOf(sel.value) > LG.CEFR.indexOf(c.cefr)) state.lang.stats.ups += 1; c.cefr = sel.value; lgGain(0); renderLang(); });
    row.appendChild(sel);
    return row;
  }
  async function lgMoreUnits() {
    const c = lgCourse(); if (!c) return;
    if (c.units.length >= LG.MAX_UNITS) { lgMsg(`A course holds up to ${LG.MAX_UNITS} units.`); return; }
    await fxBusy(`Planning more units at ${c.cefr}…`, async () => {
      fxNeed(c);
      const more = FX.parseMoreUnits(await callGemini(FX.buildMoreUnitsPrompt({ course: c, cefr: c.cefr, count: 6 })), c.units.map((u) => u.title));
      if (!more) throw new Error("No new units could be read. Press the button again.");
      for (const u of more.slice(0, LG.MAX_UNITS - c.units.length)) c.units.push({ title: u.title, focus: u.focus, note: "", stars: 0, items: null, dropped: 0 });
      saveLang(); lgMsg(`${more.length} new units added at ${c.cefr}.`);
    });
  }

  function lgModeBar(c) {
    const bar = el("div", { class: "row", role: "tablist", "aria-label": "What to practise", style: "margin:10px 0" });
    for (const [id, label] of [["words", "Words"], ["read", "Reading"], ["grammar", "Grammar"], ["talk", "Conversation"], ["check", "Level check"]]) {
      bar.appendChild(el("button", { class: "btn" + (lgMode === id ? " on" : ""), id: "lg-mode-" + id, role: "tab", "aria-selected": lgMode === id ? "true" : "false", text: label, onclick: () => { if (fxRun && !fxRun.done && !window.confirm("Leave what you are doing? Progress already earned is kept.")) return; fxRun = null; run = null; lgMode = id; lgMsg(""); renderLang(); } }));
    }
    return bar;
  }

  function lgFxView() {
    const box = lg("lg-fx"); if (!box) return; box.textContent = "";
    const c = lgCourse(); if (!c || lgMode === "words") return;
    if (lgMode === "read") lgReadView(box, c); else if (lgMode === "grammar") lgGrammarView(box, c); else if (lgMode === "talk") lgTalkView(box, c); else if (lgMode === "check") lgCheckView(box, c);
  }

  // ---- reading
  function lgReadView(box, c) {
    if (!fxRun || fxRun.kind !== "read") {
      box.appendChild(el("p", { class: "small", style: "max-width:64ch", text: `Short texts written for ${c.cefr}. Tap a marked word for its meaning, listen to the text, then answer questions. Every question is tied to a sentence in the text, and a second check solves each one without the key; questions it disagrees with are dropped.` }));
      box.appendChild(el("label", { for: "fx-topic", text: "Topic (optional)" }));
      box.appendChild(el("input", { id: "fx-topic", type: "text", placeholder: "for example: a day at the market, a job advert, a news item", autocomplete: "off" }));
      box.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "fx-read-go", disabled: lgBusy ? "" : undefined, text: "Write me a text to read", onclick: () => lgReadStart(c) })]));
      const h = fxOf(c).reads.slice(-5).reverse();
      if (h.length) box.appendChild(el("div", { class: "small", text: "Recent: " + h.map((r) => `${r.title} (${r.correct}/${r.total})`).join("; ") }));
      return;
    }
    const d = fxRun.data;
    box.appendChild(el("h3", { style: "margin:6px 0", text: d.title }));
    if (fxRun.unreviewed) box.appendChild(el("div", { class: "note", text: "The second check could not run, so the questions are unchecked. Treat them with care." }));
    if (fxRun.dropped) box.appendChild(el("div", { class: "small", text: `${fxRun.dropped} question${fxRun.dropped === 1 ? "" : "s"} failed the second check and ${fxRun.dropped === 1 ? "was" : "were"} left out.` }));
    const out = el("div", { id: "fx-gloss-out", class: "note", role: "status", "aria-live": "polite", hidden: "" });
    d.paragraphs.forEach((p, pi) => {
      const para = el("div", { class: "tr-card", id: "fx-p-" + pi });
      const line = el("div", { class: "lg-q", style: "font-size:19px;line-height:1.7", lang: c.tag || undefined, dir: "auto" });
      let at = 0; for (const sp of FX.glossSpans(p.text, d.glosses)) { if (sp.start > at) line.appendChild(document.createTextNode(p.text.slice(at, sp.start))); line.appendChild(el("button", { class: "lg-gloss", type: "button", "aria-label": `${sp.word}: tap for the meaning`, text: sp.word, onclick: () => { out.hidden = false; out.textContent = ""; out.appendChild(tgt(sp.word, c.tag)); out.appendChild(document.createTextNode(" = " + sp.meaning)); } })); at = sp.end; }
      if (at < p.text.length) line.appendChild(document.createTextNode(p.text.slice(at)));
      para.appendChild(line);
      const tr = el("div", { class: "small", hidden: "", style: "margin-top:6px" }, [document.createTextNode((p.roman ? p.roman + "  " : "") + (p.meaning ? "= " + p.meaning : ""))]);
      para.appendChild(el("div", { class: "row", style: "margin:6px 0 0" }, [hearBtn(p.text, c.tag), el("button", { class: "btn", type: "button", "aria-expanded": "false", text: "Show translation", onclick: (e) => { tr.hidden = !tr.hidden; e.target.textContent = tr.hidden ? "Show translation" : "Hide translation"; e.target.setAttribute("aria-expanded", tr.hidden ? "false" : "true"); } })]));
      para.appendChild(tr); box.appendChild(para);
    });
    box.appendChild(out);
    if (d.glosses.length) {
      const gl = el("div", { class: "small", style: "margin:8px 0" }, [el("strong", { text: "Words in this text: " })]);
      for (const g of d.glosses) { const saved = LG.courseItems(c).some((i) => i.id === LG.itemId(g.word)) || c.removed.indexOf(LG.itemId(g.word)) >= 0; gl.appendChild(el("span", { class: "lg-chip" }, [tgt(g.word, c.tag), document.createTextNode(" " + g.meaning + " "), el("button", { class: "lg-save", type: "button", "aria-label": "Save " + g.word + " to my words", disabled: saved ? "" : undefined, text: saved ? "saved" : "save", onclick: () => { lgSaveWord(c, g); renderLang(); } })])); }
      box.appendChild(gl);
    }
    const qbox = el("div", { id: "fx-questions" }); box.appendChild(qbox);
    const paint = () => {
      qbox.textContent = "";
      if (fxRun.done) { qbox.appendChild(el("div", { class: "tr-card", id: "fx-read-sum" }, [el("h3", { text: "Reading finished" }), el("p", { text: `${fxRun.correct} of ${d.questions.length} right. +${fxRun.xp} XP.` }), ...badgeLines(fxRun.badges), el("div", { class: "row" }, [el("button", { class: "btn", text: "Another text", onclick: () => fxHome() })])])); return; }
      const q = d.questions[fxRun.i];
      qbox.appendChild(fxChoiceCard(q, c.tag, (ok) => { if (ok) { fxRun.correct += 1; fxRun.xp += 8; } fxRun.i += 1; if (fxRun.i >= d.questions.length) lgReadFinish(c); else paint(); }, { head: `Question ${fxRun.i + 1} of ${d.questions.length}`, last: fxRun.i + 1 >= d.questions.length }));
    };
    paint();
    box.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", text: "Leave this text", onclick: () => { if (!fxRun.done && fxRun.i > 0 && !window.confirm("Leave? Your score for this text will not be saved.")) return; fxHome(); } })]));
  }
  function lgSaveWord(c, g) {
    const item = FX.glossItem(g); if (LG.courseItems(c).some((i) => i.id === item.id) || c.removed.indexOf(item.id) >= 0) return;
    let u = c.units.find((x) => x.title === "From my reading");
    if (!u) { u = { title: "From my reading", focus: "Words you saved from texts", note: "", stars: 0, items: [], dropped: 0 }; c.units.push(u); }
    u.items.push(item); c.srs[item.id] = { box: 1, due: Date.now(), seen: 0, right: 0 }; saveLang(); lgMsg("Saved. It will come back in your reviews.");
  }
  async function lgReadStart(c) {
    const topic = (lg("fx-topic") || {}).value || "";
    await fxBusy(`Writing a ${c.cefr} text…`, async () => {
      fxNeed(c);
      const p = FX.parseRead(await callGemini(FX.buildReadPrompt({ course: c, cefr: c.cefr, topic: topic.trim(), known: LG.courseItems(c).map((i) => i.target) })), {});
      if (!p) throw new Error("The text could not be read. Press the button again.");
      if (!p.ok) throw new Error(p.reason + " Press the button again.");
      lgMsg("Having a second check solve each question…");
      const full = p.paragraphs.map((x) => x.text).join("\n");
      const qs = p.questions.map((q) => Object.assign({}, q, { context: full }));
      const r = await fxBlindCheck(c, qs);
      if (r.kept.length < 3) throw new Error("Too many questions failed the check. Press the button again for a fresh text.");
      p.questions = r.kept.map((q) => ({ q: q.q, options: q.options, answer: q.answer, evidence: q.evidence }));
      fxRun = { kind: "read", data: p, i: 0, correct: 0, xp: 0, done: false, unreviewed: r.unreviewed, dropped: r.dropped.length };
      lgMsg("");
    });
  }
  function lgReadFinish(c) {
    const d = fxRun.data; fxRun.done = true; const s = state.lang.stats; s.reads += 1;
    fxOf(c).reads.push({ title: d.title, cefr: c.cefr, correct: fxRun.correct, total: d.questions.length, at: LG.dayKey() }); fxOf(c).reads = fxOf(c).reads.slice(-60);
    fxRun.badges = lgGain(fxRun.xp); renderLang();
  }

  // ---- grammar
  function lgGrammarView(box, c) {
    const f = fxOf(c);
    if (!fxRun || fxRun.kind !== "grammar") {
      box.appendChild(el("p", { class: "small", style: "max-width:64ch", text: `Short lessons on the grammar that matters at ${c.cefr}: the rule, patterns, examples, then exercises. Exercises are checked by a second pass that solves them without the key. Grammar is the part the AI is most likely to get subtly wrong, so check anything surprising in a grammar book.` }));
      const list = f.topics[c.cefr];
      if (!list.length) box.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "fx-topics-go", disabled: lgBusy ? "" : undefined, text: `Suggest grammar topics for ${c.cefr}`, onclick: () => lgTopics(c) })]));
      list.forEach((t, i) => box.appendChild(el("div", { class: "tr-req", id: "fx-topic-" + i }, [el("div", {}, [el("span", { class: "tr-badge " + (t.done ? "strong" : ""), text: t.done ? "done" : "open" }), el("strong", { text: t.title })]), el("div", { class: "small", text: t.focus }), el("div", { class: "row", style: "margin:4px 0 0" }, [el("button", { class: "btn", disabled: lgBusy ? "" : undefined, text: t.done ? "Practise again" : "Start", onclick: () => lgGrammarStart(c, t) })])])));
      box.appendChild(el("label", { for: "fx-own", text: "Or a topic of your own" }));
      box.appendChild(el("input", { id: "fx-own", type: "text", placeholder: "for example: how to use the past tense", autocomplete: "off" }));
      box.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "fx-own-go", disabled: lgBusy ? "" : undefined, text: "Teach me this", onclick: () => { const v = lg("fx-own").value.trim(); if (!v) { lgMsg("Type a topic first."); return; } lgGrammarStart(c, { title: v, focus: "", own: true }); } })]));
      return;
    }
    const L1 = fxRun.lesson;
    if (fxRun.stage === "learn") {
      box.appendChild(el("h3", { style: "margin:6px 0", text: L1.title }));
      if (fxRun.unreviewed) box.appendChild(el("div", { class: "note", text: "The second check could not run, so the exercises are unchecked." }));
      box.appendChild(el("p", { style: "max-width:64ch", text: L1.rule }));
      for (const p of L1.patterns) box.appendChild(el("div", { class: "tr-card" }, [el("div", { class: "lg-key", style: "font-size:20px" }, [tgt(p.target, c.tag)]), p.roman ? el("div", { class: "small", text: p.roman }) : null, el("div", { text: p.meaning })].filter(Boolean)));
      box.appendChild(el("div", { class: "small", style: "margin:8px 0" }, [el("strong", { text: "Examples" })]));
      for (const x of L1.examples) box.appendChild(el("div", { class: "tr-card" }, [el("div", { class: "lg-key", style: "font-size:20px" }, [tgt(x.target, c.tag)]), x.roman ? el("div", { class: "small", text: x.roman }) : null, el("div", { text: x.meaning }), el("div", { class: "row", style: "margin:6px 0 0" }, [hearBtn(x.target, c.tag)])].filter(Boolean)));
      if (L1.mistakes.length) box.appendChild(el("div", { class: "note", text: "Common mistakes: " + L1.mistakes.join(" ") }));
      box.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "fx-gram-go", text: "Start the exercises", onclick: () => { fxRun.stage = "do"; renderLang(); } }), el("button", { class: "btn", text: "Close", onclick: () => fxHome() })]));
      return;
    }
    const q = fxRun.stage === "do" ? L1.exercises[fxRun.i] : null;
    if (!q) {
      box.appendChild(el("div", { class: "tr-card", id: "fx-gram-sum" }, [el("h3", { text: "Lesson finished" }), el("p", { text: `${fxRun.correct} of ${L1.exercises.length} right. +${fxRun.xp} XP.` }), ...badgeLines(fxRun.badges), el("div", { class: "row" }, [el("button", { class: "btn", text: "Back to topics", onclick: () => fxHome() })])]));
      return;
    }
    const last = fxRun.i + 1 >= L1.exercises.length;
    const finish = () => { fxRun.i += 1; if (fxRun.i >= L1.exercises.length) lgGrammarFinish(c); else renderLang(); };
    if (q.kind === "mc") { box.appendChild(fxChoiceCard({ q: q.q, sentence: q.sentence, meaning: q.meaning, options: q.options, answer: q.answer }, c.tag, (ok) => { if (ok) { fxRun.correct += 1; fxRun.xp += 8; } finish(); }, { head: `Exercise ${fxRun.i + 1} of ${L1.exercises.length}`, last })); return; }
    const card = el("div", { class: "tr-card", id: "fx-gram-card" });
    card.appendChild(el("div", { class: "small", role: "status", text: `Exercise ${fxRun.i + 1} of ${L1.exercises.length}` }));
    card.appendChild(el("div", { class: "lg-key" }, [tgt(q.sentence, c.tag)])); card.appendChild(el("div", { class: "small", text: "Meaning: " + q.meaning })); card.appendChild(el("div", { class: "lg-q", text: q.q }));
    const inp = el("input", { type: "text", id: "fx-answer", "aria-label": "Your answer", autocomplete: "off", autocapitalize: "off", spellcheck: "false", lang: c.tag || undefined, dir: "auto" }); card.appendChild(inp);
    const chk = el("button", { class: "btn", id: "fx-check", type: "button", text: "Check" }); card.appendChild(el("div", { class: "row" }, [chk]));
    const go = () => {
      if (!inp.value.trim()) { lgMsg("Type an answer first."); return; } lgMsg(""); const g = FX.gradeExercise(q, inp.value); inp.setAttribute("disabled", ""); chk.setAttribute("disabled", "");
      if (g.correct) { fxRun.correct += 1; fxRun.xp += g.almost ? 6 : 8; }
      card.appendChild(el("div", { class: g.correct ? "lg-good" : "lg-bad", id: "fx-feedback", role: "status" }, [el("div", { text: g.correct ? (g.almost ? "Close enough. " + g.note : "Correct.") : "Not quite." }), (!g.correct || g.almost) ? el("div", { text: "Answer: " + g.expected }) : null, el("div", { class: "small", text: q.full })].filter(Boolean)));
      const nx = el("button", { class: "btn", id: "fx-next", type: "button", text: last ? "Finish" : "Continue", onclick: finish }); card.appendChild(el("div", { class: "row" }, [nx])); if (nx.focus) nx.focus();
    };
    chk.addEventListener("click", go); inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (!inp.disabled) go(); } });
    box.appendChild(card); if (inp.focus) inp.focus();
  }
  async function lgTopics(c) {
    await fxBusy("Listing grammar topics…", async () => {
      fxNeed(c); const t = FX.parseTopics(await callGemini(FX.buildGrammarTopicsPrompt({ course: c, cefr: c.cefr })));
      if (!t) throw new Error("The topics could not be read. Press the button again.");
      fxOf(c).topics[c.cefr] = t; saveLang(); lgMsg("");
    });
  }
  async function lgGrammarStart(c, topic) {
    await fxBusy(`Writing the lesson: ${topic.title}…`, async () => {
      fxNeed(c);
      const p = FX.parseGrammar(await callGemini(FX.buildGrammarPrompt({ course: c, cefr: c.cefr, topic })), { topic });
      if (!p) throw new Error("The lesson could not be read. Press Start again.");
      if (!p.ok) throw new Error(p.reason + " Press Start again.");
      lgMsg("Having a second check solve each exercise…");
      const r = await fxBlindCheck(c, p.exercises);
      if (r.kept.length < 3) throw new Error("Too many exercises failed the check. Press Start again for a fresh lesson.");
      p.exercises = r.kept;
      fxRun = { kind: "grammar", lesson: p, topic, stage: "learn", i: 0, correct: 0, xp: 0, done: false, unreviewed: r.unreviewed };
      lgMsg(r.dropped.length ? `${r.dropped.length} exercise${r.dropped.length === 1 ? "" : "s"} failed the check and ${r.dropped.length === 1 ? "was" : "were"} left out.` : "");
    });
  }
  function lgGrammarFinish(c) {
    fxRun.done = true; fxRun.stage = "sum"; state.lang.stats.grammar += 1;
    fxOf(c).grammar.push({ title: fxRun.lesson.title, cefr: c.cefr, correct: fxRun.correct, total: fxRun.lesson.exercises.length, at: LG.dayKey() }); fxOf(c).grammar = fxOf(c).grammar.slice(-60);
    const t = fxOf(c).topics[c.cefr].find((x) => x.title === fxRun.topic.title); if (t) t.done = true;
    fxRun.badges = lgGain(fxRun.xp); renderLang();
  }

  // ---- conversation
  function lgTalkView(box, c) {
    if (!fxRun || (fxRun.kind !== "talk" && fxRun.kind !== "mist")) {
      box.appendChild(el("p", { class: "small", style: "max-width:64ch", text: `Practise talking with a native-speaker role-play at ${c.cefr}. You write (or speak, in Chrome or Edge) and the partner answers at your level. After each message you get a correction only if the AI finds a real mistake. It can be wrong, so every correction has a "Report wrong" button. Your mistakes are kept so you can practise them.` }));
      box.appendChild(el("label", { for: "fx-scenario", text: "Situation" }));
      const sel = el("select", { id: "fx-scenario" }, FX.SCENARIOS.map((s) => el("option", { value: s.id, text: s.label }))); box.appendChild(sel);
      const custom = el("input", { id: "fx-custom", type: "text", placeholder: "Describe the situation, for example: I am calling a hotel to change my booking", autocomplete: "off", hidden: "" }); box.appendChild(custom);
      sel.addEventListener("change", () => { custom.hidden = sel.value !== "custom"; });
      box.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "fx-talk-go", disabled: lgBusy ? "" : undefined, text: "Start the conversation", onclick: () => { const s = FX.SCENARIOS.find((x) => x.id === sel.value); if (s.id === "custom" && !custom.value.trim()) { lgMsg("Describe the situation first."); return; } lgTalkStart(c, s.id === "custom" ? { id: "custom", label: "My own situation", brief: custom.value.trim() } : s); } })]));
      const f = fxOf(c), due = FX.dueMistakes(f.mistakes).length;
      box.appendChild(el("h3", { style: "margin:14px 0 4px", text: "My mistakes" }));
      box.appendChild(el("div", { class: "small", text: f.mistakes.length ? `${f.mistakes.length} saved from your conversations; ${due} due now.` : "Mistakes you make in conversations are saved here for practice." }));
      box.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "fx-mist-go", disabled: due ? undefined : "", text: due ? `Practise ${Math.min(due, 8)} of them` : "Nothing due", onclick: () => lgMistStart(c) })]));
      const h = f.convos.slice(-5).reverse(); if (h.length) box.appendChild(el("div", { class: "small", text: "Recent: " + h.map((r) => `${r.scenario} (${r.turns} messages, ${r.clean} without a mistake)`).join("; ") }));
      return;
    }
    if (fxRun.kind === "mist") return lgMistView(box, c);
    const t = fxRun;
    box.appendChild(el("h3", { style: "margin:6px 0", text: t.scenario.label }));
    const log = el("div", { id: "fx-log", role: "log", "aria-live": "polite" }); box.appendChild(log);
    t.history.forEach((m, k) => {
      if (m.role === "partner") {
        const b = el("div", { class: "tr-card fx-partner" }, [el("div", { lang: c.tag || undefined, dir: "auto", class: "lg-q", style: "font-size:19px", text: m.text })]);
        const extra = el("div", { class: "small", hidden: "" }, [document.createTextNode((m.roman ? m.roman + "  " : "") + (m.meaning ? "= " + m.meaning : ""))]);
        b.appendChild(el("div", { class: "row", style: "margin:4px 0 0" }, [hearBtn(m.text, c.tag), el("button", { class: "btn", type: "button", "aria-expanded": "false", text: "Show meaning", onclick: (e) => { extra.hidden = !extra.hidden; e.target.textContent = extra.hidden ? "Show meaning" : "Hide meaning"; e.target.setAttribute("aria-expanded", extra.hidden ? "false" : "true"); } })])); b.appendChild(extra);
        log.appendChild(b);
      } else {
        const b = el("div", { class: "tr-card fx-user", style: "margin-left:24px" }, [el("div", { lang: c.tag || undefined, dir: "auto", text: m.text })]);
        if (m.correction) { const cc = m.correction; b.appendChild(el("div", { class: "lg-bad fx-corr" }, [el("div", {}, [document.createTextNode(cc.kind === "fix" ? "Better: " : "A more natural way: "), tgt(cc.corrected, c.tag)]), cc.why ? el("div", { class: "small", text: cc.why }) : null, el("button", { class: "btn", type: "button", "aria-label": "Report this correction as wrong", text: "Report wrong", onclick: () => { FX.removeMistake(fxOf(c).mistakes, LG.itemId(cc.corrected)); m.correction = null; saveLang(); renderLang(); } })].filter(Boolean))); }
        else if (m.checked) b.appendChild(el("div", { class: "small", text: "No mistake found." }));
        log.appendChild(b);
      }
    });
    if (lgBusy) log.appendChild(el("div", { class: "small", role: "status", text: "Your partner is writing…" }));
    const lastP = [...t.history].reverse().find((m) => m.role === "partner");
    const sug = lastP && lastP.suggestions && lastP.suggestions.length ? el("div", { class: "small", id: "fx-hints", hidden: "" }, lastP.suggestions.map((s) => el("button", { class: "lg-word", type: "button", onclick: () => { lg("fx-say").value = s.target; lg("fx-say").focus(); } }, [tgt(s.target, c.tag), document.createTextNode(s.meaning ? "  (" + s.meaning + ")" : "")]))) : null;
    const inp = el("input", { type: "text", id: "fx-say", value: t.draft || "", "aria-label": "Your message", autocomplete: "off", lang: c.tag || undefined, dir: "auto", placeholder: "Write your reply" });
    const send = el("button", { class: "btn", id: "fx-send", type: "button", disabled: lgBusy ? "" : undefined, text: "Send", onclick: () => lgTalkSend(c) });
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lgTalkSend(c); } });
    box.appendChild(inp);
    const rowb = el("div", { class: "row" }, [send]);
    if (sug) rowb.appendChild(el("button", { class: "btn", id: "fx-hint", type: "button", "aria-expanded": "false", text: "Give me ideas", onclick: (e) => { sug.hidden = !sug.hidden; e.target.setAttribute("aria-expanded", sug.hidden ? "false" : "true"); } }));
    const RC = recogClass(); if (RC && c.tag) rowb.appendChild(el("button", { class: "btn", id: "fx-mic", type: "button", text: "Speak", onclick: () => { try { const r = new RC(); r.lang = c.tag; r.interimResults = false; r.onresult = (e) => { inp.value = (e.results[0][0] || {}).transcript || ""; inp.focus(); }; r.start(); } catch (e) { lgMsg("Speech recognition is not available here."); } } }));
    rowb.appendChild(el("button", { class: "btn", id: "fx-end", type: "button", text: "Finish conversation", onclick: () => lgTalkEnd(c) }));
    box.appendChild(rowb); if (sug) box.appendChild(sug);
    if (t.done) { box.textContent = ""; box.appendChild(el("div", { class: "tr-card", id: "fx-talk-sum" }, [el("h3", { text: "Conversation finished" }), el("p", { text: `${t.turns} message${t.turns === 1 ? "" : "s"}, ${t.clean} without a mistake. +${t.xp} XP.` }), t.newMist ? el("p", { text: `${t.newMist} mistake${t.newMist === 1 ? "" : "s"} saved for practice.` }) : null, ...badgeLines(t.badges), el("div", { class: "row" }, [el("button", { class: "btn", text: "Back", onclick: () => fxHome() })])].filter(Boolean))); }
    else if (inp.focus && !lgBusy) inp.focus();
  }
  async function lgTalkStart(c, scenario) {
    await fxBusy("Your partner is getting ready…", async () => {
      fxNeed(c);
      const p = FX.parseChat(await callGemini(FX.buildChatPrompt({ course: c, cefr: c.cefr, scenario, history: [] })), "");
      if (!p) throw new Error("The conversation could not start. Press the button again.");
      fxRun = { kind: "talk", scenario, history: [{ role: "partner", text: p.reply.target, roman: p.reply.roman, meaning: p.reply.meaning, suggestions: p.suggestions }], turns: 0, clean: 0, xp: 0, newMist: 0, done: false };
      lgMsg("");
    });
  }
  async function lgTalkSend(c) {
    const t = fxRun; if (!t || t.kind !== "talk" || t.done || lgBusy) return;
    const said = (lg("fx-say").value || "").trim(); if (!said) { lgMsg("Write something first."); return; }
    const msg = { role: "user", text: said, correction: null, checked: false }; t.history.push(msg);
    await fxBusy("", async () => {
      try {
        fxNeed(c);
        const p = FX.parseChat(await callGemini(FX.buildChatPrompt({ course: c, cefr: c.cefr, scenario: t.scenario, history: t.history.map((m) => ({ role: m.role, text: m.text })) })), said);
        if (!p) throw new Error("The reply could not be read. Your message was not sent; press Send again.");
        msg.checked = true; msg.correction = p.correction;
        t.turns += 1; let gain = 6; if (!p.correction) { t.clean += 1; gain += 4; }
        else if (p.correction.kind === "fix") { const before = fxOf(c).mistakes.length; FX.addMistake(fxOf(c).mistakes, said, p.correction.corrected, p.correction.why); if (fxOf(c).mistakes.length > before) t.newMist += 1; }
        t.xp += gain; lgGain(gain);
        t.history.push({ role: "partner", text: p.reply.target, roman: p.reply.roman, meaning: p.reply.meaning, suggestions: p.suggestions }); t.draft = "";
      } catch (e) { t.history.pop(); t.draft = said; throw e; }
    });
  }
  function lgTalkEnd(c) {
    const t = fxRun; if (!t || t.kind !== "talk" || t.done) return;
    if (t.turns === 0) { fxHome(); return; }
    t.done = true; state.lang.stats.convos += 1; fxOf(c).convos.push({ scenario: t.scenario.label, turns: t.turns, clean: t.clean, at: LG.dayKey() }); fxOf(c).convos = fxOf(c).convos.slice(-60);
    t.badges = lgGain(0); renderLang();
  }
  // practise saved mistakes
  function lgMistStart(c) {
    const items = FX.dueMistakes(fxOf(c).mistakes).slice(0, 8); if (!items.length) return;
    fxRun = { kind: "mist", ids: items.map((m) => m.id), i: 0, correct: 0, xp: 0, done: false, answered: false }; renderLang();
  }
  function lgMistView(box, c) {
    const t = fxRun, f = fxOf(c);
    if (t.done || t.i >= t.ids.length) { box.appendChild(el("div", { class: "tr-card", id: "fx-mist-sum" }, [el("h3", { text: "Practice finished" }), el("p", { text: `${t.correct} of ${t.ids.length} right. +${t.xp} XP.` }), ...badgeLines(t.badges), el("div", { class: "row" }, [el("button", { class: "btn", text: "Back", onclick: () => fxHome() })])])); return; }
    const m = f.mistakes.find((x) => x.id === t.ids[t.i]); if (!m) { t.i += 1; return lgMistView(box, c); }
    const card = el("div", { class: "tr-card", id: "fx-mist-card" });
    card.appendChild(el("div", { class: "small", role: "status", text: `Sentence ${t.i + 1} of ${t.ids.length}. This one has a mistake in it.` }));
    card.appendChild(el("div", { class: "lg-key" }, [tgt(m.said, c.tag)])); card.appendChild(el("div", { class: "lg-q", text: "Type the corrected sentence." }));
    const inp = el("input", { type: "text", id: "fx-answer", "aria-label": "The corrected sentence", autocomplete: "off", lang: c.tag || undefined, dir: "auto" }); card.appendChild(inp);
    const chk = el("button", { class: "btn", id: "fx-check", type: "button", text: "Check" }); card.appendChild(el("div", { class: "row" }, [chk]));
    const go = () => {
      if (!inp.value.trim()) { lgMsg("Type an answer first."); return; } const g = LG.gradeTyped(inp.value, [m.corrected]), ok = g.result !== "wrong"; inp.setAttribute("disabled", ""); chk.setAttribute("disabled", "");
      FX.recordMistake(m, ok); if (ok) { t.correct += 1; t.xp += 5; } saveLang();
      card.appendChild(el("div", { class: ok ? "lg-good" : "lg-bad", id: "fx-feedback", role: "status" }, [el("div", { text: ok ? "Correct." : "Not quite." }), ok ? null : el("div", {}, [document.createTextNode("Correct form: "), tgt(m.corrected, c.tag)]), m.why ? el("div", { class: "small", text: m.why }) : null].filter(Boolean)));
      const last = t.i + 1 >= t.ids.length;
      const nx = el("button", { class: "btn", id: "fx-next", type: "button", text: last ? "Finish" : "Continue", onclick: () => { t.i += 1; if (last) { t.done = true; t.badges = lgGain(t.xp); } else saveLang(); renderLang(); } }); card.appendChild(el("div", { class: "row" }, [nx, el("button", { class: "btn", type: "button", "aria-label": "Remove this mistake from my list", text: "Remove from list", onclick: () => { FX.removeMistake(f.mistakes, m.id); t.ids.splice(t.i, 1); if (t.i >= t.ids.length) { t.done = true; t.badges = lgGain(t.xp); } saveLang(); renderLang(); } })])); if (nx.focus) nx.focus();
    };
    chk.addEventListener("click", go); inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (!inp.disabled) go(); } });
    box.appendChild(card); if (inp.focus) inp.focus();
  }

  // ---- level check
  function lgCheckView(box, c) {
    const f = fxOf(c);
    if (!fxRun || fxRun.kind !== "check") {
      box.appendChild(el("p", { class: "small", style: "max-width:64ch", text: `A short check of about 12 questions on vocabulary, grammar and reading, a few below, at and above ${c.cefr}. It gives an indication of where you are, not a certificate: it is written by an AI, and a real exam or a teacher is the only real measure. Each question is solved blind by a second pass first, and any it disagrees with is left out.` }));
      box.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "fx-check-go", disabled: lgBusy ? "" : undefined, text: "Take a level check", onclick: () => lgCheckStart(c) })]));
      const h = f.checks.slice(-5).reverse(); if (h.length) box.appendChild(el("div", { class: "small", text: "Earlier checks: " + h.map((r) => `${r.at}: ${r.correct}/${r.total}, about ${r.est}`).join("; ") }));
      return;
    }
    const t = fxRun;
    if (t.done) {
      const r = t.result;
      const card = el("div", { class: "tr-card", id: "fx-check-sum" }, [el("h3", { text: `About ${r.est}` }), el("p", { text: r.note }), el("p", { class: "small", text: ["below", "at", "above"].map((k) => `${k === "at" ? "at your level" : k + " your level"}: ${t.res[k].correct}/${t.res[k].total}`).join("; ") + `. ${t.correct} of ${t.qs.length} right. +${t.xp} XP. This is an indication only.` }), ...badgeLines(t.badges)]);
      const row = el("div", { class: "row" });
      if (r.est !== c.cefr && r.verdict !== "unknown") row.appendChild(el("button", { class: "btn", id: "fx-setlevel", text: (LG.CEFR.indexOf(r.est) > LG.CEFR.indexOf(c.cefr) ? "Move up to " : "Set my level to ") + r.est, onclick: () => { if (LG.CEFR.indexOf(r.est) > LG.CEFR.indexOf(c.cefr)) state.lang.stats.ups += 1; c.cefr = r.est; lgGain(0); fxHome(); } }));
      row.appendChild(el("button", { class: "btn", text: "Keep my level", onclick: () => fxHome() })); card.appendChild(row); box.appendChild(card); return;
    }
    const q = t.qs[t.i];
    box.appendChild(fxChoiceCard(q, c.tag, (ok) => { const k = q.tier; t.res[k].total += 1; if (ok) { t.res[k].correct += 1; t.correct += 1; } t.i += 1; if (t.i >= t.qs.length) lgCheckFinish(c); else renderLang(); }, { head: `Question ${t.i + 1} of ${t.qs.length}`, last: t.i + 1 >= t.qs.length }));
  }
  async function lgCheckStart(c) {
    await fxBusy(`Writing a ${c.cefr} check…`, async () => {
      fxNeed(c);
      const qs = FX.parseLevel(await callGemini(FX.buildLevelPrompt({ course: c, cefr: c.cefr })), {});
      if (!qs) throw new Error("The check could not be read. Press the button again.");
      lgMsg("Having a second check solve each question…");
      const r = await fxBlindCheck(c, qs);
      const by = { below: 0, at: 0, above: 0 }; for (const q of r.kept) by[q.tier] += 1;
      if (r.kept.length < 9 || by.at < 3) throw new Error("Too many questions failed the check. Press the button again for a fresh one.");
      const ordered = ["below", "at", "above"].flatMap((k) => r.kept.filter((q) => q.tier === k));
      fxRun = { kind: "check", qs: ordered, i: 0, correct: 0, xp: 0, done: false, res: { below: { correct: 0, total: 0 }, at: { correct: 0, total: 0 }, above: { correct: 0, total: 0 } }, unreviewed: r.unreviewed };
      lgMsg(r.unreviewed ? "The second check could not run, so these questions are unchecked." : "");
    });
  }
  function lgCheckFinish(c) {
    const t = fxRun; t.done = true; t.result = FX.estimateLevel(c.cefr, t.res); t.xp = 30; state.lang.stats.checks += 1;
    fxOf(c).checks.push({ cefr: c.cefr, est: t.result.est, correct: t.correct, total: t.qs.length, at: LG.dayKey() }); fxOf(c).checks = fxOf(c).checks.slice(-30);
    t.badges = lgGain(t.xp); renderLang();
  }

  function wireLang() {
    if (!lg("view-lang") || !state.lang) return;
    if (!LG) { lgMsg("This tab needs web/lib/lang.js. Add it next to the other files in web/lib/, push, and refresh."); return; }
    const lv = lg("lg-level"); LG.LEVELS.forEach((l) => lv.appendChild(el("option", { value: l, text: l })));
    const gl = lg("lg-goal"); LG.GOALS.forEach((g) => gl.appendChild(el("option", { value: g.id, text: g.label })));
    lg("lg-create").addEventListener("click", lgCreate);
    lg("lg-learn").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); lgCreate(); } });
    renderLang();
  }

  // ---------------------------------------------------------------- training ground
  // A round is held in memory. What is kept between visits is the progress:
  // topic scores, past sessions and each target's readiness map.
  const TR = self.Training;
  let round = null, clockId = null, rec = null;
  const tq = (id) => document.getElementById(id);
  const saveTrain = () => lsSet(LS.train, state.train);
  const trMsg = (t) => { tq("tr-msg").textContent = t; };
  const trStory = () => [(state.styleText || "").trim().split(/\s+/).length >= 150 ? state.styleText.trim() : "", researchBlock() ? "MY OWN RESEARCH (digest of my theses):\n" + researchBlock() : ""].filter(Boolean).join("\n\n");
  const trFacts = () => [state.cvText, state.styleText, researchCorpus()].join("\n");

  function trTargets() {
    const t = [];
    // Rejected and withdrawn applications are over, so there is nothing to prepare for.
    const live = (r) => ["rejected", "withdrawn"].indexOf(r.status) < 0;
    for (const a of state.apps.filter(live)) t.push({ key: TR.targetKey("job", a.id), kind: "job", rec: a, label: `${a.title} at ${a.company}` });
    for (const p of state.phd.filter(live)) t.push({ key: TR.targetKey("phd", p.id), kind: "phd", rec: p, label: `PhD: ${p.programme} at ${p.university}` });
    return t;
  }
  const trCurrent = () => trTargets().find((t) => t.key === tq("tr-target").value) || null;

  function trNeed(t) {
    if (!TR) throw new Error("This tab needs web/lib/training.js. Add it next to the other files in web/lib/, push, and refresh.");
    if (!t) throw new Error("Save a role in My applications, or add a PhD programme, then pick it here.");
    if (!state.cvText.trim()) throw new Error("Upload or paste your CV first (left panel). The practice is checked against it.");
    const ctx = TR.contextFor(t.kind, t.rec);
    if (ctx.text.trim().length < 80 && !ctx.requirements.length) throw new Error("This one has no posting or advert text to practise against. Paste it into the record first.");
    return ctx;
  }

  function trSpeak(text) {
    if (!tq("tr-speak").checked || !self.speechSynthesis || !self.SpeechSynthesisUtterance) return;
    self.speechSynthesis.cancel();
    const u = new self.SpeechSynthesisUtterance(text); u.lang = "en-GB"; self.speechSynthesis.speak(u);
  }

  function trMic(ta) {
    const SR = self.SpeechRecognition || self.webkitSpeechRecognition;
    if (!SR) return null;
    const b = el("button", { class: "btn", type: "button", text: "Speak your answer", "aria-pressed": "false" });
    b.addEventListener("click", () => {
      if (rec) { rec.stop(); return; }
      rec = new SR(); rec.lang = "en-GB"; rec.continuous = true; rec.interimResults = false;
      rec.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) ta.value = (ta.value + " " + e.results[i][0].transcript).trim(); };
      rec.onend = () => { rec = null; b.textContent = "Speak your answer"; b.setAttribute("aria-pressed", "false"); };
      rec.onerror = (e) => trMsg("The microphone stopped (" + (e.error || "error") + "). You can type instead.");
      rec.start(); b.textContent = "Stop listening"; b.setAttribute("aria-pressed", "true");
    });
    return b;
  }

  function trStopClock() { if (clockId) { clearInterval(clockId); clockId = null; } if (rec) { try { rec.stop(); } catch (e) { /* already stopped */ } } }

  function trStartClock(onExpire) {
    trStopClock();
    if (!round || !round.seconds) return;
    const end = Date.now() + round.seconds * 1000;
    const tick = () => {
      const clock = tq("tr-clock"); if (!clock) return;
      const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      clock.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      clock.classList.toggle("low", left <= 20);
      if (left <= 0) { trStopClock(); onExpire(); }
    };
    clockId = setInterval(tick, 500); setTimeout(tick, 0);
  }


  // ---- learn first: a course written for the position
  let openLesson = null, lessonBusy = false;
  const trCourse = () => { const t = trCurrent(); return t ? state.train.lessons[t.key] : null; };

  async function trLearn() {
    try {
      const t = trCurrent(), ctx = trNeed(t);
      if (!state.train.lessons[t.key]) {
        trMsg("Planning your course…");
        const ready = (state.train.readiness[t.key] || {}).items || [];
        const items = TR.parseCurriculum(await callGemini(TR.buildCurriculumPrompt({ ctx, cv: state.cvText, story: trStory(), gaps: ready.filter((r) => r.status !== "strong").map((r) => r.requirement).slice(0, 6) })));
        if (items.length < 3) throw new Error("The course plan could not be read. Press the button again.");
        state.train.lessons[t.key] = { at: new Date().toISOString(), items };
        const keys = Object.keys(state.train.lessons);
        if (keys.length > 10) delete state.train.lessons[keys[0]];
        saveTrain();
      }
      openLesson = null;
      trMsg("Your course is below. Open a lesson, try the exercise before reading the solution, then test yourself on it.");
    } catch (e) { trMsg(e.message || String(e)); }
    renderTrain();
  }

  async function trOpenLesson(i) {
    if (lessonBusy) return;
    const t = trCurrent(), course = trCourse();
    if (!t || !course || !course.items[i]) return;
    const it = course.items[i];
    openLesson = i;
    if (!it.body) {
      lessonBusy = true;
      try {
        const ctx = trNeed(t);
        trMsg("Writing the lesson…"); renderLessons();
        const body = TR.parseLesson(await callGemini(TR.buildLessonPrompt({ ctx, cv: state.cvText, story: trStory(), topic: it.topic, why: it.why })), trFacts());
        if (!body) throw new Error("The lesson could not be read. Open it again.");
        trMsg("Having a second reviewer check the lesson for errors…");
        try { it.check = TR.parseCheck(await callGemini(TR.buildLessonCheckPrompt(body, it.topic))); } catch (e) { it.check = { ok: false, problems: ["It could not be reviewed."], unchecked: true }; }
        it.body = body; saveTrain(); trMsg("");
      } catch (e) { openLesson = null; trMsg(e.message || String(e)); }
      lessonBusy = false;
    }
    renderTrain();
  }

  function renderLessons() {
    const box = tq("tr-lessons"); if (!box) return; box.textContent = "";
    const course = trCourse(); if (!course) return;
    const pr = TR.lessonProgress(course.items);
    box.appendChild(el("h4", { text: `Your course: ${pr.studied} of ${pr.total} lessons studied` }));
    box.appendChild(el("p", { class: "small", style: "max-width:70ch", text: "Written by AI for this position from general knowledge, then checked by a second pass. It teaches the subject; it never says what you have done except by quoting your own CV. Confirm details against official documentation before relying on them." }));
    course.items.forEach((it, i) => {
      box.appendChild(el("div", { class: "tr-req" }, [el("div", {}, [
        el("span", { class: "tr-badge " + (it.studied ? "strong" : "thin"), text: it.studied ? "studied" : it.level }),
        el("button", { class: "btn", text: `${i + 1}. ${it.topic}`, "aria-expanded": openLesson === i ? "true" : "false", onclick: () => trOpenLesson(i) }),
      ]), el("div", { class: "small", text: it.why })]));
    });
    if (openLesson !== null && course.items[openLesson] && course.items[openLesson].body) box.appendChild(lessonCard(course.items[openLesson]));
    box.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", text: "Replan this course", onclick: () => { if (window.confirm("Replace this course with a new plan? Lessons you have opened are lost.")) { delete state.train.lessons[trCurrent().key]; saveTrain(); openLesson = null; trLearn(); } } })]));
  }

  function lessonCard(it) {
    const b = it.body, card = el("div", { class: "tr-card", id: "tr-lesson" });
    card.appendChild(el("h4", { text: it.topic }));
    if (it.check && !it.check.ok) card.appendChild(el("div", { class: "note", text: it.check.unchecked ? "This lesson could not be reviewed. Treat the details with care." : "The reviewer raised concerns, so check these points before relying on them: " + it.check.problems.join("; ") }));
    card.appendChild(el("p", { text: b.intro }));
    for (const para of b.explanation) card.appendChild(el("p", { text: para }));
    if (b.concepts.length) { card.appendChild(el("h5", { text: "Key terms" })); for (const c of b.concepts) card.appendChild(el("div", { class: "small" }, [el("strong", { text: c.term + ": " }), document.createTextNode(c.meaning)])); }
    if (b.example) { card.appendChild(el("h5", { text: "Worked example: " + b.example.title })); card.appendChild(el("pre", { class: "tr-art", text: b.example.artefact })); if (b.example.walkthrough) card.appendChild(el("p", { text: b.example.walkthrough })); }
    if (b.mistakes.length) { card.appendChild(el("h5", { text: "Common mistakes" })); card.appendChild(el("ul", {}, b.mistakes.map((m) => el("li", { text: m })))); }
    if (b.asked) { card.appendChild(el("h5", { text: "How this gets tested" })); card.appendChild(el("p", { text: b.asked })); }
    if (b.yourRecord) card.appendChild(el("div", { class: "note", text: "Already in your own record: “" + b.yourRecord + "”" }));
    if (b.exercise) {
      card.appendChild(el("h5", { text: "Try it first" })); card.appendChild(el("p", { text: b.exercise.task }));
      card.appendChild(el("textarea", { rows: "4", "aria-label": "Your attempt (not marked, for you only)", placeholder: "Write or sketch your attempt here before opening the solution. It is not saved or marked." }));
      card.appendChild(el("details", {}, [el("summary", { text: "Show the worked solution" }), el("p", { text: b.exercise.solution })]));
    }
    card.appendChild(el("h5", { text: "Check yourself: say the answer aloud, then open it" }));
    for (const c of b.selfCheck) card.appendChild(el("details", {}, [el("summary", { text: c.q }), el("p", { text: c.a })]));
    if (b.lookUp.length) card.appendChild(el("p", { class: "small", text: "Read next (search for): " + b.lookUp.join("; ") }));
    card.appendChild(el("div", { class: "row" }, [
      el("button", { class: "btn", id: "tr-studied", text: it.studied ? "Marked studied: undo" : "Mark as studied", onclick: () => { it.studied = !it.studied; saveTrain(); renderTrain(); } }),
      el("button", { class: "btn", id: "tr-lesson-test", text: "Test me on this lesson", onclick: () => trStart("quiz", false, it.topic) }),
      el("button", { class: "btn", text: "Close lesson", onclick: () => { openLesson = null; renderTrain(); } }),
    ]));
    return card;
  }

  // ---- readiness map
  async function trReadiness() {
    try {
      const t = trCurrent(), ctx = trNeed(t);
      trMsg("Comparing the posting with your record…");
      const raw = await callGemini(TR.buildReadinessPrompt({ ctx, cv: state.cvText, story: trStory() }));
      const items = TR.parseReadiness(raw, trFacts());
      if (!items.length) throw new Error("The requirements the AI returned could not be read. Try again.");
      state.train.readiness[t.key] = { items, at: new Date().toISOString() };
      saveTrain(); trMsg(`Readiness map built: ${TR.readinessScore(items)}% ready on paper. Each quote shown was found in your own text.`);
    } catch (e) { trMsg(e.message || String(e)); }
    renderTrain();
  }

  function renderReadiness() {
    const box = tq("tr-ready"); box.textContent = "";
    const t = trCurrent(); const r = t && state.train.readiness[t.key];
    if (!r) return;
    box.appendChild(el("h4", { text: `Readiness: ${TR.readinessScore(r.items)}%` }));
    box.appendChild(el("p", { class: "small", text: "How well your own record shows what this asks for. Strong needs a quote from your CV or background; thin means related experience only; missing means nothing written down. This is a mirror of your record, not a prediction." }));
    for (const x of r.items) {
      const row = el("div", { class: "tr-req" }, [
        el("div", {}, [el("span", { class: "tr-badge " + x.status, text: x.status }), el("strong", { text: x.requirement }), document.createTextNode(x.importance === "nice" ? " (nice to have)" : "")]),
      ]);
      if (x.evidence) row.appendChild(el("div", { class: "small", text: "✓ “" + x.evidence + "”" }));
      else if (x.unverified) row.appendChild(el("div", { class: "small", text: "The quote offered for this was not found in your text, so it is not counted." }));
      if (x.plan) row.appendChild(el("div", { class: "small", text: "Practise: " + x.plan }));
      box.appendChild(row);
    }
  }

  // ---- starting a round
  async function trStart(mode, drill, only) {
    try {
      if (round && !round.finished && !window.confirm("Leave the round in progress? Answers already marked are kept.")) return;
      const t = trCurrent(), ctx = trNeed(t);
      if (mode === "defence" && t.kind !== "phd") throw new Error("Proposal defence is for PhD programmes. Pick one from the list.");
      if (mode === "defence" && !ctx.proposal.trim()) throw new Error("Write or paste the research proposal for this programme first (PhD tab), so there is something to defend.");
      trStopClock(); round = null; renderTrainStage();
      const ready = (state.train.readiness[t.key] || {}).items || [];
      const focus = only ? [only] : TR.focusTopics(state.train, ready, drill ? 3 : 2);
      if (drill && !focus.length) throw new Error("No weak spots yet. Do a round first, or build the readiness map, and they will show up here.");
      const asked = state.train.sessions.filter((s) => s.target === t.key).flatMap((s) => s.items.map((i) => i.question)).slice(0, 20);
      const opts = { mode, ctx, cv: state.cvText, story: trStory(), focus, gaps: ready.filter((r) => r.status !== "strong").map((r) => r.requirement).slice(0, 6), asked, difficulty: tq("tr-level").value, count: only ? 5 : TR.MODES[mode].count, only: !!only };
      trMsg(mode === "challenge" ? "Writing practical tasks, then having each one checked…" : "Writing your questions…");
      let items, flagged = false;
      if (mode === "challenge") {
        items = TR.parseChallenges(await callGemini(TR.buildChallengePrompt(opts)));
        await Promise.all(items.map(async (it) => { try { it.check = TR.parseCheck(await callGemini(TR.buildChallengeCheckPrompt(it))); } catch (e) { it.check = { ok: false, problems: ["Could not be checked."], unchecked: true }; } }));
        const good = items.filter((i) => i.check.ok);
        if (good.length) items = good; else flagged = items.length > 0;
      } else {
        items = TR.parseItems(mode, await callGemini(TR.buildQuestionsPrompt(opts)));
      }
      if (!items.length) throw new Error("The AI's questions could not be read. Press the button again.");
      items.forEach((it, i) => { it.id = i; it.turns = [{ q: it.question, a: "", grade: null }]; it.done = false; it.reported = false; it.choice = null; });
      round = { target: t.key, kind: t.kind, mode, level: opts.difficulty, items, idx: 0, seconds: parseInt(tq("tr-timer").value, 10) || 0, busy: false, flagged, label: t.label };
      trMsg(`${TR.MODES[mode].label}: ${items.length} item${items.length === 1 ? "" : "s"}${focus.length ? ", aimed at " + focus.join(", ") : ""}.`);
    } catch (e) { trMsg(e.message || String(e)); }
    renderTrain();
  }

  // ---- the round on screen
  function curItem() { return round.items[round.idx]; }
  const lastTurn = (it) => it.turns[it.turns.length - 1];

  function renderTrainStage() {
    const box = tq("tr-stage"); box.textContent = "";
    trStopClock();
    if (!round) return;
    if (round.finished) return renderTrainSummary(box);
    const it = curItem(), total = round.items.length;
    const card = el("div", { class: "tr-card" }, [el("h4", { text: `${TR.MODES[round.mode].label}: ${round.idx + 1} of ${total} · ${it.topic}` })]);
    if (round.flagged && it.mode === "challenge") card.appendChild(el("div", { class: "quality-warn", text: "The automatic check could not confirm this task is sound, so treat the reference answer with care." }));
    if (it.mode === "challenge") {
      card.appendChild(el("div", { text: it.title, style: "font-weight:700" }));
      card.appendChild(el("p", { text: it.scenario }));
      card.appendChild(el("pre", { class: "tr-art", text: it.artefact }));
      card.appendChild(el("p", { text: it.task, style: "font-weight:700" }));
    } else if (it.mode === "quiz") {
      card.appendChild(el("p", { text: it.question, style: "font-weight:700" }));
    }
    if (it.mode === "quiz") {
      if (!it.done) {
        it.options.forEach((o, i) => {
          const id = `tr-opt-${i}`;
          const r = el("input", { type: "radio", name: "tr-opt", id, value: String(i) });
          if (it.choice === i) r.checked = true;
          r.addEventListener("change", () => { it.choice = i; });
          card.appendChild(el("div", { class: "tr-opt" }, [r, el("label", { for: id, style: "margin:0;color:var(--carbon)", text: o })]));
        });
        card.appendChild(el("div", { class: "row" }, [el("span", { id: "tr-clock", class: "tr-clock" }), el("button", { class: "btn", id: "tr-submit", text: "Lock in answer", onclick: () => trQuizSubmit() })]));
        trStartClock(() => trQuizSubmit());
        trSpeak(it.question);
      } else {
        const g = TR.gradeQuiz(it, it.choice);
        it.options.forEach((o, i) => card.appendChild(el("div", { class: "tr-opt", text: `${i === it.answer ? "✓" : i === it.choice ? "✗" : "·"} ${o}` })));
        card.appendChild(el("div", { class: g.correct ? "note" : "quality-warn", text: (g.correct ? "Correct. " : it.choice === null ? "Time ran out. " : "Not quite. ") + it.explanation }));
        card.appendChild(el("div", { class: "row" }, [
          el("button", { class: "btn", id: "tr-next", text: round.idx + 1 < total ? "Next" : "Finish", onclick: trAdvance }),
          el("button", { class: "btn", id: "tr-report", text: it.reported ? "Reported (not counted)" : "This question is wrong", onclick: () => { it.reported = true; renderTrainStage(); } }),
        ]));
      }
    } else {
      const turn = lastTurn(it);
      if (it.turns.length > 1) {
        for (const tt of it.turns.slice(0, -1)) { card.appendChild(el("div", { class: "small", text: "Interviewer: " + tt.q })); card.appendChild(el("div", { class: "small", text: "You: " + (tt.a || "(no answer)") })); }
      }
      if (it.mode !== "challenge") card.appendChild(el("p", { class: it.turns.length > 1 ? "tr-push" : "", text: turn.q, style: it.turns.length > 1 ? "" : "font-weight:700" }));
      else if (it.turns.length > 1) card.appendChild(el("p", { class: "tr-push", text: turn.q }));
      if (!it.done) {
        const ta = el("textarea", { id: "tr-answer", "aria-label": "Your answer", placeholder: it.mode === "challenge" ? "What is wrong, why, and how you would fix it" : "Answer as you would in the room", style: "min-height:130px" });
        ta.value = turn.draft || "";
        ta.addEventListener("input", () => { turn.draft = ta.value; });
        card.appendChild(ta);
        const row = el("div", { class: "row" }, [el("span", { id: "tr-clock", class: "tr-clock" })]);
        const mic = trMic(ta); if (mic) row.appendChild(mic);
        row.appendChild(el("button", { class: "btn", id: "tr-submit", text: round.busy ? "Marking…" : "Submit answer", onclick: () => trSubmit(false, false) }));
        row.appendChild(el("button", { class: "btn", id: "tr-skip", text: "I don't know", onclick: () => trSubmit(false, true) }));
        card.appendChild(row);
        if (round.busy) card.querySelectorAll("button").forEach((b) => b.setAttribute("disabled", ""));
        else { trStartClock(() => trSubmit(true, false)); trSpeak(turn.q); }
      } else {
        renderItemReview(card, it);
      }
    }
    box.appendChild(card);
  }

  function renderItemReview(card, it) {
    card.appendChild(el("p", { text: `Score for this item: ${it.score}/10`, style: "font-weight:700" }));
    it.turns.forEach((tt, i) => {
      const g = tt.grade; if (!g) return;
      const d = el("div", { class: "small", style: "margin:6px 0" });
      d.appendChild(el("div", { text: (it.turns.length > 1 ? (i === 0 ? "First answer: " : `After pushback ${i}: `) : "") + g.verdict + ` (${g.score}/10)` }));
      if (g.strengths.length) d.appendChild(el("div", { text: "Good: " + g.strengths.join("; ") }));
      if (g.gaps.length) d.appendChild(el("div", { text: "Weak: " + g.gaps.join("; ") }));
      card.appendChild(d);
    });
    const lg = lastTurn(it).grade;
    if (lg && lg.biggestFix) card.appendChild(el("div", { class: "note", text: "The one change that would help most: " + lg.biggestFix }));
    const answers = it.turns.map((tt) => tt.a).join("\n");
    const flags = TR.honestyFlags(answers, trFacts());
    const claims = it.turns.flatMap((tt) => (tt.grade ? tt.grade.unsupportedClaims : []));
    if (flags.length || claims.length) {
      card.appendChild(el("div", { class: "quality-warn" }, [
        el("div", { text: "Check these before you say them in a real interview. They are not in your CV or your written background, so you could be asked to back them up:" }),
        el("ul", {}, flags.map((f) => el("li", { text: "figure: " + f })).concat(claims.map((c) => el("li", { text: c })))),
      ]));
    }
    if (it.mode === "challenge") {
      const d = el("details", {}, [el("summary", { text: "Reference answer" }), el("div", { class: "small", text: "Findings: " + it.reference.findings.join("; ") }), el("div", { class: "small", text: "Fix: " + it.reference.fix }), el("div", { class: "small", text: it.reference.explanation })]);
      card.appendChild(d);
    }
    if (lg && lg.modelAnswer) card.appendChild(el("details", {}, [el("summary", { text: "What a strong answer looks like" }), el("div", { class: "small", style: "white-space:pre-wrap", text: lg.modelAnswer })]));
    card.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "tr-next", text: round.idx + 1 < round.items.length ? "Next" : "Finish", onclick: trAdvance })]));
  }

  async function trSubmit(timedOut, skip) {
    if (!round || round.busy) return;
    const it = curItem(), turn = lastTurn(it), ta = tq("tr-answer");
    turn.a = skip ? "" : (ta ? ta.value.trim() : turn.draft || "");
    round.busy = true; trStopClock(); renderTrainStage();
    try {
      const t = trCurrent() || trTargets().find((x) => x.key === round.target);
      const ctx = TR.contextFor(t.kind, t.rec);
      const left = skip || timedOut ? 0 : TR.MODES[round.mode].followups - (it.turns.length - 1);
      const g = TR.parseGrade(await callGemini(TR.buildGradePrompt({ item: it, turns: it.turns.map((x) => ({ q: x.q, a: x.a })), ctx, cv: state.cvText, story: trStory(), followupsLeft: left, timedOut })));
      if (!g) throw new Error("The marking could not be read. Press Submit again.");
      turn.grade = g;
      if (g.followUp && left > 0) it.turns.push({ q: g.followUp, a: "", grade: null });
      else { it.done = true; it.score = TR.itemScore(it.turns); }
      trMsg("");
    } catch (e) { trMsg(e.message || String(e)); }
    round.busy = false; renderTrainStage();
  }

  function trQuizSubmit() {
    if (!round) return;
    const it = curItem(); if (it.done) return;
    trStopClock(); it.done = true; it.score = TR.gradeQuiz(it, it.choice).score; renderTrainStage();
  }

  function trAdvance() {
    const it = curItem();
    if (!it.reported && Number.isFinite(it.score)) TR.recordItem(state.train, { topic: it.topic, score: it.score, at: new Date().toISOString() });
    saveTrain();
    if (round.idx + 1 < round.items.length) { round.idx += 1; }
    else {
      round.finished = true;
      const used = round.items.filter((i) => !i.reported);
      const sum = TR.roundSummary(used);
      round.summary = sum;
      TR.addSession(state.train, { id: String(Date.now()), at: new Date().toISOString(), target: round.target, label: round.label, mode: round.mode, level: round.level, avg: sum.avg, items: used });
      saveTrain();
    }
    renderTrain();
  }

  function renderTrainSummary(box) {
    const s = round.summary;
    const card = el("div", { class: "tr-card" }, [el("h4", { text: `${TR.MODES[round.mode].label} finished: ${s.avg}/10 over ${s.count} item${s.count === 1 ? "" : "s"}` })]);
    for (const x of s.byTopic) card.appendChild(el("div", { class: "small" }, [document.createTextNode(`${x.topic}: ${x.avg}/10`), el("div", { class: "tr-bar" }, [el("i", { style: `width:${x.avg * 10}%` })])]));
    if (s.worst && s.count > 1) card.appendChild(el("div", { class: "note", text: `Weakest this round: ${s.worst.topic}. "Drill my weak spots" will aim there next.` }));
    card.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "tr-again", text: "Another round", onclick: () => { const m = round.mode; round = null; trStart(m, false); } }), el("button", { class: "btn", text: "Close", onclick: () => { round = null; renderTrain(); } })]));
    box.appendChild(card);
  }

  function renderTrainProgress() {
    const box = tq("tr-progress"); box.textContent = "";
    const topics = Object.values(state.train.topics);
    if (!topics.length && !state.train.sessions.length) return;
    box.appendChild(el("h4", { text: "Your practice so far", style: "margin-top:16px" }));
    for (const t of topics.sort((a, b) => a.sum / a.n - b.sum / b.n)) {
      const a = Math.round((t.sum / t.n) * 10) / 10;
      box.appendChild(el("div", { class: "small", style: "max-width:520px" }, [document.createTextNode(`${t.name}: ${a}/10 over ${t.n} (last ${t.last})`), el("div", { class: "tr-bar" }, [el("i", { style: `width:${a * 10}%` })])]));
    }
    const rec5 = state.train.sessions.slice(0, 5);
    if (rec5.length) box.appendChild(el("div", { class: "small", style: "margin-top:8px", text: "Recent rounds: " + rec5.map((s) => `${(s.at || "").slice(0, 10)} ${TR.MODES[s.mode] ? TR.MODES[s.mode].label : s.mode} ${s.avg}/10`).join(" · ") }));
    box.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "tr-clear", text: "Clear my practice history", onclick: () => { if (window.confirm("Delete all practice scores and readiness maps?")) { state.train = TR.newStats(); openLesson = null; saveTrain(); round = null; renderTrain(); } } })]));
  }

  let nlMounted = false;
  function renderTrain() {
    if (!tq("tr-target")) return;
    if (!nlMounted && tq("nl-host") && window.Netlabui) { nlMounted = true; window.Netlabui.mount(tq("nl-host"), { el, lsGet, lsSet }); }
    const sel = tq("tr-target"), keep = sel.value;
    sel.textContent = "";
    const ts = trTargets();
    if (!ts.length) sel.appendChild(el("option", { value: "", text: "Nothing saved yet: add a role or a PhD programme first" }));
    for (const t of ts) sel.appendChild(el("option", { value: t.key, text: t.label }));
    if (ts.some((t) => t.key === keep)) sel.value = keep;
    const cur = trCurrent();
    tq("tr-m-defence").hidden = !cur || cur.kind !== "phd";
    tq("tr-speak-wrap").style.display = self.speechSynthesis && self.SpeechSynthesisUtterance ? "flex" : "none";
    renderLessons(); renderReadiness(); renderTrainStage(); renderTrainProgress();
  }

  function wireTrain() {
    if (!tq("tr-target")) return;
    tq("tr-target").addEventListener("change", () => { openLesson = null; if (round && round.target !== tq("tr-target").value && !window.confirm("Leave the round in progress?")) { tq("tr-target").value = round.target; return; } if (round) { round = null; } renderTrain(); });
    tq("tr-m-learn").addEventListener("click", trLearn);
    tq("tr-m-ready").addEventListener("click", trReadiness);
    for (const m of ["interview", "challenge", "quiz", "defence"]) tq("tr-m-" + m).addEventListener("click", () => trStart(m, false));
    tq("tr-m-drill").addEventListener("click", () => trStart("interview", true));
  }

  // ------------------------------------------------ merge and split PDFs
  // Held in memory only: documents are personal and large, so they are never
  // written to browser storage.
  const docs = { merge: [], split: null };
  const dq = (id) => document.getElementById(id);
  const toolsReady = () => !!(self.PDFLib && self.PdfTools);

  function docMsg(id, text) { dq(id).textContent = text; }

  function renderDocs() {
    const miss = dq("dc-missing");
    miss.hidden = toolsReady();
    if (!toolsReady()) miss.textContent = "This tool needs web/lib/pdf-lib.min.js and web/lib/pdftools.js. Add them next to the other files in web/lib/, push, and refresh.";
    const ul = dq("dc-merge-list"); ul.textContent = "";
    docs.merge.forEach((f, i) => {
      const move = (d) => () => { const j = i + d; if (j < 0 || j >= docs.merge.length) return; [docs.merge[i], docs.merge[j]] = [docs.merge[j], docs.merge[i]]; renderDocs(); };
      ul.appendChild(el("li", {}, [
        el("span", { class: "nm", text: `${i + 1}. ${f.name}` }),
        el("span", { class: "small", text: `${self.PdfTools ? self.PdfTools.sizeLabel(f.bytes.length) : ""}${f.pages ? ` · ${f.pages} page${f.pages === 1 ? "" : "s"}` : " · image"}` }),
        el("button", { class: "btn", text: "Up", "aria-label": `Move ${f.name} up`, onclick: move(-1) }),
        el("button", { class: "btn", text: "Down", "aria-label": `Move ${f.name} down`, onclick: move(1) }),
        el("button", { class: "btn", text: "Remove", "aria-label": `Remove ${f.name}`, onclick: () => { docs.merge.splice(i, 1); renderDocs(); } }),
      ]));
    });
    if (docs.merge.length) {
      const total = docs.merge.reduce((n, f) => n + f.bytes.length, 0);
      ul.appendChild(el("li", {}, [el("span", { class: "small", text: `${docs.merge.length} file${docs.merge.length === 1 ? "" : "s"}, ${self.PdfTools.sizeLabel(total)} before merging.` })]));
    }
    dq("dc-split-info").textContent = docs.split ? `${docs.split.name}: ${docs.split.pages} page${docs.split.pages === 1 ? "" : "s"}, ${self.PdfTools.sizeLabel(docs.split.bytes.length)}.` : "";
  }

  async function readFile(file) { return new Uint8Array(await file.arrayBuffer()); }

  async function addMergeFiles(fileList) {
    if (!toolsReady()) { renderDocs(); return; }
    const T = self.PdfTools; const problems = []; let added = 0;
    for (const file of fileList) {
      if (!T.isPdf(file.name, file.type) && !T.isImage(file.name, file.type)) { problems.push(`"${file.name}" is not a PDF, JPG or PNG. Convert it to PDF first (in Word: File, Save as PDF).`); continue; }
      try {
        const bytes = await readFile(file);
        const pages = T.isPdf(file.name, file.type) ? await T.pageCount(self.PDFLib, bytes, file.name) : 0;
        docs.merge.push({ name: file.name, type: file.type, bytes, pages }); added++;
      } catch (e) { problems.push(e.message || String(e)); }
    }
    renderDocs();
    docMsg("dc-merge-msg", [added ? `Added ${added} file${added === 1 ? "" : "s"}.` : "", ...problems].filter(Boolean).join(" "));
  }

  async function mergeNow() {
    if (!toolsReady()) { renderDocs(); return; }
    const T = self.PdfTools;
    try {
      docMsg("dc-merge-msg", "Merging…");
      const out = await T.merge(self.PDFLib, docs.merge);
      const name = (T.stem(dq("dc-merge-name").value) || "application-pack") + ".pdf";
      downloadBlob(new Blob([out], { type: "application/pdf" }), name);
      const pages = (await self.PDFLib.PDFDocument.load(out)).getPageCount();
      docMsg("dc-merge-msg", `Downloaded ${name}: ${pages} page${pages === 1 ? "" : "s"}, ${T.sizeLabel(out.length)}. ${T.limitAdvice(out.length, dq("dc-merge-limit").value)} Open it once and check the order before you upload.`.replace(/\s+/g, " "));
    } catch (e) { docMsg("dc-merge-msg", e.message || String(e)); }
  }

  async function loadSplit(file) {
    if (!file) return;
    if (!toolsReady()) { renderDocs(); return; }
    try {
      const bytes = await readFile(file);
      const pages = await self.PdfTools.pageCount(self.PDFLib, bytes, file.name);
      docs.split = { name: file.name, bytes, pages };
      docMsg("dc-split-msg", "");
    } catch (e) { docs.split = null; docMsg("dc-split-msg", e.message || String(e)); }
    renderDocs();
  }

  async function splitNow() {
    if (!toolsReady()) { renderDocs(); return; }
    const T = self.PdfTools;
    if (!docs.split) { docMsg("dc-split-msg", "Choose a PDF first."); return; }
    const r = T.parseRanges(dq("dc-split-ranges").value, docs.split.pages);
    if (r.error) { docMsg("dc-split-msg", r.error); return; }
    try {
      const mode = dq("dc-split-mode").value;
      const names = T.splitNames(docs.split.name, r.ranges, mode);
      if (mode === "one") {
        const out = await T.extract(self.PDFLib, docs.split.bytes, T.pagesOf(r.ranges), docs.split.name);
        downloadBlob(new Blob([out], { type: "application/pdf" }), names[0]);
        docMsg("dc-split-msg", `Downloaded ${names[0]}: ${T.pagesOf(r.ranges).length} page${T.pagesOf(r.ranges).length === 1 ? "" : "s"}, ${T.sizeLabel(out.length)}.`);
      } else {
        const files = [];
        for (let i = 0; i < r.ranges.length; i++) files.push({ path: names[i], content: await T.extract(self.PDFLib, docs.split.bytes, T.pagesOf([r.ranges[i]]), docs.split.name) });
        if (files.length === 1) { downloadBlob(new Blob([files[0].content], { type: "application/pdf" }), files[0].path); }
        else downloadBlob(new Blob([self.Zip.build(files)], { type: "application/zip" }), T.stem(docs.split.name) + "-split.zip");
        docMsg("dc-split-msg", `Downloaded ${files.length} PDF${files.length === 1 ? "" : "s"}${files.length > 1 ? " in a zip" : ""}: ${names.join(", ")}.`);
      }
    } catch (e) { docMsg("dc-split-msg", e.message || String(e)); }
  }

  function wireDocs() {
    dq("dc-merge-files").addEventListener("change", async (e) => { const l = [...e.target.files]; e.target.value = ""; await addMergeFiles(l); });
    dq("dc-merge-go").addEventListener("click", mergeNow);
    dq("dc-merge-clear").addEventListener("click", () => { docs.merge = []; docMsg("dc-merge-msg", ""); renderDocs(); });
    dq("dc-split-file").addEventListener("change", (e) => loadSplit(e.target.files[0]));
    dq("dc-split-go").addEventListener("click", splitNow);
  }

  document.addEventListener("DOMContentLoaded", () => {
    // A file left out of an update would otherwise break the whole page with a
    // cryptic error. Say which one is missing instead.
    const files = { Applications: "lib/applications.js", Zip: "lib/zip.js", Phd: "lib/phd.js", Proposal: "lib/proposal.js" };
    const missing = Object.keys(files).filter((k) => !self[k]).map((k) => "web/" + files[k]);
    if (missing.length) { showFatal("This page is missing " + missing.join(" and ") + ". Add " + (missing.length > 1 ? "them" : "it") + " to the repository next to the other files in web/lib/, push, and refresh."); return; }
    wireControls();
    wireDocs();
    wireTrain(); wireProfile(); wireResearch(); wireLang();
    document.getElementById("aq-go").addEventListener("click", aqWrite);
    document.getElementById("aq-role").addEventListener("change", aqFill);
    loadData();
  });
})();
