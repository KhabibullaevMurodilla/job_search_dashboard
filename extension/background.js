/*
 * Service worker: owns the CV, the cached UK sponsor register, and the
 * actual scoring. content.js only ever extracts a job's title/company/
 * location/description off the page and asks this worker to score it --
 * nothing here talks to a job board, and nothing about the posting or your
 * CV is sent anywhere except the one GOV.UK fetch this worker itself makes
 * to keep the sponsor register current.
 */
importScripts("lib/scoring.js");

const CV_KEY = "cvText";
const CV_META_KEY = "cvMeta";
const REGISTER_ALARM = "refresh-uk-register";

// Keep the register warm: once on install, and again every day, so a job
// posting is never the first thing waiting on a 7-day-stale-cache refetch.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(REGISTER_ALARM, { periodInMinutes: 60 * 24 });
  refreshRegister().catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REGISTER_ALARM) refreshRegister().catch(() => {});
});

async function refreshRegister() {
  return self.SponsorCheck.fetchUkRegister(chrome.storage.local);
}

async function getCv() {
  const stored = await new Promise((resolve) =>
    chrome.storage.local.get([CV_KEY, CV_META_KEY], resolve)
  );
  return { cvText: stored[CV_KEY] || "", cvMeta: stored[CV_META_KEY] || null };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === "EVALUATE_JOB") {
    (async () => {
      try {
        const [register, cv] = await Promise.all([
          self.SponsorCheck.fetchUkRegister(chrome.storage.local).catch((e) => ({
            country: "UK", entries: [], error: String(e),
          })),
          getCv(),
        ]);
        const result = self.SponsorCheck.evaluateJob(
          msg.job, [register], cv.cvText, cv.cvMeta
        );
        sendResponse({ ok: true, result, registerStale: !!register.stale, registerError: register.error || null, registerCount: (register.entries || []).length });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async response
  }

  if (msg.type === "GET_CV_STATUS") {
    getCv().then((cv) => sendResponse({
      hasCv: !!cv.cvText, length: cv.cvText.length, meta: cv.cvMeta,
    }));
    return true;
  }

  if (msg.type === "SET_CV") {
    chrome.storage.local.set(
      { [CV_KEY]: msg.cvText || "", [CV_META_KEY]: msg.cvMeta || null },
      () => sendResponse({ ok: true })
    );
    return true;
  }

  if (msg.type === "REFRESH_REGISTER") {
    chrome.storage.local.remove("ukSponsorRegisterCache", () => {
      refreshRegister()
        .then((r) => sendResponse({ ok: true, count: (r.entries || []).length }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
    });
    return true;
  }

  if (msg.type === "GET_REGISTER_STATUS") {
    chrome.storage.local.get(["ukSponsorRegisterCache"], (res) => {
      const cache = res.ukSponsorRegisterCache;
      sendResponse(cache
        ? { loaded: true, count: (cache.entries || []).length, fetchedAt: cache.fetchedAt }
        : { loaded: false });
    });
    return true;
  }

  return false;
});
