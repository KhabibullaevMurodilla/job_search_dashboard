// Language training: a course for any language, written by the model for the
// learner's own starting language and goal, then drilled with exercises that
// are built and graded by plain code, so the marking never depends on the
// model's mood. Words come back in short units; a second pass reviews each
// unit; the learner can report any item that is wrong and it is removed for
// good. Progress is spaced-repetition boxes plus XP, levels, streaks, a daily
// goal and badges. Pure logic: prompts, parsers, builders, grading, scoring.
(function (root) {
  "use strict";

  const LEVELS = ["absolute beginner", "some basics", "intermediate"];
  const GOALS = [
    { id: "everyday", label: "Everyday life" },
    { id: "travel", label: "Travel" },
    { id: "work", label: "Work and IT" },
    { id: "academic", label: "Study and research" },
    { id: "family", label: "Family and friends" },
  ];
  const BOX_DAYS = [0, 0, 1, 3, 7, 16];          // days until the next review, by box 1..5
  const DAY = 86400000;
  const MAX_COURSES = 5, DAILY_GOALS = [20, 50, 100], MAX_UNITS = 60;
  const CEFR = ["A1", "A2", "B1", "B2", "C1", "C2"];
  const startCefr = (level) => (level === "intermediate" ? "B1" : level === "some basics" ? "A2" : "A1");

  const str = (v, n) => String(typeof v === "string" ? v : "").trim().slice(0, n || 300);
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  // ------------------------------------------------------------ text helpers
  function normalize(s) {
    return String(s || "").normalize("NFC").toLowerCase().replace(/[.,;:!?¿¡"“”«»„‚'’`´()\[\]{}…。、，！？؟،؛]/g, " ").replace(/\s+/g, " ").trim();
  }
  // Same, with accents and marks removed, so "cafe" and "café" meet.
  function looseKey(s) { return normalize(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").replace(/ß/g, "ss").replace(/ø/g, "o").replace(/đ/g, "d").replace(/ł/g, "l"); }
  function distance(a, b) {
    const x = Array.from(a), y = Array.from(b);
    if (!x.length) return y.length; if (!y.length) return x.length;
    let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
    for (let i = 1; i <= x.length; i++) {
      const cur = [i];
      for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[y.length];
  }
  function similarity(a, b) { const m = Math.max(Array.from(a).length, Array.from(b).length); return m ? 1 - distance(a, b) / m : 1; }
  function itemId(target) { let h = 5381; const s = normalize(target); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return "w" + h.toString(36); }
  const hasSpaces = (items) => { const ex = items.map((i) => i.example && i.example.target).filter(Boolean); return ex.length > 0 && ex.filter((e) => /\S\s+\S/.test(e)).length / ex.length >= 0.5; };

  // Typed answers: correct, "almost" (accents or one typo, counted as right but
  // shown with the exact form) or wrong.
  function gradeTyped(answer, accepted) {
    const a = normalize(answer); if (!a) return { result: "wrong" };
    const list = (accepted || []).filter(Boolean);
    if (list.some((x) => normalize(x) === a)) return { result: "correct" };
    const la = looseKey(answer);
    if (list.some((x) => looseKey(x) === la)) return { result: "almost", note: "Check the accents and marks." };
    if (la.length >= 6 && list.some((x) => { const k = looseKey(x); return k.length >= 6 && distance(la, k) === 1; })) return { result: "almost", note: "One letter is off." };
    return { result: "wrong" };
  }

  // ------------------------------------------------------------ prompts
  function parseJson(text) {
    const t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const a = t.search(/[\[{]/); if (a < 0) return null;
    const open = t[a], close = open === "{" ? "}" : "]", b = t.lastIndexOf(close);
    if (b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
  }

  function buildCoursePrompt(o) {
    return [
      "You are an experienced language teacher. Plan a course that teaches " + o.learn + " to a learner whose own language is " + o.from + ".",
      "Level: " + (LEVELS.indexOf(o.level) >= 0 ? o.level : LEVELS[0]) + ". Purpose: " + (o.goalText || "everyday life") + ".",
      o.extra ? "The learner also says: " + str(o.extra, 400) : "",
      "",
      "Return ONLY JSON: {\"language\":{\"name\":\"the language's name in English\",\"nativeName\":\"its name in itself\",\"tag\":\"BCP-47 tag a browser speech voice would use, e.g. de-DE, ja-JP, ar-SA, uz-UZ\",\"script\":\"Latin|Cyrillic|Arabic|Hebrew|Han|Kana|Hangul|Devanagari|Thai|Other\",\"confidence\":\"high|medium|low\",\"warning\":\"one sentence if your knowledge of this language or this variety is thin, else empty\"},\"units\":[{\"title\":\"2-4 words\",\"focus\":\"what the learner will be able to say after it\"}]}",
      "Rules: 8 units, in the order to learn them, each small enough for about ten words and phrases; start with what is most useful for the stated purpose; use the standard variety unless the learner asked for another; set confidence honestly: low if you are not sure of the vocabulary, spelling or grammar of this language, and say so in the warning.",
    ].filter(Boolean).join("\n");
  }
  function parseCourse(text) {
    const j = parseJson(text); if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    const l = j.language && typeof j.language === "object" ? j.language : {};
    const units = (Array.isArray(j.units) ? j.units : []).map((u) => ({ title: str(u && u.title, 80), focus: str(u && u.focus, 240) })).filter((u) => u.title).slice(0, 10);
    if (!str(l.name, 60) || units.length < 4) return null;
    return {
      name: str(l.name, 60), nativeName: str(l.nativeName, 60), tag: /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(str(l.tag, 20)) ? str(l.tag, 20) : "",
      script: str(l.script, 20), confidence: ["high", "medium", "low"].indexOf(l.confidence) >= 0 ? l.confidence : "medium", warning: str(l.warning, 300), units,
    };
  }

  function buildUnitPrompt(o) {
    const known = (o.known || []).slice(0, 80).join(", ");
    return [
      "You are an experienced " + o.course.name + " teacher writing one unit for a learner whose own language is " + o.course.from + ". Level: " + o.course.level + ". Purpose: " + (o.course.goalText || "everyday life") + ".",
      "UNIT: " + o.unit.title + (o.unit.focus ? " (" + o.unit.focus + ")" : ""),
      known ? "Words the learner already has (do not repeat them): " + known : "",
      "",
      "Return ONLY JSON: {\"note\":\"one or two sentences of usage or grammar worth knowing for this unit, in " + o.course.from + "\",\"items\":[{\"target\":\"the word or short phrase in " + o.course.name + ", in its normal writing\",\"roman\":\"a romanisation or pronunciation guide if the script is not Latin, else empty\",\"meaning\":\"its meaning in " + o.course.from + "\",\"alts\":[\"other correct ways to write or say it\"],\"example\":{\"target\":\"a short natural sentence using it\",\"roman\":\"romanisation of the sentence if the script is not Latin, else empty\",\"meaning\":\"the sentence in " + o.course.from + "\"},\"unsure\":false}]}",
      "Rules: 9 to 11 items; natural, current, everyday forms, not textbook oddities; each meaning is the real meaning, not a literal gloss; examples are correct " + o.course.name + " a native speaker would say; set unsure to true for any item you are not certain of; never invent a word. Keep targets short (at most 6 words).",
    ].filter(Boolean).join("\n");
  }
  function parseUnit(text, opts) {
    const j = parseJson(text); if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    const removed = new Set((opts && opts.removed) || []), have = new Set((opts && opts.have) || []);
    const items = [], seen = new Set();
    for (const x of Array.isArray(j.items) ? j.items : []) {
      const target = str(x && x.target, 120), meaning = str(x && x.meaning, 160), ex = x && x.example && typeof x.example === "object" ? x.example : {};
      if (!target || !meaning || (x && x.unsure === true)) continue;
      const id = itemId(target);
      if (seen.has(id) || removed.has(id) || have.has(id)) continue;
      seen.add(id);
      const exT = str(ex.target, 240), exM = str(ex.meaning, 240);
      items.push({ id, target, roman: str(x.roman, 160), meaning, alts: (Array.isArray(x.alts) ? x.alts : []).map((a) => str(a, 120)).filter((a) => a && normalize(a) !== normalize(target)).slice(0, 4), example: exT && exM ? { target: exT, roman: str(ex.roman, 240), meaning: exM } : null });
    }
    if (items.length < 5) return { ok: false, items, reason: "Only " + items.length + " usable words came back." };
    return { ok: true, note: str(j.note, 400), items: items.slice(0, 12) };
  }

  function buildCheckPrompt(course, items) {
    return [
      "You are a strict " + course.name + " reviewer who also reads " + course.from + ". Check each numbered item below for a learner. An item is bad if the " + course.name + " is misspelled or unnatural, the meaning is wrong or misleading, the romanisation is wrong, or the example sentence is wrong or does not use the word.",
      "", items.map((i, n) => `${n}. ${i.target}${i.roman ? " [" + i.roman + "]" : ""} = ${i.meaning}` + (i.example ? ` | example: ${i.example.target}${i.example.roman ? " [" + i.example.roman + "]" : ""} = ${i.example.meaning}` : "")).join("\n"),
      "", "Return ONLY JSON: {\"bad\":[{\"index\":0,\"problem\":\"what is wrong, briefly\"}]}. Return an empty list if you find no real error. Do not flag style preferences.",
    ].join("\n");
  }
  function parseCheck(text, n) {
    const j = parseJson(text); if (!j || typeof j !== "object") return null;
    const bad = {};
    for (const b of Array.isArray(j.bad) ? j.bad : []) { const i = Number(b && b.index); if (Number.isInteger(i) && i >= 0 && i < n) bad[i] = str(b.problem, 200) || "flagged"; }
    return bad;
  }

  // ------------------------------------------------------------ exercises
  function mulberry32(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function shuffle(a, rng) { const r = rng || Math.random, x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; }

  function distractors(item, pool, key, k, rng) {
    const seen = new Set([normalize(item[key])]), out = [];
    for (const o of shuffle(pool, rng)) { if (o.id === item.id) continue; const v = normalize(o[key]); if (!v || seen.has(v)) continue; seen.add(v); out.push(o[key]); if (out.length >= k) break; }
    return out;
  }
  const wordsOf = (s) => String(s || "").trim().split(/\s+/).filter(Boolean);

  // items: the unit's (or the due) words. pool: every word the learner has, for distractors.
  function buildSession(items, o) {
    const opt = o || {}, rng = opt.rng || Math.random, n = opt.n || 12, pool = (opt.pool && opt.pool.length ? opt.pool : items);
    const types = ["mc-meaning", "mc-target", "type", "mc-meaning", "order", "type", "mc-target"];
    if (opt.canListen) types.splice(2, 0, "listen", "listen");
    if (opt.canSpeak) types.splice(5, 0, "speak");
    const out = []; let order = shuffle(items, rng), k = 0, t = 0;
    while (out.length < n && items.length) {
      if (k >= order.length) { order = shuffle(items, rng); k = 0; }
      const it = order[k++];
      let q = null;
      for (let tries = 0; tries < types.length && !q; tries++) {
        const type = types[t++ % types.length];
        let subject = it;
        if (type === "order" && !(it.example && wordsOf(it.example.target).length >= 3)) subject = items.find((x) => x.example && wordsOf(x.example.target).length >= 3 && !out.some((o) => o.type === "order" && o.itemId === x.id)) || it;
        q = makeQuestion(type, subject, pool, opt, rng);
      }
      if (q) { q.id = out.length; out.push(q); }
      else if (t > 200) break;
    }
    return out;
  }
  function makeQuestion(type, it, pool, opt, rng) {
    if (type === "mc-meaning" || type === "listen") {
      const d = distractors(it, pool, "meaning", 3, rng); if (d.length < 1) return null;
      const options = shuffle([it.meaning].concat(d), rng);
      return { type, itemId: it.id, prompt: type === "listen" ? "Listen and choose the meaning." : "What does this mean?", show: type === "listen" ? "" : it.target, roman: type === "listen" ? "" : it.roman, audio: it.target, options, answer: options.indexOf(it.meaning) };
    }
    if (type === "mc-target") {
      const d = distractors(it, pool, "target", 3, rng); if (d.length < 1) return null;
      const options = shuffle([it.target].concat(d), rng);
      return { type, itemId: it.id, prompt: "Choose the " + (opt.name || "") + " for:", show: it.meaning, audio: "", options, answer: options.indexOf(it.target) };
    }
    if (type === "type") {
      const accepted = [it.target].concat(it.alts || []); if (it.roman) accepted.push(it.roman);
      return { type, itemId: it.id, prompt: "Type it in " + (opt.name || "the language") + (it.roman ? " (the romanisation is accepted)" : "") + ":", show: it.meaning, accepted, expected: it.target };
    }
    if (type === "order") {
      if (!opt.hasSpaces || !it.example) return null;
      const w = wordsOf(it.example.target); if (w.length < 3 || w.length > 9) return null;
      let bank = shuffle(w, rng); if (bank.join(" ") === w.join(" ")) bank = w.slice().reverse();
      return { type, itemId: it.id, prompt: "Put the words in order:", show: it.example.meaning, bank, expected: w.join(" "), words: w };
    }
    if (type === "speak") return { type, itemId: it.id, prompt: "Say it aloud:", show: it.target, roman: it.roman, meaning: it.meaning, expected: it.target };
    return null;
  }

  // response: option index (choice), typed string, array of words (order), transcript (speak)
  function gradeQuestion(q, response) {
    if (q.type === "mc-meaning" || q.type === "mc-target" || q.type === "listen") return { correct: Number(response) === q.answer, expected: q.options[q.answer] };
    if (q.type === "type") { const g = gradeTyped(response, q.accepted); return { correct: g.result !== "wrong", almost: g.result === "almost", note: g.note || "", expected: q.expected }; }
    if (q.type === "order") { const ok = normalize((response || []).join(" ")) === normalize(q.expected); return { correct: ok, expected: q.expected }; }
    if (q.type === "speak") { const s = similarity(looseKey(response), looseKey(q.expected)); return { correct: s >= 0.8, almost: s >= 0.8 && s < 1, expected: q.expected }; }
    return { correct: false, expected: "" };
  }

  // ------------------------------------------------------------ spaced repetition
  function srsRecord(srs, id, correct, now) {
    const t = now === undefined ? Date.now() : now, r = Object.assign({ box: 0, due: 0, seen: 0, right: 0 }, srs[id] || {});
    r.seen += 1; if (correct) r.right += 1;
    r.box = correct ? clamp(r.box + 1, 1, 5) : 1;
    r.due = t + BOX_DAYS[r.box] * DAY;
    srs[id] = r; return r;
  }
  function dueIds(srs, now) { const t = now === undefined ? Date.now() : now; return Object.entries(srs || {}).filter(([, r]) => r.box > 0 && r.due <= t).sort((a, b) => a[1].due - b[1].due).map(([id]) => id); }
  const learnedCount = (srs) => Object.values(srs || {}).filter((r) => r.box >= 3).length;

  // ------------------------------------------------------------ XP, levels, streaks, badges
  function xpForAnswer(comboBefore, almost) { return (almost ? 7 : 10) + clamp((comboBefore - 1) * 2, 0, 6); }
  function finishLesson(o) {
    const acc = o.total ? o.correct / o.total : 0;
    const stars = o.failed ? 0 : acc >= 0.9 ? 3 : acc >= 0.7 ? 2 : acc >= 0.5 ? 1 : 0;
    return { accuracy: Math.round(acc * 100), stars, bonus: stars * 5 + (stars === 3 && o.wrong === 0 ? 10 : 0) };
  }
  const levelOf = (xp) => Math.floor(Math.sqrt(Math.max(0, xp) / 50)) + 1;
  const levelStart = (lv) => (lv - 1) * (lv - 1) * 50;
  const pad = (n) => String(n).padStart(2, "0");
  function dayKey(now) { const d = new Date(now === undefined ? Date.now() : now); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function prevDay(now) { const d = new Date(now === undefined ? Date.now() : now); d.setDate(d.getDate() - 1); return dayKey(d.getTime()); }

  function addXp(stats, xp, now) {
    const today = dayKey(now);
    stats.xp += xp;
    if (!stats.day || stats.day.date !== today) stats.day = { date: today, xp: 0 };
    stats.day.xp += xp;
    if (stats.streak.last !== today) { stats.streak.days = stats.streak.last === prevDay(now) ? stats.streak.days + 1 : 1; stats.streak.last = today; stats.streak.best = Math.max(stats.streak.best, stats.streak.days); }
    return stats;
  }
  // The streak shown today: it lapses if nothing was done yesterday or today.
  function streakNow(stats, now) { const t = dayKey(now), l = stats.streak.last; return l === t || l === prevDay(now) ? stats.streak.days : 0; }

  const BADGES = [
    { id: "first", label: "First lesson", test: (c) => c.lessons >= 1 },
    { id: "perfect", label: "A perfect lesson", test: (c) => c.perfect >= 1 },
    { id: "streak3", label: "Three days in a row", test: (c) => c.best >= 3 },
    { id: "streak7", label: "A week in a row", test: (c) => c.best >= 7 },
    { id: "streak30", label: "Thirty days in a row", test: (c) => c.best >= 30 },
    { id: "words25", label: "25 words learned", test: (c) => c.learned >= 25 },
    { id: "words100", label: "100 words learned", test: (c) => c.learned >= 100 },
    { id: "xp500", label: "500 XP", test: (c) => c.xp >= 500 },
    { id: "xp2000", label: "2,000 XP", test: (c) => c.xp >= 2000 },
    { id: "review50", label: "50 correct reviews", test: (c) => c.reviews >= 50 },
    { id: "two", label: "Two languages at once", test: (c) => c.courses >= 2 },
    { id: "read1", label: "First reading passage", test: (c) => (c.reads || 0) >= 1 },
    { id: "talk1", label: "First conversation", test: (c) => (c.convos || 0) >= 1 },
    { id: "talk10", label: "Ten conversations", test: (c) => (c.convos || 0) >= 10 },
    { id: "gram5", label: "Five grammar lessons", test: (c) => (c.grammar || 0) >= 5 },
    { id: "check1", label: "First level check", test: (c) => (c.checks || 0) >= 1 },
    { id: "up", label: "Moved up a level", test: (c) => (c.ups || 0) >= 1 },
  ];
  function newBadges(stats, c) { return BADGES.filter((b) => stats.badges.indexOf(b.id) < 0 && b.test(c)); }

  // ------------------------------------------------------------ saved state
  function newState() { return { stats: { xp: 0, goal: 50, day: { date: "", xp: 0 }, streak: { days: 0, last: "", best: 0 }, badges: [], lessons: 0, perfect: 0, reviews: 0, reads: 0, convos: 0, grammar: 0, checks: 0, ups: 0 }, courses: [], active: "" }; }
  function normalizeState(x) {
    const s = newState(); if (!x || typeof x !== "object") return s;
    const st = x.stats && typeof x.stats === "object" ? x.stats : {};
    const num = (v) => Math.max(0, Math.floor(Number(v) || 0));
    s.stats.xp = num(st.xp); s.stats.goal = DAILY_GOALS.indexOf(Number(st.goal)) >= 0 ? Number(st.goal) : 50;
    s.stats.day = { date: /^\d{4}-\d{2}-\d{2}$/.test(str(st.day && st.day.date, 12)) ? st.day.date : "", xp: num(st.day && st.day.xp) };
    s.stats.streak = { days: num(st.streak && st.streak.days), last: /^\d{4}-\d{2}-\d{2}$/.test(str(st.streak && st.streak.last, 12)) ? st.streak.last : "", best: num(st.streak && st.streak.best) };
    s.stats.badges = (Array.isArray(st.badges) ? st.badges : []).filter((b) => BADGES.some((x) => x.id === b));
    s.stats.lessons = num(st.lessons); s.stats.perfect = num(st.perfect); s.stats.reviews = num(st.reviews);
    for (const k of ["reads", "convos", "grammar", "checks", "ups"]) s.stats[k] = num(st[k]);
    s.courses = (Array.isArray(x.courses) ? x.courses : []).map((c) => {
      if (!c || typeof c !== "object" || !str(c.id, 40) || !str(c.name, 60)) return null;
      const units = (Array.isArray(c.units) ? c.units : []).map((u) => ({
        title: str(u && u.title, 80), focus: str(u && u.focus, 240), note: str(u && u.note, 400), stars: clamp(num(u && u.stars), 0, 3),
        items: Array.isArray(u && u.items) ? u.items.map((i) => ({ id: str(i && i.id, 20), target: str(i && i.target, 120), roman: str(i && i.roman, 160), meaning: str(i && i.meaning, 160), alts: (Array.isArray(i && i.alts) ? i.alts : []).map((a) => str(a, 120)).filter(Boolean).slice(0, 4), example: i && i.example && str(i.example.target, 240) && str(i.example.meaning, 240) ? { target: str(i.example.target, 240), roman: str(i.example.roman, 240), meaning: str(i.example.meaning, 240) } : null })).filter((i) => i.id && i.target && i.meaning) : null,
        dropped: num(u && u.dropped),
      })).filter((u) => u.title).slice(0, MAX_UNITS);
      const srs = {};
      for (const [k, r] of Object.entries(c.srs && typeof c.srs === "object" ? c.srs : {})) if (r && typeof r === "object") srs[str(k, 20)] = { box: clamp(num(r.box), 0, 5), due: num(r.due), seen: num(r.seen), right: num(r.right) };
      return { id: str(c.id, 40), name: str(c.name, 60), nativeName: str(c.nativeName, 60), tag: str(c.tag, 20), script: str(c.script, 20), confidence: ["high", "medium", "low"].indexOf(c.confidence) >= 0 ? c.confidence : "medium", warning: str(c.warning, 300), from: str(c.from, 60) || "English", level: LEVELS.indexOf(c.level) >= 0 ? c.level : LEVELS[0], goalText: str(c.goalText, 200), cefr: CEFR.indexOf(c.cefr) >= 0 ? c.cefr : startCefr(LEVELS.indexOf(c.level) >= 0 ? c.level : LEVELS[0]), fx: normalizeFx(c.fx), units, srs, removed: (Array.isArray(c.removed) ? c.removed : []).map((r) => str(r, 20)).filter(Boolean).slice(0, 300), reviews: num(c.reviews), at: str(c.at, 40) };
    }).filter(Boolean).slice(0, MAX_COURSES);
    s.active = s.courses.some((c) => c.id === x.active) ? x.active : (s.courses[0] ? s.courses[0].id : "");
    return s;
  }

  function normalizeFx(f) {
    f = f && typeof f === "object" ? f : {};
    const num = (v) => Math.max(0, Math.floor(Number(v) || 0)), day = (v) => (/^\d{4}-\d{2}-\d{2}/.test(str(v, 40)) ? str(v, 40) : "");
    const list = (v, n, fn) => (Array.isArray(v) ? v : []).map(fn).filter(Boolean).slice(-n);
    const topics = {};
    for (const k of CEFR) topics[k] = list(f.topics && f.topics[k], 20, (t) => (t && str(t.title, 80) ? { title: str(t.title, 80), focus: str(t.focus, 200), done: t.done === true } : null));
    return {
      reads: list(f.reads, 60, (r) => (r && str(r.title, 120) ? { title: str(r.title, 120), cefr: CEFR.indexOf(r.cefr) >= 0 ? r.cefr : "", correct: num(r.correct), total: num(r.total), at: day(r.at) } : null)),
      grammar: list(f.grammar, 60, (r) => (r && str(r.title, 120) ? { title: str(r.title, 120), cefr: CEFR.indexOf(r.cefr) >= 0 ? r.cefr : "", correct: num(r.correct), total: num(r.total), at: day(r.at) } : null)),
      convos: list(f.convos, 60, (r) => (r && str(r.scenario, 120) ? { scenario: str(r.scenario, 120), turns: num(r.turns), clean: num(r.clean), at: day(r.at) } : null)),
      checks: list(f.checks, 30, (r) => (r && CEFR.indexOf(r.est) >= 0 ? { cefr: CEFR.indexOf(r.cefr) >= 0 ? r.cefr : "", est: r.est, correct: num(r.correct), total: num(r.total), at: day(r.at) } : null)),
      topics,
      mistakes: list(f.mistakes, 100, (m) => (m && str(m.said, 300) && str(m.corrected, 300) ? { id: str(m.id, 20) || itemId(str(m.corrected, 300)), said: str(m.said, 300), corrected: str(m.corrected, 300), why: str(m.why, 300), box: clamp(num(m.box), 0, 5), due: num(m.due) } : null)),
    };
  }
  const courseItems = (c) => [].concat(...c.units.map((u) => u.items || []));

  const api = { CEFR, MAX_UNITS, startCefr, normalizeFx, LEVELS, GOALS, DAILY_GOALS, MAX_COURSES, BADGES, BOX_DAYS, normalize, looseKey, distance, similarity, itemId, hasSpaces, gradeTyped, parseJson, buildCoursePrompt, parseCourse, buildUnitPrompt, parseUnit, buildCheckPrompt, parseCheck, mulberry32, shuffle, buildSession, gradeQuestion, srsRecord, dueIds, learnedCount, xpForAnswer, finishLesson, levelOf, levelStart, dayKey, addXp, streakNow, newBadges, newState, normalizeState, courseItems };
  root.Lang = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
