// This page (like content.js's copy on every job site) gets orphaned if the
// extension is reloaded while this tab is already open: `chrome.runtime.id`
// disappears, and `chrome.runtime.getURL(...)` -- called below to point
// PDF.js at its worker file -- quietly returns the literal string
// "chrome-extension://invalid/" instead of throwing or failing loudly.
// PDF.js then has a worker pointed at a URL that will never resolve, and
// every PDF read from that point on retries fetching it and fails the same
// way, repeatedly, which is indistinguishable in the console from an error
// on whatever tab happens to have focus -- this is the likely source if
// this tab was left open across a reload rather than the LinkedIn tab
// itself. Checked once up front, and the whole page is disabled with a
// clear explanation rather than left to fail silently on first use.
function isContextAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
}

if (!isContextAlive()) {
  document.body.innerHTML =
    '<div class="card"><p><b>This tab is out of date.</b></p>' +
    "<p>The extension was reloaded or updated after this page was opened, " +
    "so it's no longer connected. Close this tab and reopen it from the " +
    "extension's toolbar icon (“Add / update CV”) to reconnect.</p></div>";
  throw new Error("[Sponsor Check] options page opened before this reload/update -- stopping before touching PDF.js or chrome.runtime.");
}

if (window.pdfjsLib) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
}

const fileInput = document.getElementById("cv-file");
const textArea = document.getElementById("cv-text");
const statusEl = document.getElementById("status");
const saveBtn = document.getElementById("save");
const clearBtn = document.getElementById("clear");
const registerInfo = document.getElementById("register-info");
const refreshBtn = document.getElementById("refresh-register");

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

async function extractPdfText(arrayBuffer) {
  const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str).join(" "));
  }
  const text = pages.join("\n");
  const avgCharsPerPage = Math.round(text.length / Math.max(1, doc.numPages));
  return { text, meta: { method: "pdf", avgCharsPerPage } };
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  setStatus("Reading file…");
  try {
    if (file.name.toLowerCase().endsWith(".pdf")) {
      const buf = await file.arrayBuffer();
      const { text } = await extractPdfText(buf);
      if (text.trim().length < 200) {
        setStatus("This PDF's text could not be extracted (it may be a scanned image). Try a text-based PDF or paste the text directly.", "err");
        return;
      }
      textArea.value = text.replace(/\s+/g, " ").trim();
      setStatus(`Read ${text.length.toLocaleString()} characters from ${file.name}. Click "Save CV" to store it.`, "ok");
    } else {
      const text = await file.text();
      textArea.value = text;
      setStatus(`Read ${text.length.toLocaleString()} characters from ${file.name}. Click "Save CV" to store it.`, "ok");
    }
  } catch (e) {
    setStatus("Couldn't read that file: " + (e && e.message || e), "err");
  }
});

saveBtn.addEventListener("click", () => {
  const text = textArea.value.replace(/\s+/g, " ").trim();
  if (text.length < 200) {
    setStatus("That's quite short for a CV (under 200 characters) -- scoring against it would give you a number with nothing real behind it. Add more text, or check the file read correctly.", "err");
    return;
  }
  const isPdf = fileInput.files[0] && fileInput.files[0].name.toLowerCase().endsWith(".pdf");
  const meta = isPdf ? { method: "pdf", avgCharsPerPage: Math.round(text.length) } : { method: "txt", avgCharsPerPage: null };
  chrome.runtime.sendMessage({ type: "SET_CV", cvText: text, cvMeta: meta }, () => {
    setStatus(`Saved (${text.length.toLocaleString()} characters). Job postings will now be scored against this CV.`, "ok");
  });
});

clearBtn.addEventListener("click", () => {
  textArea.value = "";
  fileInput.value = "";
  chrome.runtime.sendMessage({ type: "SET_CV", cvText: "", cvMeta: null }, () => {
    setStatus("Removed. Postings will be scored without a CV until you add one again.", "ok");
  });
});

function loadCvIntoTextarea() {
  chrome.runtime.sendMessage({ type: "GET_CV_STATUS" }, (cv) => {
    if (cv && cv.hasCv) {
      setStatus(`A CV is already saved (${cv.length.toLocaleString()} characters). Upload or paste a new one to replace it.`);
    }
  });
}

function loadRegisterStatus() {
  chrome.runtime.sendMessage({ type: "GET_REGISTER_STATUS" }, (reg) => {
    if (reg && reg.loaded) {
      const when = reg.fetchedAt ? new Date(reg.fetchedAt).toLocaleDateString() : "unknown";
      registerInfo.textContent = `${reg.count.toLocaleString()} entries loaded, last refreshed ${when}.`;
    } else {
      registerInfo.textContent = "Not loaded yet -- it refreshes automatically shortly after install.";
    }
  });
}

refreshBtn.addEventListener("click", () => {
  registerInfo.textContent = "Refreshing…";
  chrome.runtime.sendMessage({ type: "REFRESH_REGISTER" }, (resp) => {
    if (resp && resp.ok) {
      registerInfo.textContent = `Refreshed -- ${resp.count.toLocaleString()} entries loaded.`;
    } else {
      registerInfo.textContent = "Couldn't refresh: " + (resp && resp.error || "unknown error");
    }
  });
});

loadCvIntoTextarea();
loadRegisterStatus();
