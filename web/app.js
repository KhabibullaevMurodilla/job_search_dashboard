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

  const LS = {
    cv: "jr_cv_text",
    cvMeta: "jr_cv_meta",
    geminiKey: "jr_gemini_key",
    status: "jr_role_status",     // {uid: "applied"|"skipped"}
    drafts: "jr_drafts",          // {uid: {cv, coverLetter}}
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
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { console.warn("could not save to this browser's storage:", e); }
  }

  const state = {
    roles: [],
    registers: [],
    cvText: lsGet(LS.cv, ""),
    statusByUid: lsGet(LS.status, {}),
    drafts: lsGet(LS.drafts, {}),
    evalCache: new Map(),   // uid -> evaluateJob() result, recomputed when CV changes
    filters: { search: "", minScore: 0, workMode: "any", country: "any", status: "all" },
    sortBy: "score",
    rateCvSkillText: null,  // fetched once, lazily, only when a CV draft is requested
  };

  // --------------------------------------------------------------- data
  async function loadData() {
    const [rolesRes, registersRes] = await Promise.all([
      fetch("./roles.json").catch(() => null),
      fetch("./registers.json").catch(() => null),
    ]);
    if (!rolesRes || !rolesRes.ok) {
      showFatal("Could not load roles.json. If you're running this locally "
        + "rather than from the published Pages site, the data files won't "
        + "exist until a scan has run.");
      return;
    }
    const data = await rolesRes.json();
    state.roles = (data.new || []).concat(data.seen || []);
    state.meta = data.meta || {};
    if (registersRes && registersRes.ok) {
      state.registers = DC.registersFromJson(await registersRes.json());
    }
    evaluateAll();
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

  async function getRateCvSkillText() {
    if (state.rateCvSkillText !== null) return state.rateCvSkillText;
    try {
      const [skillRes, rubricRes, craftRes] = await Promise.all([
        fetch("./skills/rate-cv/SKILL.md"),
        fetch("./skills/rate-cv/references/rubric.md"),
        fetch("./skills/rate-cv/references/craft.md"),
      ]);
      const parts = [];
      for (const [label, res] of [["SKILL.md", skillRes],
        ["references/rubric.md", rubricRes],
        ["references/craft.md", craftRes]]) {
        if (res && res.ok) parts.push(`--- rate-cv/${label} ---\n${await res.text()}`);
      }
      state.rateCvSkillText = parts.join("\n\n");
    } catch (e) {
      state.rateCvSkillText = "";
    }
    return state.rateCvSkillText;
  }

  async function draftCv(role) {
    if (!state.cvText.trim()) {
      throw new Error("Paste your CV first, in the box above the role list.");
    }
    const skillText = await getRateCvSkillText();
    const prompt = DC.buildCvPrompt(role, state.cvText, skillText);
    const draft = await callGemini(prompt);
    const q = DC.qualityCheckCv(draft, 400, 950);
    state.drafts[role.uid] = Object.assign({}, state.drafts[role.uid], { cv: draft });
    lsSet(LS.drafts, state.drafts);
    return { draft, quality: q };
  }

  async function draftCoverLetter(role) {
    const existing = state.drafts[role.uid] && state.drafts[role.uid].cv;
    if (!existing) {
      throw new Error("Draft the CV for this role first -- the letter is "
        + "checked against it so the two don't repeat each other.");
    }
    const prompt = DC.buildCoverLetterPrompt(role, existing, state.cvText);
    const draft = await callGemini(prompt);
    const q = DC.qualityCheckCoverLetter(draft, existing);
    state.drafts[role.uid] = Object.assign({}, state.drafts[role.uid], { coverLetter: draft });
    lsSet(LS.drafts, state.drafts);
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
    actions.appendChild(el("button", { class: "btn", onclick: () => openDraftModal(role, "cv"), text: "Draft CV" }));
    actions.appendChild(el("button", { class: "btn", onclick: () => openDraftModal(role, "cover_letter"), text: "Draft cover letter" }));
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

    if (sponsor.reason) {
      body.appendChild(el("div", { class: "role-reason", text: sponsor.reason }));
    }
    card.appendChild(body);
    return card;
  }

  function setStatus(uid, status) {
    if (status === "new") delete state.statusByUid[uid];
    else state.statusByUid[uid] = status;
    lsSet(LS.status, state.statusByUid);
    render();
  }

  function render() {
    const list = document.getElementById("role-list");
    list.innerHTML = "";
    const filtered = DC.filterRoles(state.roles, state.filters, state.statusByUid);
    const sorted = DC.sortRoles(filtered, state.sortBy);
    document.getElementById("role-count").textContent =
      `${sorted.length} of ${state.roles.length} roles`;
    for (const role of sorted) list.appendChild(renderRoleCard(role));
    if (!sorted.length) {
      list.appendChild(el("div", { class: "empty", text: "No roles match the current filters." }));
    }
  }

  // ------------------------------------------------------------- modal
  function openDraftModal(role, kind) {
    const modal = document.getElementById("modal");
    const body = document.getElementById("modal-body");
    const title = kind === "cv" ? `CV draft — ${role.title}` : `Cover letter draft — ${role.title}`;
    document.getElementById("modal-title").textContent = title;
    body.innerHTML = "";
    body.appendChild(el("div", { class: "modal-status", text: "Drafting with Gemini… this calls the API directly from your browser with your own key." }));
    modal.classList.add("open");

    const run = kind === "cv" ? draftCv(role) : draftCoverLetter(role);
    run.then(({ draft, quality }) => {
      body.innerHTML = "";
      if (!quality.ok) {
        body.appendChild(el("div", { class: "quality-warn" }, [
          el("div", { text: "This draft did not clear every check (lighter checks than the local job-radar tool runs -- see the note below):" }),
          el("ul", {}, quality.problems.map((p) => el("li", { text: p }))),
        ]));
      }
      const pre = el("pre", { class: "draft-text", text: draft });
      body.appendChild(pre);
      const actions = el("div", { class: "modal-actions" });
      actions.appendChild(el("button", { class: "btn", onclick: () => copyText(draft), text: "Copy" }));
      actions.appendChild(el("button", { class: "btn", onclick: () => downloadText(draft, `${kind}-${role.uid}.md`), text: "Download .md" }));
      body.appendChild(actions);
    }).catch((err) => {
      body.innerHTML = "";
      body.appendChild(el("div", { class: "fatal", text: err.message || String(err) }));
    });
  }

  function closeModal() {
    document.getElementById("modal").classList.remove("open");
  }

  function copyText(text) {
    navigator.clipboard && navigator.clipboard.writeText(text).catch(() => {});
  }

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
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

  // ------------------------------------------------------------- setup
  function wireControls() {
    const cvBox = document.getElementById("cv-text");
    cvBox.value = state.cvText;
    document.getElementById("cv-save").addEventListener("click", () => {
      state.cvText = cvBox.value;
      lsSet(LS.cv, state.cvText);
      evaluateAll();
      render();
    });
    document.getElementById("cv-clear").addEventListener("click", () => {
      cvBox.value = "";
      state.cvText = "";
      lsSet(LS.cv, "");
      evaluateAll();
      render();
    });
    document.getElementById("cv-file").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      if (file.name.toLowerCase().endsWith(".pdf")) {
        const text = await extractPdfText(await file.arrayBuffer());
        cvBox.value = text.replace(/\s+/g, " ").trim();
      } else {
        cvBox.value = await file.text();
      }
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
    document.getElementById("modal-close").addEventListener("click", closeModal);
    document.getElementById("modal").addEventListener("click", (e) => {
      if (e.target.id === "modal") closeModal();
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    wireControls();
    loadData();
  });
})();
