// "My research": the applicant's own theses, dissertations and reports. The
// full text is read in the browser and kept in memory only. What is saved is a
// short digest in which every item carries a quote that is really in the
// document, so later drafts can say what the applicant researched, how, and
// what they found without guessing. Pure logic: prompts, parsers, checks.
(function (root) {
  "use strict";

  const KINDS = ["MSc thesis", "BSc thesis", "Dissertation", "Research report", "Paper"];
  const ITEM_KINDS = ["question", "method", "data", "result", "limitation", "contribution", "future"];
  const MAX_WORKS = 6, MAX_ITEMS = 16, MIN_WORDS = 1500;

  const clip = (s, n) => String(s || "").slice(0, n);
  const str = (v, n) => clip(typeof v === "string" ? v.trim() : "", n || 2000);
  const normText = (t) => String(t || "").toLowerCase().replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, "-").replace(/[^a-z0-9]+/g, " ").trim();
  const quoteIn = (quote, corpus) => { const q = normText(quote); return q.split(" ").length >= 6 && normText(corpus).includes(q); };
  const wordCount = (t) => (String(t || "").match(/\S+/g) || []).length;

  const MARKERS = /\b(we|i) (?:propose|present|use|used|train|trained|evaluate|evaluated|find|found|show|showed|compare|compared|collected|built|implemented|designed)\b|\bresults? (?:show|showed|indicate|indicated|suggest)|\b(?:research question|objective|aim of this|hypothesis|limitation|future work|dataset|baseline|accuracy|rmse|mae|f1|precision|recall|outperform|improvement|contribution|conclusion)\b/i;

  // The text sent for the digest: the opening (abstract and introduction), the
  // ending (conclusions), and the passages in between that state methods,
  // data and results. In reading order, never more than maxChars.
  function digestText(text, maxChars) {
    const limit = maxChars || 42000, t = String(text || "");
    if (t.length <= limit) return t;
    const head = Math.floor(limit * 0.22), tail = Math.floor(limit * 0.2), mid = limit - head - tail;
    const body = t.slice(head, t.length - tail);
    const sents = body.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/);
    const chunks = []; let cur = "";
    for (const s of sents) { if (cur && cur.length + s.length > 700) { chunks.push(cur.trim()); cur = ""; } cur += s + " "; }
    if (cur.trim()) chunks.push(cur.trim());
    const scored = chunks.map((c, i) => ({ i, c, sc: (MARKERS.test(c) ? 2 : 0) + Math.min(3, (c.match(/\b\d+(?:\.\d+)?%?/g) || []).length * 0.3) })).sort((a, b) => b.sc - a.sc || a.i - b.i);
    const keep = []; let n = 0;
    for (const x of scored) { if (x.sc <= 0) break; if (n + x.c.length > mid) continue; keep.push(x); n += x.c.length; }
    return t.slice(0, head) + " … " + keep.sort((a, b) => a.i - b.i).map((x) => x.c).join(" … ") + " … " + t.slice(t.length - tail);
  }

  // A shorter set of the strongest method and result passages, saved with the
  // digest so proposals can use the substance after a reload.
  function keyPassages(text, maxChars) {
    const limit = maxChars || 4000, sents = String(text || "").split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/);
    const chunks = []; let cur = "";
    for (const s of sents) { if (cur && cur.length + s.length > 650) { chunks.push(cur.trim()); cur = ""; } cur += s + " "; }
    if (cur.trim()) chunks.push(cur.trim());
    const scored = chunks.filter((c) => c.length > 80).map((c, i) => ({ i, c, sc: (MARKERS.test(c) ? 2 : 0) + Math.min(3, (c.match(/\b\d+(?:\.\d+)?%?/g) || []).length * 0.3) })).sort((a, b) => b.sc - a.sc || a.i - b.i);
    const keep = []; let n = 0;
    for (const x of scored) { if (x.sc <= 0) break; if (n + x.c.length > limit) continue; keep.push(x); n += x.c.length; }
    return keep.sort((a, b) => a.i - b.i).map((x) => x.c).join(" … ");
  }

  function buildDigestPrompt(o) {
    return [
      "Below is the text of a research document written by a job or PhD applicant: " + (o.kind || "a thesis") + (o.title ? ", \"" + o.title + "\"" : "") + ". Write a digest of what the research was and what it found, so the applicant can later describe their own research accurately.",
      "",
      o.mineNote ? "What the applicant says was their own work, and what was shared or supervised: " + o.mineNote : "",
      "",
      "Return ONLY JSON: {\"title\":\"the document's title if stated, else empty\",\"year\":\"year if stated, else empty\",\"summary\":\"two or three plain sentences: what was studied, how, and the main finding\",\"items\":[{\"kind\":\"question|method|data|result|limitation|contribution|future\",\"text\":\"one plain sentence\",\"quote\":\"words copied EXACTLY from the text below, 8 to 40 words, that carry this item\",\"mine\":true|false}]}",
      "Rules:",
      "- 8 to 14 items covering, where the text has them: the research question, the method, the data, the results (with their numbers), the limitations, the contribution and the future work.",
      "- Every item rests on a quote copied exactly from the text. If you cannot quote it, leave it out. A number may appear only if the quote contains it, with the same value and unit.",
      "- mine is true when the text presents the work as the author's own. Use false when the text credits it to others: a supervisor, co-authors, a team, a dataset or tool someone else provided, or earlier work the document only reviews.",
      "- Say what the document says, no more. No praise, no judgement of quality, no claims about impact or novelty unless the text states them.",
      "",
      "THE TEXT:",
      digestText(o.text),
    ].filter((x) => x !== "").join("\n");
  }

  function parseJson(text) {
    const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
  }

  // corpus: the full cleaned text, so each quote can be checked against it.
  function parseDigest(raw, corpus) {
    const j = parseJson(raw);
    if (!j || typeof j !== "object") return null;
    const list = Array.isArray(j.items) ? j.items : [];
    const items = []; let dropped = 0;
    for (const x of list) {
      const kind = ITEM_KINDS.indexOf(x && x.kind) >= 0 ? x.kind : "";
      const text = str(x && x.text, 400), quote = str(x && x.quote, 700);
      if (!kind || !text || !quote) { dropped++; continue; }
      if (!quoteIn(quote, corpus)) { dropped++; continue; }
      items.push({ kind, text, quote, mine: !x || x.mine !== false, keep: true });
    }
    if (items.length < 4) return { ok: false, items, dropped, reason: items.length ? "Only " + items.length + " statements could be tied to the document's own words." : "Nothing could be tied to the document's own words." };
    return { ok: true, title: str(j.title, 200), year: /^\d{4}$/.test(str(j.year, 8)) ? str(j.year, 8) : "", summary: str(j.summary, 700), items: items.slice(0, MAX_ITEMS), dropped };
  }

  function normalizeWorks(x) {
    return (Array.isArray(x) ? x : []).map((w) => {
      if (!w || typeof w !== "object") return null;
      const id = str(w.id, 40); if (!id) return null;
      return {
        id, title: str(w.title, 200) || "Untitled", kind: KINDS.indexOf(w.kind) >= 0 ? w.kind : "Dissertation", year: /^\d{4}$/.test(str(w.year, 8)) ? str(w.year, 8) : "",
        file: str(w.file, 200), words: Math.max(0, Math.floor(Number(w.words) || 0)), summary: str(w.summary, 700), mineNote: str(w.mineNote, 1500), passages: str(w.passages, 4500),
        items: (Array.isArray(w.items) ? w.items : []).map((i) => ({ kind: ITEM_KINDS.indexOf(i && i.kind) >= 0 ? i.kind : "", text: str(i && i.text, 400), quote: str(i && i.quote, 700), mine: !i || i.mine !== false, keep: !i || i.keep !== false })).filter((i) => i.kind && i.text && i.quote).slice(0, MAX_ITEMS),
        at: str(w.at, 40),
      };
    }).filter(Boolean).slice(0, MAX_WORKS);
  }

  const kept = (w) => w.items.filter((i) => i.keep);
  const usable = (works) => (works || []).filter((w) => kept(w).length > 0);

  // The text given to the model about the applicant's research.
  function block(works, opts) {
    const o = opts || {}, out = [];
    for (const w of usable(works)) {
      const lines = [`WORK: ${w.title} (${w.kind}${w.year ? ", " + w.year : ""})`];
      if (w.summary) lines.push("Summary: " + w.summary);
      for (const i of kept(w)) lines.push(`- [${i.kind}${i.mine ? "" : ", shared or others' work"}] ${i.text}`);
      if (w.mineNote) lines.push("What was the applicant's own, in their words: " + w.mineNote);
      if (o.passages && w.passages) lines.push("Passages from the document: " + w.passages);
      out.push(lines.join("\n"));
    }
    return out.join("\n\n");
  }
  const rules = () => "Describe the applicant's research only as the block above says. Numbers only as it gives them. An item marked shared or others' work is never claimed as the applicant's alone: say \"we\" or name their part. Do not turn a result into a wider claim than the item makes.";

  // Everything the research block can support, for checking figures and quotes.
  function corpus(works) {
    return usable(works).map((w) => [w.title, w.summary, w.mineNote, w.passages, ...kept(w).map((i) => i.text + " " + i.quote)].join("\n")).join("\n");
  }

  const api = { KINDS, ITEM_KINDS, MAX_WORKS, MIN_WORDS, digestText, keyPassages, buildDigestPrompt, parseDigest, normalizeWorks, kept, usable, block, rules, corpus, quoteIn, wordCount };
  root.Research = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
