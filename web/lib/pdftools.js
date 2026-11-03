// Merge and split documents for applications (portals often want one PDF,
// or a file under a size limit, or the CV and certificates separately).
// Everything happens in the browser; nothing is uploaded. Needs pdf-lib.
(function (root) {
  "use strict";

  const A4 = [595.28, 841.89];

  // "1-3, 5, 8-" -> [[1,3],[5,5],[8,N]]. Pages are 1-based; errors are plain sentences.
  function parseRanges(text, pageCount) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return { error: "Enter the pages you want, for example 1-3, 5, 8-." };
    const out = [];
    for (const raw of t.split(/[,;\s]+/).filter(Boolean)) {
      let m;
      if (raw === "all") { out.push([1, pageCount]); continue; }
      if (raw === "odd" || raw === "even") {
        for (let i = raw === "odd" ? 1 : 2; i <= pageCount; i += 2) out.push([i, i]);
        continue;
      }
      if ((m = raw.match(/^(\d+)$/))) out.push([+m[1], +m[1]]);
      else if ((m = raw.match(/^(\d+)[-–](\d*)$/))) out.push([+m[1], m[2] ? +m[2] : pageCount]);
      else if ((m = raw.match(/^[-–](\d+)$/))) out.push([1, +m[1]]);
      else return { error: `"${raw}" is not a page or a range. Use forms like 3, 1-4, 8- (to the end), odd or even.` };
    }
    for (const [a, b] of out) {
      if (a < 1 || b < 1) return { error: "Pages start at 1." };
      if (a > pageCount || b > pageCount) return { error: `This file has ${pageCount} page${pageCount === 1 ? "" : "s"}, so ${a === b ? a : a + "-" + b} is outside it.` };
      if (b < a) return { error: `${a}-${b} runs backwards. Write it as ${b}-${a} if you meant that.` };
    }
    return { ranges: out };
  }

  const pagesOf = (ranges) => ranges.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, i) => a - 1 + i));

  function sizeLabel(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  const isPdf = (name, type) => /\.pdf$/i.test(name || "") || type === "application/pdf";
  const isImage = (name, type) => /\.(jpe?g|png)$/i.test(name || "") || /^image\/(jpeg|png)$/.test(type || "");

  function loadError(name, e) {
    const m = String((e && e.message) || e);
    if (/encrypt/i.test(m)) return new Error(`"${name}" is password-protected. Remove the password first (open it, then print or save as a new PDF), then add it again.`);
    return new Error(`"${name}" could not be read as a PDF (${m.slice(0, 80)}). If it opens normally elsewhere, print it to a new PDF and use that.`);
  }

  async function pageCount(PDFLib, bytes, name) {
    try { return (await PDFLib.PDFDocument.load(bytes)).getPageCount(); } catch (e) { throw loadError(name, e); }
  }

  // items: [{name, type, bytes: Uint8Array}] in the order wanted. PDFs keep their
  // pages; JPG/PNG each become one A4 page, scaled to fit with a margin.
  async function merge(PDFLib, items) {
    if (!items.length) throw new Error("Add at least one file first.");
    const out = await PDFLib.PDFDocument.create();
    for (const it of items) {
      if (isPdf(it.name, it.type)) {
        let src;
        try { src = await PDFLib.PDFDocument.load(it.bytes); } catch (e) { throw loadError(it.name, e); }
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      } else if (isImage(it.name, it.type)) {
        let img;
        try { img = /\.png$/i.test(it.name) || it.type === "image/png" ? await out.embedPng(it.bytes) : await out.embedJpg(it.bytes); }
        catch (e) { throw new Error(`"${it.name}" could not be read as an image. Use a normal JPG or PNG.`); }
        const landscape = img.width > img.height * 1.2;
        const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
        const margin = 28, k = Math.min((pw - 2 * margin) / img.width, (ph - 2 * margin) / img.height, 1.5);
        const w = img.width * k, h = img.height * k;
        out.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      } else {
        throw new Error(`"${it.name}" is not a PDF, JPG or PNG. Convert it to PDF first (in Word: File, Save as PDF).`);
      }
    }
    return out.save();
  }

  // pages: 0-based indexes in the order wanted
  async function extract(PDFLib, bytes, pages, name) {
    let src;
    try { src = await PDFLib.PDFDocument.load(bytes); } catch (e) { throw loadError(name || "file", e); }
    const out = await PDFLib.PDFDocument.create();
    (await out.copyPages(src, pages)).forEach((p) => out.addPage(p));
    return out.save();
  }

  const stem = (name) => String(name || "document").replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "document";

  // Split plan: either one file per range, or one file with all of them.
  function splitNames(name, ranges, mode) {
    const s = stem(name);
    if (mode === "one") return [`${s}-extract.pdf`];
    return ranges.map(([a, b]) => `${s}-pages-${a === b ? a : a + "-" + b}.pdf`);
  }

  // Portal limits are in MB; says what to do when a file is over.
  function limitAdvice(bytes, limitMb) {
    const lim = Number(limitMb);
    if (!lim || lim <= 0) return "";
    const over = bytes / 1048576 - lim;
    if (over <= 0) return `Under the ${lim} MB limit.`;
    return `${over.toFixed(2)} MB over the ${lim} MB limit. This tool cannot shrink scans or photos. Split it into parts, or re-save the big scans at lower quality before adding them.`;
  }

  const api = { A4, parseRanges, pagesOf, sizeLabel, isPdf, isImage, pageCount, merge, extract, splitNames, stem, limitAdvice };
  root.PdfTools = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
