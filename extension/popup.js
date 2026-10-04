document.addEventListener("DOMContentLoaded", () => {
  chrome.runtime.sendMessage({ type: "GET_CV_STATUS" }, (cv) => {
    const el = document.getElementById("cv-status");
    if (cv && cv.hasCv) {
      el.textContent = `Yes (${cv.length.toLocaleString()} chars)`;
      el.className = "ok";
    } else {
      el.textContent = "Not added";
      el.className = "warn";
    }
  });

  chrome.runtime.sendMessage({ type: "GET_REGISTER_STATUS" }, (reg) => {
    const el = document.getElementById("register-status");
    if (reg && reg.loaded) {
      el.textContent = `${reg.count.toLocaleString()} entries`;
      el.className = "ok";
    } else {
      el.textContent = "Loading…";
      el.className = "warn";
    }
  });

  document.getElementById("check-page").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: "MANUAL_CHECK" }, () => {
      // Errors here (no content script on this tab, e.g. a chrome:// page)
      // are expected and silently ignored -- there is nothing to check.
      void chrome.runtime.lastError;
      window.close();
    });
  });

  document.getElementById("open-options").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
});
