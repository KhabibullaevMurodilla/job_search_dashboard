/*
 * Writing a research proposal that is checkable.
 *
 * Three problems, three mechanisms, all of them code rather than hope:
 *
 *  1. Citations. A language model remembers plausible-looking papers that do
 *     not exist. So the model never writes a reference. Real papers are fetched
 *     from an open scholarly database (OpenAlex, Crossref as fallback), the
 *     draft may cite only those by tag ([S3]), and this file turns the tags
 *     into (Author, Year) and builds the reference list from the database
 *     record. Any tag that is not on the list, and any author-year text the
 *     model typed itself, is caught here. What this cannot check is whether a
 *     paper really supports the sentence it is attached to: only reading it
 *     does, so the screen asks you to tick each source as read.
 *
 *  2. Your voice. Your own writing is measured (sentence length and spread,
 *     openers, em dashes, spelling, first person ...). The measurements and a
 *     few of your own paragraphs go to the model, and the draft is measured
 *     again and compared, row by row, so a mismatch is visible, not assumed.
 *
 *  3. Filler. A list of stock phrases is checked for in code. The draft is
 *     sent back with the exact sentences to change if it contains them.
 *
 * Pure functions only: no DOM, no storage, no network. Tested in Node.
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ text
  const ABBR = ["et al.", "e.g.", "i.e.", "etc.", "vs.", "Fig.", "fig.", "Dr.", "Prof.", "Mr.", "Mrs.", "Ms.", "No.", "approx.", "cf.", "pp.", "p."];

  function stripTags(text) { return String(text || "").replace(/\[S\d+(?:\s*[,;]\s*S\d+)*\]/g, ""); }

  function splitSentences(text) {
    let t = stripTags(text).replace(/\r/g, "");
    ABBR.forEach((a, i) => { t = t.split(a).join(a.replace(/\./g, "\u0001")); });
    return t.split(/(?<=[.!?])["')\]]*\s+(?=["'(\[]?[A-Z0-9])|\n+/)
      .map((s) => s.replace(/\u0001/g, ".").trim()).filter((s) => /[A-Za-z]/.test(s));
  }

  function wordsOf(s) { return (String(s).match(/[A-Za-z][A-Za-z'’-]*/g) || []); }

  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
  function sd(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); }
  const r1 = (x) => Math.round(x * 10) / 10;

  const UK = ["behaviour", "colour", "analyse", "analysed", "organisation", "optimise", "optimised", "optimisation", "centre", "modelling", "labour", "favour", "whilst", "licence", "recognise", "generalise", "generalisation", "utilise", "characterise", "normalise", "visualise", "summarise", "prioritise"];
  const US = ["behavior", "color", "analyze", "analyzed", "organization", "optimize", "optimized", "optimization", "center", "modeling", "labor", "favor", "recognize", "generalize", "generalization", "utilize", "characterize", "normalize", "visualize", "summarize", "prioritize"];
  const CONNECTORS = ["however", "therefore", "thus", "moreover", "furthermore", "additionally", "also", "but", "because", "so", "although", "while", "whilst", "since", "hence", "instead", "yet"];

  function styleProfile(text) {
    const clean = stripTags(text);
    const sents = splitSentences(clean);
    const lens = sents.map((s) => wordsOf(s).length);
    const nWords = lens.reduce((a, b) => a + b, 0);
    const per1000 = (n) => (nWords ? r1((1000 * n) / nWords) : 0);
    const paras = clean.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => /[A-Za-z]/.test(p));
    const sentsPerPara = paras.map((p) => splitSentences(p).length);
    const lower = clean.toLowerCase();
    const ukN = UK.reduce((n, w) => n + (lower.match(new RegExp("\\b" + w + "\\b", "g")) || []).length, 0);
    const usN = US.reduce((n, w) => n + (lower.match(new RegExp("\\b" + w + "\\b", "g")) || []).length, 0);
    const spelling = ukN + usN < 2 ? "unclear" : ukN && !usN ? "UK" : usN && !ukN ? "US" : ukN >= 3 * usN ? "UK" : usN >= 3 * ukN ? "US" : "mixed";
    const openerCount = {};
    for (const s of sents) { const w = (wordsOf(s)[0] || "").toLowerCase(); if (w) openerCount[w] = (openerCount[w] || 0) + 1; }
    const openers = Object.entries(openerCount).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5)
      .map(([w, n]) => ({ word: w, share: sents.length ? Math.round((100 * n) / sents.length) : 0 }));
    const conn = {};
    for (const c of CONNECTORS) { const n = (lower.match(new RegExp("\\b" + c + "\\b", "g")) || []).length; if (n) conn[c] = per1000(n); }
    const firstPerson = (clean.match(/\b(I|my|me|mine|we|our|us)\b/g) || []).length;
    return {
      words: nWords, sentences: sents.length,
      avgSentence: r1(mean(lens)), sdSentence: r1(sd(lens)),
      shortPct: lens.length ? Math.round((100 * lens.filter((l) => l <= 8).length) / lens.length) : 0,
      longPct: lens.length ? Math.round((100 * lens.filter((l) => l >= 30).length) / lens.length) : 0,
      avgPara: r1(mean(sentsPerPara)),
      firstPersonPer100: sents.length ? r1((100 * firstPerson) / sents.length) : 0,
      contractionsPer1000: per1000((clean.match(/\b\w+(n't|'re|'ve|'ll|'d|'m|’re|’ve|’ll|’d|’m|n’t)\b/gi) || []).length),
      emDashPer1000: per1000((clean.match(/—|\s–\s|\s--\s/g) || []).length),
      semicolonPer1000: per1000((clean.match(/;/g) || []).length),
      colonPer1000: per1000((clean.match(/:/g) || []).length),
      parenPer1000: per1000((clean.match(/\(/g) || []).length),
      spelling, openers, connectors: conn,
    };
  }

  const MIN_STYLE_WORDS = 400;

  function describeStyle(pf) {
    const lines = [
      `Sentences average ${pf.avgSentence} words, with a spread of ${pf.sdSentence} (so a real mix of short and long; ${pf.shortPct}% are 8 words or fewer, ${pf.longPct}% are 30 or more).`,
      `Paragraphs average ${pf.avgPara} sentences.`,
      `First person (I, my, we, our) appears about ${pf.firstPersonPer100} times per 100 sentences.`,
      `Em dashes: ${pf.emDashPer1000} per 1000 words. Semicolons: ${pf.semicolonPer1000}. Colons: ${pf.colonPer1000}. Brackets: ${pf.parenPer1000}. Contractions: ${pf.contractionsPer1000}.`,
      pf.spelling === "UK" ? "Spelling is British (behaviour, analyse, organisation)." : pf.spelling === "US" ? "Spelling is American." : "",
      pf.openers.length ? "Sentences most often begin with: " + pf.openers.map((o) => `"${o.word}" (${o.share}%)`).join(", ") + "." : "",
      Object.keys(pf.connectors).length ? "Connecting words they use, per 1000 words: " + Object.entries(pf.connectors).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w, n]) => `${w} ${n}`).join(", ") + "." : "",
    ];
    return lines.filter(Boolean).join("\n");
  }

  // Three short passages from different parts of the samples, as examples of
  // the voice (not to be reused).
  function styleExcerpts(text, count, maxWords) {
    const paras = String(text || "").split(/\n\s*\n/).map((p) => p.trim()).filter((p) => wordsOf(p).length >= 40);
    if (!paras.length) return [];
    const n = Math.min(count || 3, paras.length), out = [];
    for (let i = 0; i < n; i++) {
      const para = paras[Math.floor((i * paras.length) / n)];
      out.push(para.split(/\s+/).slice(0, maxWords || 130).join(" "));
    }
    return out;
  }

  function compareStyle(yours, draft) {
    const rows = [];
    const add = (label, y, d, flag, why) => rows.push({ label, yours: y, draft: d, flag: !!flag, why: flag ? why : "" });
    add("Average sentence length (words)", yours.avgSentence, draft.avgSentence,
      yours.avgSentence && Math.abs(draft.avgSentence - yours.avgSentence) / yours.avgSentence > 0.3,
      "Noticeably " + (draft.avgSentence > yours.avgSentence ? "longer" : "shorter") + " than you write.");
    add("Spread of sentence length", yours.sdSentence, draft.sdSentence,
      yours.sdSentence && draft.sdSentence < 0.65 * yours.sdSentence,
      "More even than you write. Generated text tends to keep every sentence the same length.");
    add("Short sentences (8 words or fewer, %)", yours.shortPct, draft.shortPct, draft.shortPct < yours.shortPct - 10, "Fewer short sentences than you use.");
    add("Em dashes per 1000 words", yours.emDashPer1000, draft.emDashPer1000, draft.emDashPer1000 > yours.emDashPer1000 + 2, "More em dashes than you use.");
    add("Semicolons per 1000 words", yours.semicolonPer1000, draft.semicolonPer1000, draft.semicolonPer1000 > yours.semicolonPer1000 + 3, "More semicolons than you use.");
    add("First person per 100 sentences", yours.firstPersonPer100, draft.firstPersonPer100, false, "");
    add("Spelling", yours.spelling, draft.spelling, yours.spelling === "UK" && (draft.spelling === "US" || draft.spelling === "mixed"), "Your spelling is British; the draft is not consistently.");
    const top = draft.openers[0], yTop = yours.openers[0];
    add("Most common sentence opener", yTop ? `${yTop.word} (${yTop.share}%)` : "-", top ? `${top.word} (${top.share}%)` : "-",
      top && top.share > Math.max(25, (yTop ? yTop.share : 0) + 10), "One word starts too many sentences.");
    return { rows, flagged: rows.filter((r) => r.flag) };
  }

  // ----------------------------------------------------------------- filler
  // [label, regex, allowed count]. Allowed counts are for phrases that are
  // fine once and a habit when repeated.
  const SLOP = [
    ["delve", /\bdelv(e|es|ed|ing)\b/gi, 0],
    ["tapestry", /\btapestry\b/gi, 0],
    ["rapidly evolving / ever-evolving", /\b(rapidly|ever)[- ](evolving|changing|growing)\b/gi, 0],
    ["'in today's ...' opener", /\bin today['’]s\b/gi, 0],
    ["'in recent years' opener", /\bin recent years\b/gi, 0],
    ["'in the realm of'", /\bin the realm of\b/gi, 0],
    ["'it is important/worth to note'", /\bit is (important|worth|crucial|essential|vital) to (note|mention|highlight|emphasi[sz]e|recogni[sz]e)\b/gi, 0],
    ["'plays a crucial/vital/pivotal role'", /\bplays? an? (crucial|vital|pivotal|key|significant|important) role\b/gi, 0],
    ["paradigm shift", /\bparadigm shift\b/gi, 0],
    ["game-changer", /\bgame[- ]chang/gi, 0],
    ["cutting-edge", /\bcutting[- ]edge\b/gi, 0],
    ["pave the way", /\bpav(e|es|ed|ing) the way\b/gi, 0],
    ["shed light on", /\bshed(s|ding)? light\b/gi, 0],
    ["a testament to", /\ba testament to\b/gi, 0],
    ["navigate the complexities", /\bnavigat(e|es|ing) (the )?(complexit|challenges|landscape)/gi, 0],
    ["multifaceted", /\bmulti-?faceted\b/gi, 0],
    ["holistic", /\bholistic(ally)?\b/gi, 0],
    ["seamless", /\bseamless(ly)?\b/gi, 0],
    ["underscore(s)", /\bunderscor(e|es|ed|ing)\b/gi, 0],
    ["pivotal", /\bpivotal\b/gi, 0],
    ["foster", /\bfoster(s|ed|ing)?\b/gi, 0],
    ["leverage", /\bleverag(e|es|ed|ing)\b/gi, 0],
    ["harness", /\bharness(es|ed|ing)?\b/gi, 0],
    ["unlock", /\bunlock(s|ed|ing)?\b/gi, 0],
    ["bridge the gap", /\bbridg(e|es|ed|ing) the (research )?gap\b/gi, 0],
    ["at the intersection of", /\bat the intersection of\b/gi, 0],
    ["transformative", /\btransformative\b/gi, 0],
    ["myriad", /\bmyriad\b/gi, 0],
    ["intricate", /\bintricate\b/gi, 0],
    ["meticulous", /\bmeticulous(ly)?\b/gi, 0],
    ["'comprehensive framework/understanding'", /\bcomprehensive (framework|understanding|analysis|overview)\b/gi, 0],
    ["'I am excited / passionate'", /\bI am (so |truly |deeply )?(excited|passionate|thrilled)\b/gi, 0],
    ["'In conclusion' / 'Overall,'", /(^|\n|\. )(in conclusion|overall|to summari[sz]e),/gi, 0],
    ["'not only ... but also'", /\bnot only\b[^.]{3,80}\bbut also\b/gi, 1],
    ["furthermore / moreover / additionally", /\b(furthermore|moreover|additionally)\b/gi, 2],
    ["'novel' used as praise", /\bnovel\b/gi, 3],
    ["'robust'", /\brobust(ness)?\b/gi, 3],
    ["'state-of-the-art'", /\bstate[- ]of[- ]the[- ]art\b/gi, 2],
  ];

  function slopCheck(text) {
    const t = stripTags(text);
    const issues = [];
    for (const [label, re, allowed] of SLOP) {
      const hits = []; let m;
      const rx = new RegExp(re.source, re.flags);
      while ((m = rx.exec(t))) { hits.push(m.index); if (m.index === rx.lastIndex) rx.lastIndex++; }
      if (hits.length > allowed) {
        issues.push({ label, count: hits.length, allowed, examples: hits.slice(0, 2).map((i) => t.slice(Math.max(0, i - 50), i + 70).replace(/\s+/g, " ").trim()) });
      }
    }
    return { ok: issues.length === 0, issues };
  }

  const SLOP_LABELS = SLOP.filter((x) => x[2] === 0).map((x) => x[0]);

  // ------------------------------------------------------------ sources
  function abstractFromInverted(idx) {
    if (!idx || typeof idx !== "object") return "";
    const pos = [];
    for (const [w, ps] of Object.entries(idx)) if (Array.isArray(ps)) for (const p of ps) pos[p] = w;
    return pos.filter((x) => x !== undefined).join(" ").replace(/\s+/g, " ").trim();
  }

  function splitName(full) {
    const t = String(full || "").replace(/\s+/g, " ").trim();
    if (!t) return null;
    if (t.includes(",")) { const [fam, giv] = t.split(","); return { family: fam.trim(), given: (giv || "").trim() }; }
    const parts = t.split(" ");
    if (parts.length === 1) return { family: parts[0], given: "" };
    // Particles stay with the family name (van der Berg, de la Cruz).
    let i = parts.length - 1;
    while (i > 1 && /^(van|von|der|den|de|la|le|da|di|del|bin|al|el)$/i.test(parts[i - 1])) i--;
    return { family: parts.slice(i).join(" "), given: parts.slice(0, i).join(" ") };
  }

  function cleanDoi(d) {
    const m = String(d || "").trim().match(/10\.\d{4,9}\/[^\s"<>]+/);
    return m ? m[0].replace(/[.,;)]+$/, "") : "";
  }

  function stripJats(s) { return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().replace(/^abstract\s*/i, ""); }

  function fromOpenAlex(w) {
    if (!w || !(w.title || w.display_name)) return null;
    const authors = (w.authorships || []).map((a) => a && a.author && splitName(a.author.display_name)).filter(Boolean);
    const src = w.primary_location && w.primary_location.source;
    const b = w.biblio || {};
    return {
      title: String(w.title || w.display_name).replace(/\s+/g, " ").trim(), authors, year: w.publication_year || null,
      venue: (src && src.display_name) || "", volume: b.volume || "", issue: b.issue || "",
      pages: b.first_page ? (b.last_page && b.last_page !== b.first_page ? b.first_page + "–" + b.last_page : b.first_page) : "",
      doi: cleanDoi(w.doi), abstract: abstractFromInverted(w.abstract_inverted_index), cited: w.cited_by_count || 0, type: w.type || "", from: "OpenAlex",
    };
  }

  function fromCrossref(m) {
    if (!m || !m.title || !m.title[0]) return null;
    const dp = (m.issued && m.issued["date-parts"] && m.issued["date-parts"][0]) || (m.published && m.published["date-parts"] && m.published["date-parts"][0]) || [];
    return {
      title: String(m.title[0]).replace(/\s+/g, " ").trim(),
      authors: (m.author || []).filter((a) => a.family).map((a) => ({ family: a.family, given: a.given || "" })),
      year: dp[0] || null, venue: (m["container-title"] && m["container-title"][0]) || "",
      volume: m.volume || "", issue: m.issue || "", pages: m.page ? String(m.page).replace("-", "–") : "",
      doi: cleanDoi(m.DOI), abstract: stripJats(m.abstract), cited: m["is-referenced-by-count"] || 0, type: m.type || "", from: "Crossref",
    };
  }

  function srcKey(s) { return s.doi ? s.doi.toLowerCase() : s.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

  // Merge lists from several searches: drop repeats and non-papers, keep the
  // order the database ranked them, mixing the searches round-robin so one
  // query does not crowd out the others.
  function mergeSources(lists, limit) {
    const out = [], seen = new Set();
    const longest = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < longest; i++) {
      for (const l of lists) {
        const s = l[i];
        if (!s || !s.year || !s.authors.length || /erratum|paratext|retraction|peer-review/i.test(s.type)) continue;
        const k = srcKey(s);
        if (seen.has(k)) continue;
        seen.add(k); out.push(s);
        if (out.length >= (limit || 16)) return out;
      }
    }
    return out;
  }

  // ---------------------------------------------------------- queries
  function buildQueryPrompt(p, brief) {
    return [
      "I need to search a scholarly database for papers a PhD research proposal should cite. Give me 5 short search queries.",
      "",
      `Programme: ${p.programme} at ${p.university}`,
      p.theme ? `Theme: ${p.theme}` : "",
      "",
      "Return ONLY a JSON array of 5 strings, no commentary. Each is 3 to 7 plain words that would appear in the title or abstract of real papers (technical terms, not sentences). Cover: the core problem, the main method, the application setting, evaluation or data, and one broader or neighbouring angle.",
      "Do not return paper titles, author names or years.",
      "",
      "WHAT THE APPLICANT WANTS TO DO:",
      String(brief || "").slice(0, 2500),
      p.advert ? "\nTHE ADVERT:\n" + p.advert.slice(0, 2500) : "",
    ].filter((x) => x !== "").join("\n");
  }

  function parseQueries(text) {
    const t = String(text || "");
    const a = t.indexOf("["), b = t.lastIndexOf("]");
    if (a < 0 || b <= a) throw new Error("Gemini did not return search queries I can read.");
    let arr;
    try { arr = JSON.parse(t.slice(a, b + 1)); } catch (e) { throw new Error("Gemini did not return search queries I can read."); }
    const out = (Array.isArray(arr) ? arr : []).filter((x) => typeof x === "string").map((x) => x.replace(/\s+/g, " ").trim())
      .filter((x) => x.length >= 6 && x.length <= 80 && !/\b(19|20)\d\d\b/.test(x));
    if (!out.length) throw new Error("Gemini did not return search queries I can read.");
    return out.slice(0, 6);
  }

  // ---------------------------------------------------------- citations
  // Harvard, Cite Them Right style:
  //   in text   (Smith, 2014)  (Smith and Jones, 2014)  (Smith, Jones and Davies, 2014)  (Smith et al., 2014)
  //   several   (Jamieson, 2011; Hollingworth, 2012): earliest first, same year by author
  //   same author and year: 2014a, 2014b
  //   list      Smith, T., Jones, F. and Davies, S. (2014) 'Title', *Journal*, 9(4), pp. 1–10. doi:10.xxxx/xxxx.
  //             four or more authors: Smith, T. et al. (2014) ...
  const initials = (g) => String(g || "").split(/\s+/).filter(Boolean)
    .map((w) => w.split("-").filter(Boolean).map((x) => x[0].toUpperCase() + ".").join("-")).join("");

  function authorYear(s) {
    const f = (a) => a.family, n = s.authors.length;
    const who = n === 1 ? f(s.authors[0])
      : n === 2 ? `${f(s.authors[0])} and ${f(s.authors[1])}`
      : n === 3 ? `${f(s.authors[0])}, ${f(s.authors[1])} and ${f(s.authors[2])}`
      : `${f(s.authors[0])} et al.`;
    return { who, year: s.year };
  }

  // 2014a / 2014b when two cited sources would otherwise read the same.
  function suffixMap(cited) {
    const groups = {};
    for (const s of cited) { const a = authorYear(s); (groups[a.who + "|" + a.year] = groups[a.who + "|" + a.year] || []).push(s); }
    const out = {};
    for (const g of Object.values(groups)) {
      if (g.length < 2) continue;
      g.sort((x, y) => x.title.localeCompare(y.title)).forEach((s, i) => { out[s.id] = String.fromCharCode(97 + i); });
    }
    return out;
  }

  function referenceLine(s, suf) {
    const names = s.authors.map((a) => (a.given ? `${a.family}, ${initials(a.given)}` : a.family));
    const au = names.length >= 4 ? names[0] + " et al." : names.length > 1 ? names.slice(0, -1).join(", ") + " and " + names[names.length - 1] : names[0];
    const isBook = /^(book|monograph|dissertation)$/i.test(s.type);
    const title = s.title.replace(/[.\s]+$/, "");
    const vol = s.volume ? s.volume + (s.issue ? `(${s.issue})` : "") : "";
    const pages = s.pages ? (/[–-]/.test(s.pages) ? "pp. " : "p. ") + s.pages.replace("-", "–") : "";
    const tail = [vol, pages].filter(Boolean).join(", ");
    const head = `${au} (${s.year}${suf || ""})`;
    if (isBook) return `${head} *${title}*.${s.doi ? " doi:" + s.doi + "." : ""}`;
    const pre = /preprint/i.test(s.type) ? " [Preprint]" : "";
    const venue = s.venue ? `, *${s.venue}*` : "";
    return `${head} ‘${title}’${venue}${tail ? (s.venue ? ", " : ", ") + tail : ""}${pre}.${s.doi ? " doi:" + s.doi + "." : ""}`.replace(/\.\.$/, ".");
  }

  // A reference line a person has to finish by hand: no journal or no pages or DOI.
  function referenceGaps(s) {
    const gaps = [];
    if (!s.venue && !/preprint/i.test(s.type)) gaps.push("the journal or publisher");
    if (!s.doi) gaps.push("a DOI or URL");
    if (!s.authors.every((a) => a.given)) gaps.push("authors' initials");
    return gaps;
  }

  // Markdown italics -> HTML, so the references paste into Word italicised.
  function referenceHtml(line) {
    const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return esc(line).replace(/\*([^*]+)\*/g, "<i>$1</i>");
  }

  const TAG = /\[(S\d+(?:\s*[,;]\s*S\d+)*)\]/g;

  // sources: the numbered list the model saw, [{id: "S1", ...}].
  function verifyCitations(text, sources) {
    const known = new Set(sources.map((s) => s.id));
    const cited = [], unknown = [];
    let m; const rx = new RegExp(TAG.source, "g");
    while ((m = rx.exec(text))) for (const id of m[1].split(/\s*[,;]\s*/)) {
      if (known.has(id)) { if (!cited.includes(id)) cited.push(id); } else if (!unknown.includes(id)) unknown.push(id);
    }
    // Author-year text the model typed itself, which has no source behind it.
    const selfTyped = [];
    const ay = /\(([A-Z][A-Za-z'’\-]+(?:,? (?:and |& )?[A-Z][A-Za-z'’\-]+){0,2}(?: et al\.?)?),? ((?:19|20)\d\d)[a-z]?\)/g;
    while ((m = ay.exec(text))) selfTyped.push(m[0]);
    return { cited, unknown, selfTyped, uncitedAvailable: sources.filter((s) => !cited.includes(s.id)).map((s) => s.id) };
  }

  // [S1, S3] -> (Smith, 2020; Jones and Li, 2021). Earliest first. Unknown tags are removed.
  function renderCitations(text, sources) {
    const by = new Map(sources.map((s) => [s.id, s]));
    const citedIds = verifyCitations(text, sources).cited;
    const suf = suffixMap(citedIds.map((id) => by.get(id)));
    return text.replace(new RegExp(TAG.source, "g"), (all, ids) => {
      const parts = ids.split(/\s*[,;]\s*/).map((id) => by.get(id)).filter(Boolean)
        .sort((a, b) => a.year - b.year || authorYear(a).who.localeCompare(authorYear(b).who) || a.title.localeCompare(b.title))
        .map((s) => { const a = authorYear(s); return `${a.who}, ${a.year}${suf[s.id] || ""}`; });
      return parts.length ? `(${parts.join("; ")})` : "";
    }).replace(/ +([.,;:])/g, "$1").replace(/[ \t]{2,}/g, " ");
  }

  function referenceList(sources, citedIds) {
    const cited = sources.filter((s) => citedIds.includes(s.id));
    const suf = suffixMap(cited);
    return cited.sort((a, b) => a.authors[0].family.localeCompare(b.authors[0].family) || a.year - b.year || a.title.localeCompare(b.title))
      .map((s) => referenceLine(s, suf[s.id]));
  }

  // --------------------------------------------------------- the brief
  function targetWords(advert) {
    const t = String(advert || "");
    const re = /(\d[\d,]{2,5})\s*(?:-|\s)?words?/gi; let m; const found = [];
    while ((m = re.exec(t))) {
      const n = parseInt(m[1].replace(/,/g, ""), 10);
      // Only the sentence the number is in, so "500 words. The proposal ..." is not read as a proposal limit.
      const start = Math.max(t.lastIndexOf(". ", m.index), t.lastIndexOf("\n", m.index), 0);
      const after = t.slice(m.index + m[0].length).search(/\. |\n/);
      const ctx = t.slice(start, after < 0 ? t.length : m.index + m[0].length + after).toLowerCase();
      if (n >= 500 && n <= 6000 && /proposal|research plan|project description/.test(ctx)) found.push(n);
    }
    return found.length ? found[0] : 1500;
  }

  const SECTIONS = [
    "Title", "Background and motivation", "Related work", "Research questions and aims", "Methodology",
    "Data and evaluation", "Plan for three years", "Expected contribution", "Risks and feasibility",
  ];

  function briefProblem(brief, base) {
    const words = wordsOf(brief).length + (wordsOf(base).length >= 200 ? 200 : 0);
    return words < 40
      ? "The proposal needs a direction. Press Suggest research directions (it draws them from your own account of what you have done) and pick one, or write a few lines of your own about what you want to investigate and the method you have in mind."
      : "";
  }


  // ------------------------------------------------- directions from your story
  // The applicant's own account (an interview, an essay, a long CV) is the
  // record of what they have done. A direction is only worth anything if it
  // rests on that record, so every piece of evidence the model offers is a
  // quote, and the code checks the quote really is in the text.
  function normText(t) {
    return String(t || "").toLowerCase().replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, "-")
      .replace(/[^a-z0-9]+/g, " ").trim();
  }
  function quoteFound(quote, corpus) {
    const q = normText(quote);
    return q.split(" ").length >= 5 && normText(corpus).includes(q);
  }

  function buildDirectionsPrompt(o) {
    const p = o.programme;
    return [
      "A PhD applicant wants research directions for the programme below, drawn from what they have actually done. Give exactly THREE directions, different in emphasis: (1) the closest match to the advert's theme, (2) the one that rests most on the applicant's strongest experience, (3) the most ambitious one that is still realistic for a first PhD.",
      "",
      `University: ${p.university}`, `Programme: ${p.programme}`,
      p.theme ? `Research theme: ${p.theme}` : "", p.supervisor ? `Supervisor: ${p.supervisor}` : "",
      "",
      "Return ONLY a JSON object, no commentary and no code fence:",
      '{"directions":[{"title": string (a working title, under 14 words), "question": string (one research question, one sentence), "approach": string (2 or 3 sentences: the method in plain terms), "evidence": [string] (2 to 4 quotes), "gaps": [string] (1 to 3 items), "fit": string (one sentence: how it matches this programme)}]}',
      "",
      "RULES:",
      "- evidence: each item must be copied EXACTLY, word for word, from the applicant's own account or CV below: a sentence or part of one, 6 to 30 words, no paraphrase, no joining of separate sentences. These show why this applicant, with this background, is the right person for the direction.",
      "- gaps: what this direction needs that the applicant has NOT done or has said they find hard, taken from their own account (their weaknesses, things they have not worked on). Be honest. Do not turn a weakness into a strength.",
      "- Weigh everything in proportion: the direction should rest mainly on the experience that matters most for this programme, not on everything the applicant has ever done.",
      "- Do not invent experience, results or skills. If the theme does not suit this applicant, say so in that direction's fit.",
      "- The questions must be genuine research questions that a three-year PhD could answer, not tasks or product ideas.",
      "",
      "APPLICANT'S OWN ACCOUNT:", String(o.story || "").slice(0, 40000),
      "\nAPPLICANT CV:", o.cv,
      o.base ? "\nAPPLICANT'S EXISTING PROPOSAL DRAFT:\n" + o.base.slice(0, 5000) : "",
      p.advert ? "\nTHE ADVERT:\n" + p.advert.slice(0, 5000) : "",
    ].filter((x) => x !== "").join("\n");
  }

  function parseDirections(text, evidenceCorpus) {
    const t = String(text || "");
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    let o;
    try { o = JSON.parse(t.slice(a, b + 1)); } catch (e) { o = null; }
    if (!o || !Array.isArray(o.directions) || !o.directions.length) throw new Error("Gemini did not return research directions in a form I can read. Try again.");
    const str = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
    const list = (v) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
    return o.directions.slice(0, 3).map((d) => {
      const ev = list(d.evidence);
      const quotes = ev.filter((q) => quoteFound(q, evidenceCorpus));
      return { title: str(d.title) || "Untitled direction", question: str(d.question), approach: str(d.approach), quotes, unverified: ev.length - quotes.length, gaps: list(d.gaps).slice(0, 3), fit: str(d.fit), weak: quotes.length === 0 };
    }).filter((d) => d.question);
  }

  // The notes the proposal is written from, assembled from a chosen direction.
  function directionToBrief(d) {
    return [
      `Research question: ${d.question}`,
      `Approach: ${d.approach}`,
      d.quotes.length ? "What in my own background supports it (my words):\n" + d.quotes.map((q) => `- "${q}"`).join("\n") : "",
      d.gaps.length ? "What I still need to learn or have not done:\n" + d.gaps.map((g) => `- ${g}`).join("\n") : "",
      d.fit ? `Fit with this programme: ${d.fit}` : "",
    ].filter(Boolean).join("\n\n");
  }

  // ------------------------------------------------------------ numbers
  // Invented figures are the commonest way a draft goes wrong ("six years",
  // "4 million subscribers"). Every number in the text must be somewhere in
  // what the applicant gave: their account, CV, notes, the advert, or the
  // abstracts of the sources. Plan lengths (months, weeks) and plan years
  // are exempt.
  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50 };

  function numberCheck(text, facts) {
    const body = stripTags(text);
    const f = String(facts || "").toLowerCase().replace(/(\d),(?=\d{3})/g, "$1");
    const flagged = [];
    const seen = new Set();
    const add = (label) => { if (!seen.has(label)) { seen.add(label); flagged.push(label); } };
    const re = /(?<![\w.])(\d+(?:\.\d+)?)(%|\s?per ?cent)?(?:[ -]+(years?|months?|weeks?|days?))?(?![\w])/gi;
    let m; const clean = body.replace(/(\d),(?=\d{3})/g, "$1");
    while ((m = re.exec(clean))) {
      const num = m[1], unit = (m[3] || "").toLowerCase();
      const val = parseFloat(num);
      if (/^(month|week|day)/.test(unit)) continue;
      const ctx = clean.slice(Math.max(0, m.index - 16), m.index).toLowerCase();
      if (/(month|week|year|phase|stage|section|chapter|figure|fig\.|table|package|wp)s?[ \d,\-–and&]*$/.test(ctx)) continue;
      if (val >= 2024 && val <= 2032 && !m[2] && !unit) continue;
      if (val < 4 && !num.includes(".") && !m[2] && !/^year/.test(unit)) continue;
      const claim = /^year/.test(unit) ? new RegExp(`(?<![\\d.])${num}[ -]+years?\\b`).test(f) : new RegExp(`(?<![\\d.])${num.replace(".", "\\.")}(?![\\d])`).test(f);
      if (!claim) add(`${m[0].trim()}`);
    }
    const wre = new RegExp(`\\b(${Object.keys(NUM_WORDS).join("|")})[ -]+years?\\b`, "gi");
    while ((m = wre.exec(body))) {
      const w = m[1].toLowerCase(), d = NUM_WORDS[w];
      if (!new RegExp(`\\b(${w}|${d})[ -]+years?\\b`).test(f)) add(m[0]);
    }
    return flagged;
  }


  // ---------------------------------------------------- everything from sources
  // The rule is: statements about the field come from the listed papers, so
  // each carries a tag; statements about the applicant come from their own
  // account; statements about the plan are the applicant's plan. Two checks:
  // a sentence in a factual section with none of those is flagged, and a tagged
  // sentence that shares almost no wording with its paper is flagged.
  const CLAIM_SECTIONS = ["background and motivation", "related work", "methodology", "data and evaluation"];
  const SELF_OR_PLAN = /\b(I|my|me|we|our|us)\b|\bthis (project|research|proposal|study|work|thesis|phd)\b|\b(will|would|aim to|plan to|intend to|propose to|hope to)\b/i;
  const FILLER = new Set(("the and for with that this from will have been are was were you your our their they them its into over under about than then also such more most other some any all can may must should would could able each both between within across through during using used use based show shows shown study studies paper work approach method methods results result new data").split(" "));
  const stemW = (w) => (w.length <= 4 ? w : w.endsWith("ing") ? w.slice(0, -3) : w.endsWith("ies") ? w.slice(0, -3) + "y" : w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  const stems = (t) => new Set((String(t || "").toLowerCase().match(/[a-z][a-z0-9+#]{2,}/g) || []).filter((w) => !FILLER.has(w)).map(stemW));

  function splitSections(text) {
    const heads = SECTIONS.map((x) => x.toLowerCase());
    const out = []; let cur = { heading: "", body: [] };
    for (const line of String(text || "").split("\n")) {
      if (heads.includes(line.trim().toLowerCase())) { out.push(cur); cur = { heading: line.trim().toLowerCase(), body: [] }; }
      else cur.body.push(line);
    }
    out.push(cur);
    return out.map((x) => ({ heading: x.heading, body: x.body.join("\n") }));
  }

  function uncitedClaims(text) {
    const out = [];
    for (const sec of splitSections(text)) {
      if (!CLAIM_SECTIONS.includes(sec.heading)) continue;
      const raw = sec.body.replace(/\r/g, "");
      // keep tags in view: split sentences on the tagged text
      const sents = raw.replace(/\b(et al|e\.g|i\.e|etc|vs|cf|approx|Fig|No)\./g, "$1\u0001").split(/(?<=[.!?])(?:\s*\[S[\d, S]+\])?["')\]]*\s+(?=["'(\[]?[A-Z0-9])|\n+/)
        .map((x) => x.replace(/\u0001/g, ".").trim()).filter((x) => x);
      for (const sent of sents) {
        if (wordsOf(sent).length < 6) continue;
        if (/\[S\d/.test(sent) || SELF_OR_PLAN.test(sent)) continue;
        out.push({ section: sec.heading, sentence: sent });
      }
    }
    return out;
  }

  function supportCheck(text, sources) {
    const by = new Map(sources.map((s) => [s.id, s]));
    const weak = [];
    const sents = String(text || "").split(/(?<=\])\s*(?=[A-Z])|(?<=[.!?])\s+(?=[A-Z0-9"'(])|\n+/).map((x) => x.trim()).filter(Boolean);
    for (const sent of sents) {
      const tags = []; let m; const rx = new RegExp(TAG.source, "g");
      while ((m = rx.exec(sent))) for (const id of m[1].split(/\s*[,;]\s*/)) if (by.has(id)) tags.push(id);
      if (!tags.length) continue;
      const mine = stems(sent.replace(new RegExp(TAG.source, "g"), ""));
      if (mine.size < 4) continue;
      const theirs = new Set();
      for (const id of tags) { const s = by.get(id); for (const w of stems(`${s.title} ${s.abstract || ""} ${s.notes || ""}`)) theirs.add(w); }
      let shared = 0; for (const w of mine) if (theirs.has(w)) shared++;
      const need = mine.size >= 8 ? 3 : 2;
      if (shared < need) weak.push({ sentence: sent.replace(new RegExp(TAG.source, "g"), "").replace(/\s+/g, " ").trim(), tags, shared });
    }
    return weak;
  }

  // ------------------------------------------------------------ prompts
  function srcBlock(sources) {
    return sources.map((s) => {
      const a = authorYear(s);
      return `[${s.id}] ${a.who} (${s.year}). ${s.title}.${s.venue ? " " + s.venue + "." : ""}\n    ${s.abstract ? "Abstract: " + s.abstract.slice(0, 1500) : "No abstract available: cite this only for what its title states."}${s.notes ? "\n    Passages the applicant copied from the full paper: " + s.notes.slice(0, 3000) : ""}`;
    }).join("\n");
  }

  function buildProposalPrompt(o) {
    const p = o.programme;
    return [
      "You are helping a PhD applicant write THEIR OWN research proposal for the programme below. It will be submitted under their name, so it must contain their ideas, in their voice. You are drafting from their notes, not inventing a project.",
      "",
      `University: ${p.university}`, `Programme: ${p.programme}`,
      p.theme ? `Research theme: ${p.theme}` : "", p.supervisor ? `Supervisor: ${p.supervisor}` : "",
      (p.requirements || []).length ? "What the advert asks for:\n- " + p.requirements.join("\n- ") : "",
      "",
      "THE RULES, IN ORDER OF IMPORTANCE",
      "1. EVERYTHING FROM THE SOURCES. Any statement about the field, a method, a result, a problem or what is known must come from the SOURCES below, from their abstracts or the passages the applicant copied, and must carry its tag right after the claim, like [S3] or [S2, S5]. Use none of your own knowledge of the field, no other papers, and no 'well-known' or 'it is widely accepted' claims. If the sources do not say it, do not say it. A claim carries a tag only if that paper's text actually says it. A statement about the applicant comes only from their account or CV. A statement about the project is the applicant's plan, in the future tense. If the sources are too thin to fill a section, write that section shorter and say so plainly. Do not pad.",
      "2. CITATION FORM. Cite only by tag. Never write an author name, a year or a reference list yourself, and never cite anything not in the list.",
      "3. NOTHING INVENTED. No made-up results, numbers, datasets, tools, collaborators or things the applicant has done. Planned work is described as planned.",
      "4. THEIR PROJECT. Keep the applicant's own research question, method and ideas from their notes" + (o.base ? " and their existing draft (improve and align it, do not replace it)" : "") + ". Shape the framing and the aims to fit this programme's theme. If their work does not really fit the theme, start with one line 'NOTE: ...' saying what does not fit, and then write the best honest proposal anyway.",
      o.story ? "5. THEIR OWN ACCOUNT below is the record of what they have done. Describe their experience only as that account and the CV describe it, and in proportion: lead with what matters most for this programme, give a small relevant detail one sentence, and leave out what is not relevant. Their weaknesses and gaps are real: where one matters for feasibility, say so plainly and say how the plan or training deals with it. Never present a gap as a strength. Every number, duration and employer must match the account or CV." : "",
      `6. LENGTH. About ${o.target} words (within 10 percent), not counting the title line. Shorter is better than padded.`,
      "7. STRUCTURE. Plain text. These section headings, each on its own line with no symbols or numbering: " + SECTIONS.join("; ") + ". No bullet points or tables. The three-year plan is three short paragraphs, one per year.",
      "8. VOICE. Write the way this applicant writes: their sentence rhythm, their openers, their punctuation and spelling, in the register of a research proposal (more formal than speech, still theirs). Their style, measured from their own writing:\n" + o.styleText,
      o.excerpts && o.excerpts.length ? "Passages of their own writing, to show how they write. Copy neither their sentences nor their content:\n" + o.excerpts.map((e, i) => `(${i + 1}) ${e}`).join("\n") : "",
      "9. PLAIN WRITING. Say the specific thing. Open sections with the point, not with scene-setting. No rhetorical questions. No closing paragraph that restates what you have said. Vary how sentences begin. Do not use any of these: " + SLOP_LABELS.join(", ") + ".",
      "",
      "APPLICANT'S NOTES (their words):", o.brief || "(none given)",
      o.base ? "\nAPPLICANT'S EXISTING PROPOSAL DRAFT:\n" + o.base.slice(0, 6000) : "",
      o.story ? "\nAPPLICANT'S OWN ACCOUNT OF WHAT THEY HAVE DONE:\n" + o.story.slice(0, 40000) : "",
      "\nAPPLICANT CV:", o.cv,
      o.programme.advert ? "\nTHE ADVERT:\n" + o.programme.advert.slice(0, 5000) : "",
      "\nSOURCES (the only citable papers):", srcBlock(o.sources),
    ].filter((x) => x !== "").join("\n");
  }

  function buildRevisePrompt(o) {
    return [
      "Below is a research proposal draft and a list of specific problems found by a checker. Fix ONLY those problems and change nothing else.",
      "",
      "PROBLEMS:",
      ...o.problems.map((x) => "- " + x),
      "",
      "RULES:",
      "- Rewrite only the sentences involved, in the applicant's own plain voice. Keep every other sentence exactly as it is.",
      "- Keep every [S#] tag attached to the claim it supports. Do not add any new citation, author name or year. Remove a citation tag only if the sentence it supported is removed or no longer says that.",
      "- Do not add new facts, results or claims. Keep the section headings and the length within 10 percent.",
      "- Return the full proposal text only.",
      o.styleText ? "\nVoice to keep:\n" + o.styleText : "",
      "\nSOURCES (the only citable papers):", srcBlock(o.sources),
      "\nDRAFT:", o.draft,
    ].filter((x) => x !== "").join("\n");
  }

  // Everything the checker found, as plain sentences for the revision prompt.
  function problemsFor(report, target) {
    const out = [];
    for (const u of (report.uncited || [])) out.push(`In "${u.section}" this sentence has no citation and is not about you or your plan, so it may come from outside the sources: "${u.sentence}". Support it with a listed source that says it, or cut it.`);
    for (const w of (report.weakSupport || [])) out.push(`This sentence is cited to ${w.tags.map((t) => "[" + t + "]").join(", ")} but shares almost no wording with that paper's abstract, so the paper may not say it: "${w.sentence}". Cite a source that does say it, or cut the claim.`);
    for (const n of (report.numbers || [])) out.push(`The figure "${n}" is not in the applicant's account, CV, notes, advert or the source abstracts. Remove it or state it without a number.`);
    for (const id of report.cites.unknown) out.push(`The tag [${id}] is not in the source list. Remove it or replace it with a listed source that really supports the claim.`);
    for (const s of report.cites.selfTyped) out.push(`"${s}" is an author-year citation written by hand. Remove it, or use a [S#] tag from the list if a listed source supports the claim.`);
    for (const i of report.slop.issues) out.push(`Stock phrase "${i.label}" used ${i.count} time${i.count === 1 ? "" : "s"}${i.allowed ? ` (allowed ${i.allowed})` : ""}, for example: "${i.examples[0]}". Say the specific thing plainly instead.`);
    for (const r of report.style.flagged) out.push(`Voice: ${r.label}: yours ${r.yours}, draft ${r.draft}. ${r.why}`);
    if (target && report.words) {
      if (report.words > target * 1.15) out.push(`It is ${report.words} words; the target is ${target}. Cut the weakest sentences.`);
      if (report.words < target * 0.8) out.push(`It is ${report.words} words; the target is ${target}. Develop the thinnest sections using only the applicant's notes and the sources.`);
    }
    return out;
  }

  // One pass of every check on a draft (the version with [S#] tags).
  function checkDraft(draft, sources, yourProfile, target, facts) {
    const body = draft.replace(/^\s*NOTE:[^\n]*\n+/i, "");
    const prof = styleProfile(body);
    const report = {
      words: prof.words,
      cites: verifyCitations(body, sources),
      slop: slopCheck(body),
      style: yourProfile ? compareStyle(yourProfile, prof) : { rows: [], flagged: [] },
      profile: prof,
      numbers: facts ? numberCheck(body, facts + "\n" + sources.map((x) => `${x.abstract} ${x.title} ${x.notes || ""}`).join("\n")) : [],
      uncited: uncitedClaims(body),
      weakSupport: supportCheck(body, sources),
    };
    report.problems = problemsFor(report, target);
    report.score = report.problems.length;
    return report;
  }

  // Wording only, for text that has already been through citation rendering
  // (author-year text there is legitimate, so citations are not re-checked).
  function checkWording(text, yourProfile, target, facts) {
    const body = String(text || "").split(/\n\nReferences\n\n/)[0].replace(/^\s*NOTE:[^\n]*\n+/i, "");
    const prof = styleProfile(body);
    const report = { words: prof.words, cites: { cited: [], unknown: [], selfTyped: [] }, slop: slopCheck(body),
      style: yourProfile ? compareStyle(yourProfile, prof) : { rows: [], flagged: [] }, profile: prof,
      numbers: facts ? numberCheck(body, facts) : [] };
    report.problems = problemsFor(report, target);
    return report;
  }

  function finalize(draft, sources, report) {
    const note = (draft.match(/^\s*NOTE:[^\n]*/i) || [""])[0].trim();
    const body = draft.replace(/^\s*NOTE:[^\n]*\n+/i, "");
    const text = renderCitations(body, sources).trim();
    const refs = referenceList(sources, report.cites.cited);
    return { note, text: text + (refs.length ? "\n\nReferences\n\n" + refs.join("\n\n") : ""), references: refs };
  }

  root.Proposal = {
    MIN_STYLE_WORDS, SECTIONS, styleProfile, describeStyle, styleExcerpts, compareStyle, slopCheck, SLOP_LABELS,
    abstractFromInverted, splitName, cleanDoi, fromOpenAlex, fromCrossref, mergeSources,
    buildQueryPrompt, parseQueries, uncitedClaims, supportCheck, referenceGaps, referenceHtml, suffixMap, quoteFound, buildDirectionsPrompt, parseDirections, directionToBrief, numberCheck, authorYear, referenceLine, verifyCitations, renderCitations, referenceList,
    targetWords, briefProblem, buildProposalPrompt, buildRevisePrompt, problemsFor, checkDraft, checkWording, finalize, splitSentences,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = { Proposal: root.Proposal };
})(typeof self !== "undefined" ? self : this);
