/*
 * Runs on every page (a few noisy domains excluded in the manifest), but
 * only ever shows a badge when it is confident it is looking at an actual
 * job posting -- confirmed by structured data whenever the page has it,
 * bespoke selectors for the couple of boards big enough to be worth it, or
 * (via the toolbar button) a one-off manual check of whatever page you're
 * on, since a small in-house ATS with no schema.org markup deserves the
 * same answer, just not uninvited.
 */
(function () {
  "use strict";

  if (window.__sponsorCheckInjected) return;
  window.__sponsorCheckInjected = true;

  // A one-line, unmistakable marker in the page console -- open DevTools
  // (F12) on a job page and search for "[Sponsor Check]" to confirm the
  // content script is actually running at all before troubleshooting
  // anything about what it finds or how it looks. Every log this file
  // makes below is prefixed the same way, on purpose.
  console.log("[Sponsor Check] content script loaded on", location.href);

  const HOST = location.hostname;

  // ------------------------------------------------------------------
  // Extraction
  // ------------------------------------------------------------------
  function textOf(el) {
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  }

  function stripHtml(html) {
    const d = document.createElement("div");
    d.innerHTML = html || "";
    return d.textContent.replace(/\s+/g, " ").trim();
  }

  // schema.org JobPosting, however deeply it's nested in a @graph -- this is
  // what Greenhouse, Lever, Workable, SmartRecruiters, Workday and most
  // other ATS platforms already emit for Google's own job-search indexing,
  // so reading it is reading the same structured answer they already give
  // search engines, not guessing at page layout.
  function findJobPostingLd() {
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const s of scripts) {
      let data;
      try { data = JSON.parse(s.textContent); } catch (e) { continue; }
      const found = searchForJobPosting(data);
      if (found) return found;
    }
    return null;
  }
  function searchForJobPosting(node) {
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = searchForJobPosting(item);
        if (found) return found;
      }
      return null;
    }
    const type = node["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes("JobPosting")) return node;
    if (node["@graph"]) return searchForJobPosting(node["@graph"]);
    return null;
  }

  function fromJobPostingLd(ld) {
    const org = ld.hiringOrganization;
    const company = (org && (org.name || org)) || "";
    let location = "";
    const loc = ld.jobLocation;
    if (loc) {
      const locs = Array.isArray(loc) ? loc : [loc];
      location = locs.map((l) => {
        const addr = l && l.address;
        if (!addr) return "";
        return [addr.addressLocality, addr.addressRegion, addr.addressCountry]
          .filter(Boolean).join(", ");
      }).filter(Boolean).join(" | ");
    }
    if (!location && ld.applicantLocationRequirements) {
      const req = ld.applicantLocationRequirements;
      const reqs = Array.isArray(req) ? req : [req];
      location = reqs.map((r) => r && r.name).filter(Boolean).join(", ");
    }
    return {
      title: ld.title || "",
      company: typeof company === "string" ? company : "",
      location,
      description: stripHtml(ld.description || ""),
      source: "ld+json",
    };
  }

  // Bespoke fallbacks for the boards big enough to be worth naming, for the
  // pages of theirs that don't carry JobPosting schema -- which, on
  // LinkedIn specifically, is most of the time: the split search view
  // (jobs/search/?currentJobId=...) swaps the right-hand pane in with
  // client-side rendering and, unlike the standalone jobs/view/<id> page,
  // doesn't appear to re-emit a JobPosting <script type="application/ld+
  // json"> per job selected -- so this DOM fallback, not the schema reader
  // above, is what actually runs for most of a LinkedIn browsing session.
  // LinkedIn renames these classes periodically; each field tries several
  // in order, oldest-last, and a selector that stops matching just means
  // that field falls through to the one after it rather than the whole
  // extraction failing.
  const SITE_EXTRACTORS = [
    {
      test: () => /(^|\.)linkedin\.com$/.test(HOST) && /\/jobs\//.test(location.pathname),
      run: () => ({
        title: textOf(document.querySelector(
          ".job-details-jobs-unified-top-card__job-title h1, .job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, .top-card-layout__title, h1"
        )),
        company: textOf(document.querySelector(
          ".job-details-jobs-unified-top-card__company-name a, .job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name, .topcard__org-name-link"
        )),
        location: textOf(document.querySelector(
          ".job-details-jobs-unified-top-card__primary-description-container, .job-details-jobs-unified-top-card__tertiary-description-container, .jobs-unified-top-card__bullet, .topcard__flavor--bullet"
        )),
        description: textOf(document.querySelector(
          "#job-details, .jobs-description__content, .jobs-box__html-content, .jobs-description-content__text, .description__text"
        )),
        source: "linkedin-dom",
      }),
    },
    {
      test: () => /(^|\.)indeed\.com$/.test(HOST) && /viewjob|\/jobs?/.test(location.pathname + location.search),
      run: () => ({
        title: textOf(document.querySelector('h1[data-testid="jobsearch-JobInfoHeader-title"], .jobsearch-JobInfoHeader-title')),
        company: textOf(document.querySelector('[data-testid="inlineHeader-companyName"], .jobsearch-InlineCompanyRating a')),
        location: textOf(document.querySelector('[data-testid="job-location"], .jobsearch-JobInfoHeader-subtitle')),
        description: textOf(document.querySelector("#jobDescriptionText")),
        source: "indeed-dom",
      }),
    },
  ];

  function extractGeneric() {
    // Last resort, only ever used for a manually-triggered check: the page
    // title as the job title, an og:site_name as the company, and the
    // largest block of text on the page as the description. Noisy, but a
    // manual check is an explicit "score this page for me" from the person
    // looking at it, not a guess volunteered uninvited.
    const ogSite = document.querySelector('meta[property="og:site_name"]');
    const main = document.querySelector("main, article, #content, .content") || document.body;
    return {
      title: (document.title || "").split(/[|\-–]/)[0].trim(),
      company: ogSite ? ogSite.content : HOST.replace(/^www\./, ""),
      location: "",
      description: textOf(main).slice(0, 20000),
      source: "generic-fallback",
    };
  }

  function extractJob({ forceGeneric = false } = {}) {
    if (!forceGeneric) {
      const ld = findJobPostingLd();
      if (ld) {
        const job = fromJobPostingLd(ld);
        if (job.title && job.description) return job;
      }
      for (const extractor of SITE_EXTRACTORS) {
        if (extractor.test()) {
          const job = extractor.run();
          if (job.title && job.description) return job;
        }
      }
      return null;
    }
    return extractGeneric();
  }

  // ------------------------------------------------------------------
  // Badge UI
  // ------------------------------------------------------------------
  let panelOpen = false;

  function tier(percent) {
    if (percent === null || percent === undefined) return "none";
    if (percent >= 65) return "good";
    if (percent >= 40) return "mid";
    return "low";
  }

  function buildBadge(job, result, meta) {
    const existing = document.getElementById("sponsor-check-badge");
    if (existing) existing.remove();

    const wrap = document.createElement("div");
    wrap.id = "sponsor-check-badge";
    wrap.className = "sc-badge";

    const legPct = result.legitimacy.percent;
    const cvPct = result.cvFit.percent;

    wrap.innerHTML = `
      <button class="sc-pill" type="button" aria-expanded="false">
        <span class="sc-dot sc-${tier(legPct)}"></span>
        <span class="sc-label">Sponsor Check</span>
        <span class="sc-scores">
          <span class="sc-chip sc-${tier(legPct)}">${legPct === null ? "—" : legPct}</span>
          ${meta && meta.hasCv ? `<span class="sc-chip sc-${tier(cvPct)}">${cvPct === null ? "—" : cvPct} fit</span>` : ""}
        </span>
      </button>
      <div class="sc-panel" hidden></div>
    `;

    document.documentElement.appendChild(wrap);
    console.log("[Sponsor Check] badge attached to the page, bounding box:", wrap.getBoundingClientRect());

    const pillBtn = wrap.querySelector(".sc-pill");
    const panel = wrap.querySelector(".sc-panel");
    panel.innerHTML = renderPanel(job, result, meta);
    // A rebuild (moving to a different job) always recreates this markup
    // from scratch, which would otherwise snap an open panel shut the
    // moment the badge updates -- `panelOpen` is kept across rebuilds
    // specifically so reading the breakdown for job A isn't interrupted by
    // the badge quietly re-detecting job B underneath it.
    panel.hidden = !panelOpen;
    pillBtn.setAttribute("aria-expanded", String(panelOpen));

    pillBtn.addEventListener("click", () => {
      panelOpen = !panelOpen;
      panel.hidden = !panelOpen;
      pillBtn.setAttribute("aria-expanded", String(panelOpen));
    });

    const closeBtn = panel.querySelector(".sc-close");
    if (closeBtn) closeBtn.addEventListener("click", () => {
      panelOpen = false; panel.hidden = true; pillBtn.setAttribute("aria-expanded", "false");
    });
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  function renderPanel(job, result, meta) {
    const leg = result.legitimacy, ats = result.ats, cv = result.cvFit, rec = result.recommendation;
    const registerNote = meta.registerError
      ? `<p class="sc-warn">Sponsor register: ${esc(meta.registerError)}${meta.registerStale ? " (using a cached copy)" : ""}</p>`
      : meta.registerCount
        ? `<p class="sc-muted">UK sponsor register: ${meta.registerCount.toLocaleString()} entries loaded${meta.registerStale ? " (cached copy, refreshing)" : ""}.</p>`
        : "";

    const section = (title, body) => `<h4>${esc(title)}</h4>${body}`;
    const list = (items) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;

    let ats_html;
    if (!ats.hasCv) {
      ats_html = "<p class=\"sc-muted\">No CV added yet -- click the extension icon to add one.</p>";
    } else if (!ats.flags.length) {
      ats_html = "<p>No issues found.</p>";
    } else {
      ats_html = `<ul>${ats.flags.map((f) => `<li class="sc-${f.severity === "critical" ? "warn" : "muted"}"><b>${f.severity === "critical" ? "Critical:" : "Warning:"}</b> ${esc(f.text)}</li>`).join("")}</ul>`;
    }

    let cv_html;
    if (cv.percent !== null) {
      cv_html = `<p><b>${cv.percent}/100</b></p>` + list(cv.subDetails);
    } else {
      cv_html = `<p class="sc-muted">${esc(cv.reason)}</p>`;
    }

    return `
      <button class="sc-close" type="button" aria-label="Close">&times;</button>
      <div class="sc-job">${esc(job.title)}${job.company ? " &middot; " + esc(job.company) : ""}</div>
      ${section("Legitimacy &amp; sponsorability", `<p><b>${leg.percent === null ? "Not enough information" : leg.percent + "/100"}</b> &mdash; ${esc(leg.verdict)}</p>${list(leg.sponsor.subDetails || [])}${leg.pattern.percent !== null ? `<p class="sc-muted">${esc(leg.pattern.reason)}</p>` : ""}`)}
      ${registerNote}
      ${section("ATS readiness", ats_html)}
      ${section("CV fit", cv_html)}
      ${section("Recommendation", `<p><b>${esc(rec.verdict)}${rec.score !== null ? ` (${rec.score}/100)` : ""}</b></p><p>${esc(rec.explanation)}</p>`)}
      <p class="sc-footer">Scored entirely in your browser, the same way job-radar's own dashboard scores it. Nothing here is sent anywhere except the UK sponsor register refresh.</p>
    `;
  }

  // Reloading (or updating) the extension while a tab it's already running
  // on stays open orphans that tab's content script: Chrome keeps it alive,
  // but `chrome.runtime.id` goes away, and any `chrome.runtime.sendMessage`
  // call from that dead context either throws synchronously ("Extension
  // context invalidated.") or resolves its internal messaging URL to the
  // literal string "chrome-extension://invalid/" -- which is what showed up
  // repeated many times over: every redetect cycle (the max-wait ceiling
  // added above fires roughly every 1.5s) tried to message a background
  // worker that could never answer, and failed the same way each time.
  // There is no recovering a dead context short of the person reloading the
  // page themselves, so `teardown()` is the one thing that runs at that
  // point: stop every timer, disconnect the observer, take the badge down,
  // and say so once -- not silently, and not sixteen more times.
  let contextDead = false;
  function isContextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }
  function teardown(reason) {
    if (contextDead) return;
    contextDead = true;
    console.warn(`[Sponsor Check] ${reason} -- this tab's copy of the extension is now inactive. Reload this page to reconnect it (this happens whenever the extension itself is reloaded or updated while the page stays open).`);
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    try { observer.disconnect(); } catch (e) { /* not created yet */ }
    const existing = document.getElementById("sponsor-check-badge");
    if (existing) existing.remove();
  }

  async function evaluateAndShow(job) {
    if (!isContextAlive()) { teardown("extension context is gone"); return; }
    let sent;
    try {
      sent = chrome.runtime.sendMessage({ type: "EVALUATE_JOB", job }, (resp) => {
        // This used to return here with nothing logged at all, which meant a
        // service-worker hiccup (MV3 puts the background worker to sleep and
        // can be slow to wake it back up, especially right after the browser
        // starts or the extension is freshly reloaded) looked identical to
        // "the badge never runs" -- no error, just silence, from the one
        // place that would have said why.
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || "";
          if (/context invalidated|Extension context/i.test(msg)) { teardown("extension context is gone"); return; }
          console.warn("[Sponsor Check] couldn't reach the extension's background worker:", msg,
            "-- if this keeps happening, try reloading the page, or reloading the extension itself from chrome://extensions.");
          return;
        }
        if (!resp) {
          console.warn("[Sponsor Check] got no response evaluating this job -- the background worker may not have started yet. Try again in a moment.");
          return;
        }
        if (!resp.ok) { console.warn("[Sponsor Check] scoring failed:", resp.error); return; }
        if (!isContextAlive()) { teardown("extension context is gone"); return; }
        chrome.runtime.sendMessage({ type: "GET_CV_STATUS" }, (cvStatus) => {
          if (chrome.runtime.lastError) return; // already handled/logged above for this cycle
          const meta = {
            hasCv: cvStatus && cvStatus.hasCv,
            registerStale: resp.registerStale,
            registerError: resp.registerError,
            registerCount: resp.registerCount,
          };
          console.log("[Sponsor Check] showing badge:", { legitimacy: resp.result.legitimacy.percent, cvFit: resp.result.cvFit.percent });
          buildBadge(job, resp.result, meta);
        });
      });
    } catch (e) {
      // The synchronous-throw shape of the same failure -- some Chrome
      // versions throw here instead of calling back with lastError set.
      teardown("extension context is gone (" + (e && e.message) + ")");
    }
  }

  // A fingerprint of whatever's currently shown, so a re-detection that
  // finds the SAME job (most DOM mutations on a page like LinkedIn's --
  // a chat widget, a notification badge, an ad slot -- have nothing to do
  // with which job is open) doesn't re-score and rebuild the badge for no
  // reason, and so a genuine change (however small the DOM diff that
  // caused it) always does.
  let lastFingerprint = null;
  function fingerprint(job) {
    return job ? `${job.title}\u0001${job.company}\u0001${(job.description || "").slice(0, 300)}` : null;
  }

  function tryAutoDetect() {
    if (contextDead) return;
    const job = extractJob();
    const fp = fingerprint(job);
    if (fp === lastFingerprint) return;
    lastFingerprint = fp;
    if (job) {
      console.log(`[Sponsor Check] detected a job posting (via ${job.source}):`, job.title, "@", job.company);
      evaluateAndShow(job);
    } else {
      console.log("[Sponsor Check] page changed but no job posting confidently detected -- badge removed if one was showing. Use the toolbar button's \"Check this page\" to force a check.");
      // The page changed enough to invalidate the last job (a real
      // navigation, most likely) but nothing new was confidently detected.
      // Showing the previous posting's score against whatever's on screen
      // now would be quietly wrong, so the badge comes down instead of
      // going stale.
      const existing = document.getElementById("sponsor-check-badge");
      if (existing) existing.remove();
    }
  }

  // On a page like LinkedIn's or Indeed's, clicking a different job in the
  // list never triggers a normal navigation -- the URL changes via the
  // History API (pushState) and the details pane is swapped in by React,
  // both invisible to a `load` or `popstate` listener on their own. Two
  // independent triggers cover it without relying on either alone:
  //
  // 1. A MutationObserver, debounced -- but a PURE debounce (reset the
  //    timer on every mutation, only fire once things go quiet) never
  //    fires at all on a page that never goes quiet, and a page with a
  //    live chat widget, a notification poller or background XHR activity
  //    can mutate continuously. `runRedetect` is called on a max-wait
  //    ceiling as well as the quiet-period debounce, so a burst of
  //    unrelated churn delays it by at most MAX_WAIT_MS, never forever.
  // 2. `history.pushState`/`replaceState` patched directly, plus
  //    `popstate`, since that's the actual signal a SPA job board fires on
  //    "next job" -- this runs the check immediately rather than waiting
  //    on the debounce at all.
  const DEBOUNCE_MS = 400;
  const MAX_WAIT_MS = 1500;
  let debounceTimer = null;
  let maxWaitTimer = null;
  function runRedetect() {
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    debounceTimer = null;
    maxWaitTimer = null;
    tryAutoDetect();
  }
  function scheduleRedetect() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runRedetect, DEBOUNCE_MS);
    if (!maxWaitTimer) maxWaitTimer = setTimeout(runRedetect, MAX_WAIT_MS);
  }

  tryAutoDetect();
  const observer = new MutationObserver(scheduleRedetect);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  for (const fn of ["pushState", "replaceState"]) {
    const original = history[fn];
    history[fn] = function (...args) {
      const result = original.apply(this, args);
      runRedetect();
      return result;
    };
  }
  window.addEventListener("popstate", runRedetect);
  window.addEventListener("hashchange", runRedetect);

  // Manual check, triggered from the toolbar popup for a page that didn't
  // auto-detect (an in-house ATS with no schema.org markup, say).
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "MANUAL_CHECK") {
      const job = extractJob({ forceGeneric: true });
      evaluateAndShow(job);
      sendResponse({ ok: true, job });
    }
  });
})();
