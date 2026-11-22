/* Fluency: everything beyond single words. More units at the next CEFR level,
   reading passages, grammar lessons, conversation practice with corrections,
   and a level check. The AI writes the material; this file builds the prompts,
   reads the answers back, and checks what can be checked without trusting the
   AI: quotes must be in the passage, answers must be accepted by the grader,
   corrections must differ from what the learner wrote, and a second pass solves
   every question blind (without the key) and any item it disagrees with is
   dropped. */
(function (root) {
  "use strict";
  const L = root.Lang || (typeof require !== "undefined" ? require("./lang.js") : null);
  const CEFR = L.CEFR;
  const str = (v, n) => String(typeof v === "string" ? v : "").trim().slice(0, n || 300);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const nextCefr = (c) => CEFR[Math.min(CEFR.length - 1, Math.max(0, CEFR.indexOf(c)) + 1)];
  const prevCefr = (c) => CEFR[Math.max(0, CEFR.indexOf(c) - 1)];
  const CEFR_HELP = {
    A1: "A1 (first words and very simple sentences)", A2: "A2 (simple everyday exchanges)", B1: "B1 (can deal with most travel and routine situations)",
    B2: "B2 (can follow and take part in fairly complex talk)", C1: "C1 (fluent, flexible use for work and study)", C2: "C2 (near-native precision and nuance)",
  };
  const has = (hay, needle) => { const n = L.normalize(needle); return n.length > 0 && L.normalize(hay).indexOf(n) >= 0; };
  const mkSqueeze = (s) => L.normalize(s).replace(/\s+/g, "");
  const inside = (hay, needle) => { const n = mkSqueeze(needle); return n.length > 1 && mkSqueeze(hay).indexOf(n) >= 0; };
  const who = (c) => c.name + " (learner's own language: " + c.from + ")";

  // ------------------------------------------------------------ more units
  function buildMoreUnitsPrompt(o) {
    const done = (o.course.units || []).map((u) => u.title).slice(-40).join("; ");
    return [
      "You are an experienced " + o.course.name + " teacher planning the next part of a course for a learner whose own language is " + o.course.from + ".",
      "The learner is working at CEFR " + (CEFR_HELP[o.cefr] || o.cefr) + ". Purpose: " + (o.course.goalText || "everyday life") + ".",
      done ? "Units already in the course (do not repeat them): " + done : "",
      "Plan " + (o.count || 6) + " new units at this level, in a sensible order, each a topic with a short focus of the vocabulary and sentence patterns it covers. Write titles and focus in " + o.course.from + ".",
      "Return ONLY JSON: {\"units\":[{\"title\":\"...\",\"focus\":\"...\"}]}",
    ].filter(Boolean).join("\n");
  }
  function parseMoreUnits(text, existing) {
    const j = L.parseJson(text); if (!j || typeof j !== "object") return null;
    const have = new Set((existing || []).map((t) => L.normalize(t))), out = [];
    for (const u of Array.isArray(j.units) ? j.units : []) {
      const title = str(u && u.title, 80); if (!title || have.has(L.normalize(title))) continue;
      have.add(L.normalize(title)); out.push({ title, focus: str(u.focus, 240) });
    }
    return out.length >= 3 ? out.slice(0, 8) : null;
  }

  // ------------------------------------------------------------ reading
  function buildReadPrompt(o) {
    const known = (o.known || []).slice(0, 60).join(", ");
    const lang = L.CEFR.indexOf(o.cefr) >= 2 ? "the learner's language" : "the learner's language";
    return [
      "You are an experienced " + o.course.name + " teacher writing a reading text for a learner whose own language is " + o.course.from + ".",
      "Level: CEFR " + (CEFR_HELP[o.cefr] || o.cefr) + ". Purpose: " + (o.course.goalText || "everyday life") + ". Topic: " + (o.topic || "something from everyday life, chosen by you") + ".",
      "Write natural " + o.course.name + " a native speaker would write, at this level: " + (L.CEFR.indexOf(o.cefr) < 2 ? "60 to 100 words" : L.CEFR.indexOf(o.cefr) < 4 ? "120 to 200 words" : "200 to 300 words") + " in 2 to 4 paragraphs. Do not use facts about real people.",
      known ? "Words the learner already knows (prefer them): " + known : "",
      "",
      "Return ONLY JSON: {\"title\":\"title in " + o.course.name + "\",\"paragraphs\":[{\"text\":\"paragraph in " + o.course.name + "\",\"roman\":\"romanisation or empty\",\"meaning\":\"faithful translation into " + o.course.from + "\"}],\"glosses\":[{\"word\":\"a word or phrase copied EXACTLY as written in the text\",\"meaning\":\"its meaning here, in " + o.course.from + "\"}],\"questions\":[{\"q\":\"comprehension question in " + o.course.from + "\",\"options\":[\"four\",\"short\",\"different\",\"options\"],\"answer\":0,\"evidence\":\"the sentence or phrase copied EXACTLY from the text that proves the answer\"}]}",
      "Rules: 8 to 12 glosses of words the learner may not know; 4 questions that can only be answered from the text, one clearly correct option each, answer is the 0-based index of the correct option. If you are not sure of any detail, leave it out.",
    ].filter(Boolean).join("\n");
  }
  function cleanQuestion(x, passage, rng) {
    const q = str(x && x.q, 300), opts = [];
    for (const o of Array.isArray(x && x.options) ? x.options : []) { const t = str(o, 200); if (t && !opts.some((y) => L.normalize(y) === L.normalize(t))) opts.push(t); }
    const idx = Number(x && x.answer);
    if (!q || opts.length < 3 || opts.length > 5 || !Number.isInteger(idx) || idx < 0 || idx >= (Array.isArray(x.options) ? x.options.length : 0)) return null;
    const right = str(x.options[idx], 200); if (!right || opts.findIndex((y) => L.normalize(y) === L.normalize(right)) < 0) return null;
    if (passage !== null && !inside(passage, str(x.evidence, 400))) return null;
    const shuffled = L.shuffle(opts, rng);
    return { q, options: shuffled, answer: shuffled.findIndex((y) => L.normalize(y) === L.normalize(right)), evidence: str(x.evidence, 400) };
  }
  function parseRead(text, o) {
    const j = L.parseJson(text); if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    const rng = (o && o.rng) || Math.random;
    const paragraphs = (Array.isArray(j.paragraphs) ? j.paragraphs : []).map((p) => ({ text: str(p && p.text, 1500), roman: str(p && p.roman, 1800), meaning: str(p && p.meaning, 1800) })).filter((p) => p.text).slice(0, 6);
    const full = paragraphs.map((p) => p.text).join("\n");
    if (paragraphs.length < 1 || full.length < 50) return { ok: false, reason: "The text that came back was too short." };
    const seen = new Set(), glosses = [];
    for (const g of Array.isArray(j.glosses) ? j.glosses : []) {
      const word = str(g && g.word, 80), meaning = str(g && g.meaning, 160);
      if (!word || !meaning || full.indexOf(word) < 0 || seen.has(L.normalize(word))) continue;
      seen.add(L.normalize(word)); glosses.push({ word, meaning });
    }
    const questions = (Array.isArray(j.questions) ? j.questions : []).map((x) => cleanQuestion(x, full, rng)).filter(Boolean).slice(0, 6);
    if (questions.length < 3) return { ok: false, reason: "Too few questions could be tied to the text." };
    return { ok: true, title: str(j.title, 120) || "Reading", paragraphs, glosses: glosses.slice(0, 14), questions };
  }
  // Where each gloss sits in a paragraph, so the page can mark it.
  function glossSpans(text, glosses) {
    const spans = [];
    for (const g of glosses) {
      let from = 0;
      for (;;) { const i = text.indexOf(g.word, from); if (i < 0) break; if (!spans.some((s) => i < s.end && i + g.word.length > s.start)) spans.push({ start: i, end: i + g.word.length, word: g.word, meaning: g.meaning }); from = i + g.word.length; }
    }
    return spans.sort((a, b) => a.start - b.start);
  }
  function glossItem(g) { return { id: L.itemId(g.word), target: g.word, roman: "", meaning: g.meaning, alts: [], example: null }; }

  // ------------------------------------------------------------ blind second pass
  function buildSolvePrompt(course, questions) {
    const lines = questions.map((q, i) => {
      const body = [(q.context ? "Text: " + q.context + "\n" : "") + "Question: " + q.q];
      if (q.sentence) body.push("Sentence with a gap: " + q.sentence + (q.meaning ? "\nMeaning of the full sentence: " + q.meaning : ""));
      if (q.options) body.push("Options:\n" + q.options.map((o, k) => "  " + k + ". " + o).join("\n"));
      return i + ".\n" + body.join("\n");
    });
    return [
      "You are a careful " + course.name + " speaker who also reads " + course.from + ". Answer each numbered question yourself. Each has exactly one correct answer.",
      "For multiple choice, answer with the option number. For a gap, answer with the exact word or words that fill the gap. If a question is faulty or has no clear single answer, answer null.",
      "", lines.join("\n\n"), "",
      "Return ONLY JSON: {\"answers\":[{\"index\":0,\"answer\":0}]} with one entry per question.",
    ].join("\n");
  }
  function parseSolve(text, n) {
    const j = L.parseJson(text); if (!j || typeof j !== "object") return null;
    const out = new Array(n).fill(undefined);
    for (const a of Array.isArray(j.answers) ? j.answers : []) { const i = Number(a && a.index); if (Number.isInteger(i) && i >= 0 && i < n) out[i] = a.answer; }
    return out;
  }
  // Keep only what the blind solver agreed with. Missing or null answers drop the item.
  function applySolve(questions, answers) {
    const kept = [], dropped = [];
    questions.forEach((q, i) => {
      const a = answers[i]; let ok = false;
      if (a !== undefined && a !== null) {
        if (q.options && q.kind !== "fill") ok = Number(a) === q.answer;
        else ok = L.gradeTyped(String(a), q.accepted || [q.expected]).result !== "wrong";
      }
      (ok ? kept : dropped).push(q);
    });
    return { kept, dropped };
  }

  // ------------------------------------------------------------ grammar
  function buildGrammarTopicsPrompt(o) {
    return [
      "You are an experienced " + o.course.name + " teacher. List the 8 most useful grammar topics for a learner at CEFR " + (CEFR_HELP[o.cefr] || o.cefr) + " whose own language is " + o.course.from + ", in a sensible teaching order.",
      "Purpose: " + (o.course.goalText || "everyday life") + ". Name each topic in " + o.course.from + " (you may add the " + o.course.name + " term in brackets).",
      "Return ONLY JSON: {\"topics\":[{\"title\":\"...\",\"focus\":\"one line on what it covers\"}]}",
    ].join("\n");
  }
  function parseTopics(text) {
    const j = L.parseJson(text); if (!j || typeof j !== "object") return null;
    const seen = new Set(), out = [];
    for (const t of Array.isArray(j.topics) ? j.topics : []) { const title = str(t && t.title, 80); if (!title || seen.has(L.normalize(title))) continue; seen.add(L.normalize(title)); out.push({ title, focus: str(t.focus, 200), done: false }); }
    return out.length >= 4 ? out.slice(0, 10) : null;
  }
  function buildGrammarPrompt(o) {
    return [
      "You are an experienced " + o.course.name + " teacher writing one short grammar lesson for a learner whose own language is " + o.course.from + ". Level: CEFR " + (CEFR_HELP[o.cefr] || o.cefr) + ".",
      "TOPIC: " + o.topic.title + (o.topic.focus ? " (" + o.topic.focus + ")" : ""),
      "Explain the rule plainly in " + o.course.from + ", in 3 to 6 sentences, with the usual exceptions only if they matter at this level. Do not invent rules; if you are unsure about a detail, leave it out.",
      "",
      "Return ONLY JSON: {\"title\":\"...\",\"rule\":\"the explanation in " + o.course.from + "\",\"patterns\":[{\"target\":\"a pattern or form in " + o.course.name + "\",\"roman\":\"\",\"meaning\":\"what it does, in " + o.course.from + "\"}],\"examples\":[{\"target\":\"a correct natural sentence\",\"roman\":\"\",\"meaning\":\"translation\"}],\"mistakes\":[\"a common mistake learners make, in " + o.course.from + "\"],\"exercises\":[{\"kind\":\"fill\",\"sentence\":\"a correct " + o.course.name + " sentence with the target word or words replaced by ____\",\"meaning\":\"translation of the full correct sentence\",\"answer\":\"the word(s) for the gap\",\"alts\":[\"other correct answers, if any\"]},{\"kind\":\"mc\",\"sentence\":\"sentence with ____\",\"meaning\":\"translation\",\"answer\":\"correct word(s)\",\"options\":[\"correct\",\"wrong\",\"wrong\",\"wrong\"]}]}",
      "Rules: 3 to 5 patterns, 3 to 5 examples, 6 exercises (3 fill and 3 mc); each exercise has exactly one correct answer given the meaning; no two exercises share a sentence.",
    ].join("\n");
  }
  function parseGrammar(text, o) {
    const j = L.parseJson(text); if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    const rng = (o && o.rng) || Math.random;
    const rule = str(j.rule, 1500);
    const trip = (x) => { const t = str(x && x.target, 200), m = str(x && x.meaning, 240); return t && m ? { target: t, roman: str(x.roman, 200), meaning: m } : null; };
    const patterns = (Array.isArray(j.patterns) ? j.patterns : []).map(trip).filter(Boolean).slice(0, 6);
    const examples = (Array.isArray(j.examples) ? j.examples : []).map(trip).filter(Boolean).slice(0, 6);
    if (rule.length < 40 || patterns.length < 2 || examples.length < 2) return { ok: false, reason: "The lesson came back incomplete." };
    const seen = new Set(), exercises = [];
    for (const x of Array.isArray(j.exercises) ? j.exercises : []) {
      const sentence = str(x && x.sentence, 300), answer = str(x && x.answer, 120), meaning = str(x && x.meaning, 300);
      if (sentence.split("____").length !== 2 || !answer || !meaning || seen.has(L.normalize(sentence))) continue;
      const alts = (Array.isArray(x.alts) ? x.alts : []).map((a) => str(a, 120)).filter((a) => a && L.normalize(a) !== L.normalize(answer)).slice(0, 4);
      const full = sentence.replace("____", answer);
      if (x.kind === "mc") {
        const opts = [];
        for (const op of Array.isArray(x.options) ? x.options : []) { const t = str(op, 120); if (t && !opts.some((y) => L.normalize(y) === L.normalize(t))) opts.push(t); }
        if (opts.length < 3 || opts.findIndex((y) => L.normalize(y) === L.normalize(answer)) < 0) continue;
        const sh = L.shuffle(opts.slice(0, 5), rng); if (sh.findIndex((y) => L.normalize(y) === L.normalize(answer)) < 0) continue;
        seen.add(L.normalize(sentence)); exercises.push({ kind: "mc", sentence, meaning, full, q: "Fill the gap.", options: sh, answer: sh.findIndex((y) => L.normalize(y) === L.normalize(answer)), expected: answer, accepted: [answer] });
      } else {
        seen.add(L.normalize(sentence)); exercises.push({ kind: "fill", sentence, meaning, full, q: "Type the missing word.", answer: -1, expected: answer, accepted: [answer].concat(alts) });
      }
    }
    if (exercises.length < 4) return { ok: false, reason: "Too few usable exercises came back." };
    return { ok: true, title: str(j.title, 120) || str(o && o.topic && o.topic.title, 120) || "Grammar", rule, patterns, examples, mistakes: (Array.isArray(j.mistakes) ? j.mistakes : []).map((m) => str(m, 240)).filter(Boolean).slice(0, 3), exercises: exercises.slice(0, 8) };
  }
  function gradeExercise(ex, response) {
    if (ex.kind === "mc") { const ok = Number(response) === ex.answer; return { correct: ok, almost: false, note: "", expected: ex.expected }; }
    const g = L.gradeTyped(String(response || ""), ex.accepted);
    return { correct: g.result !== "wrong", almost: g.result === "almost", note: g.note || "", expected: ex.expected };
  }

  // ------------------------------------------------------------ conversation
  const SCENARIOS = [
    { id: "intro", label: "Meeting someone new", brief: "Two people meet at a social event and get to know each other: names, where they are from, what they do." },
    { id: "food", label: "Ordering food and drink", brief: "The partner is a waiter or café worker. The learner orders, asks about the menu and pays." },
    { id: "directions", label: "Directions and transport", brief: "The learner asks a passer-by how to get somewhere, and about tickets, times and prices." },
    { id: "shop", label: "Shopping", brief: "The partner is a shop assistant. The learner asks for things, sizes, prices and a discount." },
    { id: "work", label: "Talking about work", brief: "Two colleagues talk about their jobs, a normal working day and a small problem to solve." },
    { id: "free", label: "Free chat", brief: "A relaxed chat about daily life, hobbies and plans. The partner asks easy open questions." },
    { id: "custom", label: "My own situation", brief: "" },
  ];
  function buildChatPrompt(o) {
    const hist = (o.history || []).slice(-14).map((m) => (m.role === "user" ? "Learner: " : "Partner: ") + m.text).join("\n");
    const last = o.history && o.history.length && o.history[o.history.length - 1].role === "user" ? o.history[o.history.length - 1].text : "";
    return [
      "You are a friendly native " + o.course.name + " speaker role-playing with a learner whose own language is " + o.course.from + ". Situation: " + (o.scenario.brief || o.scenario.label) + ".",
      "The learner is at CEFR " + (CEFR_HELP[o.cefr] || o.cefr) + ". Speak at that level: common words, short sentences, 1 to 3 sentences, natural and warm. Stay in the role and keep the conversation going with a question or a next step.",
      "",
      hist ? "Conversation so far:\n" + hist : "Start the conversation with a short greeting and one easy question.",
      "",
      last ? "Now check the learner's LAST message: \"" + last + "\". If it contains a real mistake in grammar, word choice, word order or spelling, give the corrected sentence (change as little as possible) and a short reason in " + o.course.from + ". If it is correct and natural, set needed to false. Never invent a mistake and do not correct style preferences." : "There is no learner message yet, so no correction.",
      "",
      "Return ONLY JSON: {\"reply\":{\"target\":\"your reply in " + o.course.name + "\",\"roman\":\"romanisation or empty\",\"meaning\":\"translation into " + o.course.from + "\"},\"correction\":{\"needed\":false,\"corrected\":\"\",\"why\":\"\"},\"suggestions\":[{\"target\":\"a simple thing the learner could say next\",\"roman\":\"\",\"meaning\":\"translation\"},{\"target\":\"another\",\"roman\":\"\",\"meaning\":\"translation\"}]}",
    ].join("\n");
  }
  function parseChat(text, said) {
    const j = L.parseJson(text); if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    const r = j.reply && typeof j.reply === "object" ? j.reply : {};
    const target = str(r.target, 600); if (!target) return null;
    if (said && L.normalize(target) === L.normalize(said)) return null;
    let correction = null;
    const c = j.correction && typeof j.correction === "object" ? j.correction : {};
    const fixed = str(c.corrected, 600);
    if (said && c.needed === true && fixed && L.normalize(fixed) !== L.normalize(said)) {
      const sim = L.similarity(L.normalize(said), L.normalize(fixed));
      correction = { corrected: fixed, why: str(c.why, 300), kind: sim >= 0.4 ? "fix" : "rewrite" };
    }
    const suggestions = (Array.isArray(j.suggestions) ? j.suggestions : []).map((s) => { const t = str(s && s.target, 300); return t ? { target: t, roman: str(s.roman, 300), meaning: str(s.meaning, 300) } : null; }).filter(Boolean).slice(0, 2);
    return { reply: { target, roman: str(r.roman, 700), meaning: str(r.meaning, 700) }, correction, suggestions };
  }
  // Mistakes the learner made, kept for practice with spaced review.
  function addMistake(list, said, corrected, why, now) {
    const id = L.itemId(corrected); const t = now === undefined ? Date.now() : now;
    if (list.some((m) => m.id === id)) return list;
    list.push({ id, said: str(said, 300), corrected: str(corrected, 300), why: str(why, 300), box: 1, due: t });
    while (list.length > 100) list.shift();
    return list;
  }
  function dueMistakes(list, now) { const t = now === undefined ? Date.now() : now; return list.filter((m) => m.due <= t); }
  function recordMistake(m, correct, now) { const t = now === undefined ? Date.now() : now; m.box = correct ? clamp(m.box + 1, 1, 5) : 1; m.due = t + L.BOX_DAYS[m.box] * 86400000; return m; }
  function removeMistake(list, id) { const i = list.findIndex((m) => m.id === id); if (i >= 0) list.splice(i, 1); return list; }

  // ------------------------------------------------------------ level check
  function buildLevelPrompt(o) {
    const lo = prevCefr(o.cefr), hi = nextCefr(o.cefr);
    return [
      "You are an experienced " + o.course.name + " examiner writing a short placement check for a learner whose own language is " + o.course.from + ".",
      "Write 15 multiple-choice questions in three tiers: 5 \"below\" (CEFR " + lo + "), 5 \"at\" (" + o.cefr + "), 5 \"above\" (" + hi + "). Mix skills: \"vocabulary\", \"grammar\" and \"reading\" (for reading give a one or two sentence " + o.course.name + " text in context). Questions and options may be in " + o.course.name + " where that is the point of the item, otherwise in " + o.course.from + ". Each has 4 options and exactly one correct answer; no trick questions; do not test facts about the world.",
      "",
      "Return ONLY JSON: {\"questions\":[{\"tier\":\"below\",\"skill\":\"grammar\",\"context\":\"text for reading items, else empty\",\"q\":\"...\",\"options\":[\"a\",\"b\",\"c\",\"d\"],\"answer\":0}]}",
    ].join("\n");
  }
  function parseLevel(text, o) {
    const j = L.parseJson(text); if (!j || typeof j !== "object") return null;
    const rng = (o && o.rng) || Math.random, out = [];
    for (const x of Array.isArray(j.questions) ? j.questions : []) {
      const tier = ["below", "at", "above"].indexOf(x && x.tier) >= 0 ? x.tier : null; if (!tier) continue;
      const q = cleanQuestion(x, null, rng); if (!q) continue;
      out.push(Object.assign(q, { tier, skill: ["vocabulary", "grammar", "reading"].indexOf(x.skill) >= 0 ? x.skill : "grammar", context: str(x.context, 400) }));
    }
    return out.length >= 9 ? out.slice(0, 18) : null;
  }
  function estimateLevel(cefr, res) {
    const rate = (t) => (res[t] && res[t].total >= 2 ? res[t].correct / res[t].total : null);
    const b = rate("below"), a = rate("at"), h = rate("above");
    if (a === null) return { est: cefr, verdict: "unknown", note: "Too few questions survived the check to tell." };
    if (a >= 0.75 && (h === null || h >= 0.6)) return cefr === "C2" ? { est: "C2", verdict: "right", note: "You answered the top tier well." } : { est: nextCefr(cefr), verdict: "up", note: "You handled this level and most of the next." };
    if (a >= 0.6) return { est: cefr, verdict: "right", note: "This level fits you. The next one is not solid yet." };
    if (b !== null && b < 0.6 && cefr !== "A1") return { est: prevCefr(cefr), verdict: "down", note: "Even the easier tier was shaky. A step back would help." };
    return { est: cefr === "A1" ? "A1" : prevCefr(cefr), verdict: cefr === "A1" ? "right" : "down", note: cefr === "A1" ? "Keep building the basics." : "This level is not solid yet." };
  }

  const api = { CEFR_HELP, nextCefr, prevCefr, buildMoreUnitsPrompt, parseMoreUnits, buildReadPrompt, parseRead, glossSpans, glossItem, buildSolvePrompt, parseSolve, applySolve, buildGrammarTopicsPrompt, parseTopics, buildGrammarPrompt, parseGrammar, gradeExercise, SCENARIOS, buildChatPrompt, parseChat, addMistake, dueMistakes, recordMistake, removeMistake, buildLevelPrompt, parseLevel, estimateLevel };
  root.Fluency = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
