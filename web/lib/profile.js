// "About me": the applicant's direction (what they bring, who they help, where
// they are going, what help they would welcome) and their character, in their
// own words. Nothing here is a personality score. The applicant answers
// questions; the model may reflect those answers back, and every reflection
// must rest on a quote that really is in what was written. The applicant keeps
// or deletes each one. Pure logic: prompts, parsers and checks.
(function (root) {
  "use strict";

  const QUESTIONS = [
    { id: "d_bring", group: "direction", q: "What do you want people to remember you for? The expertise, experience or judgement you bring.", hint: "Two or three sentences. Be specific." },
    { id: "d_help", group: "direction", q: "Who do you help best? The kinds of teams, businesses or situations where you are particularly useful.", hint: "For example: teams stuck with a network nobody fully understands." },
    { id: "d_going", group: "direction", q: "Where are you heading in the next two or three years? Enough direction that someone could picture it.", hint: "A role, a kind of problem, a field." },
    { id: "d_welcome", group: "direction", q: "What help would you welcome right now? A role, an introduction, a conversation: something concrete enough to act on.", hint: "Not 'anything'. Name it." },
    { id: "c_pressure", group: "character", q: "Think of a bad day at work, in the middle of an incident or a deadline. What do you actually do, step by step, and what is your state of mind?", hint: "Describe it as it was, not as it should sound." },
    { id: "c_proud", group: "character", q: "What piece of work are you proudest of? What about it, apart from the result?", hint: "What it says about how you work." },
    { id: "c_mistake", group: "character", q: "Tell me about a mistake you made at work. What did you change afterwards?", hint: "A real one." },
    { id: "c_colleagues", group: "character", q: "What do colleagues come to you for? Only what you really know.", hint: "Questions, favours, help with what?" },
    { id: "c_values", group: "character", q: "What will you not compromise on in how work is done?", hint: "Standards, honesty, documentation, safety, anything." },
    { id: "c_drain", group: "character", q: "What kind of work or workplace drains you?", hint: "It helps the letter avoid fitting you to the wrong place." },
    { id: "c_learn", group: "character", q: "How do you learn something new and difficult? Give a recent example.", hint: "What you did first, what you did when stuck." },
    { id: "c_communicate", group: "character", q: "How do you like to communicate and disagree? How do you explain technical things to people who are not technical?", hint: "How you actually do it." },
    { id: "c_why", group: "character", q: "Why networks and AI? What pulled you in and what has kept you there?", hint: "In your own words, not the textbook version." },
    { id: "c_outside", group: "character", q: "What do you do outside work that shows how you think or what you care about?", hint: "Optional." },
  ];

  const MIN_WORDS = 5;
  const clip = (s, n) => String(s || "").slice(0, n);
  const str = (v, n) => clip(typeof v === "string" ? v.trim() : "", n || 2000);
  const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const words = (t) => (String(t || "").trim().match(/\S+/g) || []).length;
  const byId = {}; QUESTIONS.forEach((q) => { byId[q.id] = q; });


  // ------------------------------------------------------------ the scale
  // The 50-item IPIP Big-Five Factor Markers (Goldberg), a public-domain
  // questionnaire. It is scored by formula, never by the model. It is a
  // self-report guide, not a clinical or hiring-grade test, and no population
  // norms are applied: results are read as low, middle or high on the 1 to 5
  // scale itself.
  const DIMS = {
    E: { name: "Sociability", high: "gets energy from people and starts conversations readily", mid: "can work alone or with people and adapts to the setting", low: "prefers quiet, focused work and reserves energy for a few people" },
    A: { name: "Warmth towards others", high: "is considerate, tuned in to colleagues' feelings and puts people at ease", mid: "balances concern for people with getting the task done", low: "is direct and task-first, and less swayed by other people's feelings" },
    C: { name: "Organisation and follow-through", high: "plans, checks details, keeps order and finishes what is started", mid: "is organised where it matters and flexible elsewhere", low: "works flexibly and spontaneously and may need systems to keep detail tight" },
    N: { name: "Emotional reactivity", high: "feels stress and worry strongly, so steady routines and clear escalation help", mid: "feels pressure but generally recovers well", low: "stays calm and steady under pressure" },
    O: { name: "Curiosity and ideas", high: "is curious, enjoys abstract ideas and generates ideas readily", mid: "mixes practical focus with interest in new ideas", low: "prefers concrete, practical and proven approaches" },
  };
  // [number, statement, dimension, reversed]
  const ITEMS = [
    [1, "I am the life of the party.", "E", 0], [2, "I feel little concern for others.", "A", 1], [3, "I am always prepared.", "C", 0], [4, "I get stressed out easily.", "N", 0], [5, "I have a rich vocabulary.", "O", 0],
    [6, "I don't talk a lot.", "E", 1], [7, "I am interested in people.", "A", 0], [8, "I leave my belongings around.", "C", 1], [9, "I am relaxed most of the time.", "N", 1], [10, "I have difficulty understanding abstract ideas.", "O", 1],
    [11, "I feel comfortable around people.", "E", 0], [12, "I insult people.", "A", 1], [13, "I pay attention to details.", "C", 0], [14, "I worry about things.", "N", 0], [15, "I have a vivid imagination.", "O", 0],
    [16, "I keep in the background.", "E", 1], [17, "I sympathize with others' feelings.", "A", 0], [18, "I make a mess of things.", "C", 1], [19, "I seldom feel blue.", "N", 1], [20, "I am not interested in abstract ideas.", "O", 1],
    [21, "I start conversations.", "E", 0], [22, "I am not interested in other people's problems.", "A", 1], [23, "I get chores done right away.", "C", 0], [24, "I am easily disturbed.", "N", 0], [25, "I have excellent ideas.", "O", 0],
    [26, "I have little to say.", "E", 1], [27, "I have a soft heart.", "A", 0], [28, "I often forget to put things back in their proper place.", "C", 1], [29, "I get upset easily.", "N", 0], [30, "I do not have a good imagination.", "O", 1],
    [31, "I talk to a lot of different people at parties.", "E", 0], [32, "I am not really interested in others.", "A", 1], [33, "I like order.", "C", 0], [34, "I change my mood a lot.", "N", 0], [35, "I am quick to understand things.", "O", 0],
    [36, "I don't like to draw attention to myself.", "E", 1], [37, "I take time out for others.", "A", 0], [38, "I shirk my duties.", "C", 1], [39, "I have frequent mood swings.", "N", 0], [40, "I use difficult words.", "O", 0],
    [41, "I don't mind being the centre of attention.", "E", 0], [42, "I feel others' emotions.", "A", 0], [43, "I follow a schedule.", "C", 0], [44, "I get irritated easily.", "N", 0], [45, "I spend time reflecting on things.", "O", 0],
    [46, "I am quiet around strangers.", "E", 1], [47, "I make people feel at ease.", "A", 0], [48, "I am exacting in my work.", "C", 0], [49, "I often feel blue.", "N", 0], [50, "I am full of ideas.", "O", 0],
  ].map((x) => ({ n: x[0], text: x[1], dim: x[2], rev: !!x[3] }));
  const SCALE = ["Very inaccurate", "Moderately inaccurate", "Neither", "Moderately accurate", "Very accurate"];

  // Mean of the ten items of each dimension (1 to 5, reversed items flipped).
  // A dimension is scored only when all ten of its items are answered.
  function scoreScale(answers) {
    const a = answers && typeof answers === "object" ? answers : {}, out = {};
    for (const d of Object.keys(DIMS)) {
      const items = ITEMS.filter((i) => i.dim === d);
      const vals = items.map((i) => { const v = Number(a[i.n]); return v >= 1 && v <= 5 && Number.isInteger(v) ? (i.rev ? 6 - v : v) : null; });
      if (vals.some((v) => v === null)) { out[d] = null; continue; }
      const mean = Math.round((vals.reduce((x, y) => x + y, 0) / vals.length) * 100) / 100;
      out[d] = { mean, band: mean >= 3.6 ? "high" : mean <= 2.4 ? "low" : "mid" };
    }
    return out;
  }
  const scaleDone = (answers) => Object.values(scoreScale(answers)).every(Boolean);
  const scaleCount = (answers) => ITEMS.filter((i) => Number.isInteger(Number((answers || {})[i.n])) && Number((answers || {})[i.n]) >= 1 && Number((answers || {})[i.n]) <= 5).length;
  function scaleLines(answers) {
    const sc = scoreScale(answers), lines = [];
    for (const d of Object.keys(DIMS)) if (sc[d]) lines.push(`${DIMS[d].name}: ${sc[d].band} (${sc[d].mean} of 5). This person ${DIMS[d][sc[d].band]}.`);
    return lines;
  }

  function empty() { return { answers: {}, traits: [], test: {}, at: "" }; }

  function normalize(x) {
    const p = empty();
    if (!x || typeof x !== "object") return p;
    for (const [k, v] of Object.entries(x.answers && typeof x.answers === "object" ? x.answers : {})) if (byId[k]) { const s = str(v, 3000); if (s) p.answers[k] = s; }
    p.traits = (Array.isArray(x.traits) ? x.traits : []).map((t) => ({ text: str(t && t.text, 300), quote: str(t && t.quote, 500), keep: !t || t.keep !== false })).filter((t) => t.text && t.quote).slice(0, 10);
    for (const [k, v] of Object.entries(x.test && typeof x.test === "object" ? x.test : {})) { const n = Number(k), val = Number(v); if (Number.isInteger(n) && n >= 1 && n <= 50 && Number.isInteger(val) && val >= 1 && val <= 5) p.test[n] = val; }
    p.at = str(x.at, 40);
    return p;
  }

  const answered = (p, group) => QUESTIONS.filter((q) => (!group || q.group === group) && words(p.answers[q.id]) >= MIN_WORDS);

  function progress(p) {
    const dir = answered(p, "direction").length, ch = answered(p, "character").length;
    return { direction: dir, directionTotal: QUESTIONS.filter((q) => q.group === "direction").length, character: ch, characterTotal: QUESTIONS.filter((q) => q.group === "character").length };
  }

  // Everything the applicant wrote here, for number and copying checks.
  function corpus(p) { return Object.values(p.answers).join("\n") + "\n" + p.traits.filter((t) => t.keep).map((t) => t.text).join("\n"); }

  function block(p, group) {
    const lines = [];
    for (const q of answered(p, group)) lines.push(`Q: ${q.q}\nA: ${p.answers[q.id]}`);
    return lines.join("\n\n");
  }
  function traitsBlock(p) {
    const k = p.traits.filter((t) => t.keep);
    return k.length ? k.map((t) => "- " + t.text).join("\n") : "";
  }
  const hasAny = (p) => answered(p).length > 0;

  // How much the letter follows the applicant's direction. "classic" is the
  // original letter (experience and judgement), "balanced" keeps that letter and
  // adds a statement of direction at the start and a concrete ask at the end,
  // and "direction" builds the whole letter around where they are heading.
  const LETTER_STYLES = [
    { id: "classic", label: "Classic", hint: "Experience and judgement first, as before. Only your company notes are added." },
    { id: "balanced", label: "Balanced (default)", hint: "The classic letter, plus a line at the start on where you are heading and a concrete ask at the end. Your character shapes the voice." },
    { id: "direction", label: "Direction-led", hint: "The whole letter is built around what you are up for next, and your history is only there for credibility." },
  ];
  const styleOk = (m) => LETTER_STYLES.some((x) => x.id === m);

  // Appended to the cover-letter prompt.
  function coverBrief(p, companyNotes, mode) {
    const m = styleOk(mode) ? mode : "balanced";
    const dir = m === "classic" ? "" : block(p, "direction"), ch = m === "classic" ? "" : block(p, "character"), tr = m === "classic" ? "" : traitsBlock(p);
    const notes = str(companyNotes, 8000);
    const scale = m === "classic" ? [] : scaleLines(p.test);
    const parts = [];
    if (dir) parts.push("--- where the candidate is heading, in their own words ---\n" + dir);
    if (ch || tr) parts.push("--- how the candidate works and what they care about, in their own words ---\n" + ch + (tr ? "\n\nObservations the candidate has confirmed are true of them:\n" + tr : ""));
    if (scale.length) parts.push("--- a short self-report questionnaire the candidate took (scored by formula; a rough guide to how they see themselves, not a test result to quote) ---\n" + scale.join("\n") + "\nUse this only to choose emphasis and tone. Never mention the questionnaire, scores or labels in the letter, and never state a trait as a claim; show it through what the candidate did.");
    if (notes) parts.push("--- what the candidate knows about this company (their own notes) ---\n" + notes);
    if (!parts.length) return "";
    const ch2 = ch || tr || scale.length;
    const companyRule = "Anything about the company comes from the posting" + (notes ? " or the company notes" : "") + " and from nowhere else. Never claim to follow the company's news or products unless it is in those notes.";
    const factsRule = "FACTS. Numbers, dates, tools and employers come from the CV, the written account or the answers above and from nowhere else. " + companyRule;
    const voice = ch2 ? "VOICE. Use the character answers to decide tone, what to stress, and how this person reasons. Show it through how they work (what they did first, how they handled it); never state it as a claim such as \"I am a hard-working team player\". Take ideas, not wording: no six consecutive words from those answers." : "";
    if (m === "classic") return ["", parts.join("\n\n"), "", "Keep the letter exactly as described above. The company notes only give you something specific to say about why this employer.", companyRule].join("\n");
    if (m === "balanced") {
      return ["", parts.join("\n\n"), "",
        "SHAPE OF THE LETTER (a blend of two styles). Keep the classic letter described above: four or five short paragraphs led by the candidate's real experience and judgement, with evidence from the CV or account and a specific reason this employer draws them. The middle paragraphs stay evidence-led: what they have done, how they work, why this team. At least half the words must describe real work. Add only these two things:",
        dir ? "1. Near the start, one or two sentences on where the candidate is heading and why this role fits it, taken from their direction answers. No \"I am writing to apply\"." : "1. Near the start, one or two sentences on what draws the candidate to this particular role.",
        dir ? "2. End on the concrete thing the candidate would welcome, from their answer about help they would welcome, for example a conversation about a named problem. No pleading." : "2. End on a plain, specific invitation to talk.",
        voice, factsRule].filter((x) => x !== "").join("\n");
    }
    return [
      "", parts.join("\n\n"), "",
      "SHAPE OF THE LETTER (this replaces any earlier instruction about structure). Do not recite the CV. A reader should finish knowing what the candidate is up for next, and not only where they have been. Use this order:",
      dir ? "1. Opening, two or three sentences: where the candidate is heading and why this role is a step along it, taken from their direction answers. No \"I am writing to apply\"." : "1. Opening, two or three sentences: what draws the candidate to this role, specific to the posting. No \"I am writing to apply\".",
      "2. What they bring: one or two pieces of real evidence from the CV or the account that this role needs, each with its result. History is there to give credibility, in a clause, and not as a list.",
      "3. Who they help: connect the kind of problem the candidate likes to take on with the problems the posting" + (notes ? " and the company notes" : "") + " describe. Be specific to this employer.",
      "4. Why this company: only from the posting" + (notes ? " and the company notes" : "") + ". If there is nothing specific, say less. Never flatter, and never claim to follow the company's news or products unless it is in those notes.",
      dir ? "5. Close: the concrete thing the candidate would welcome, from their answer about help they would welcome, for example a conversation about a named problem." : "5. Close: a plain, specific invitation to talk, no pleading.",
      voice, factsRule,
    ].filter((x) => x !== "").join("\n");
  }

  // Everything the applicant has written about themselves: their answers here,
  // their own account of their background, and their CV.
  function writtenBy(p, cv, story) { return [block(p), story ? "--- their own written account ---\n" + clip(story, 30000) : "", cv ? "--- their CV ---\n" + clip(cv, 10000) : ""].filter(Boolean).join("\n\n"); }
  function buildMirrorPrompt(p, cv, story) {
    const sc = scaleLines(p.test);
    return [
      "Below is everything a job applicant has written about themselves. Reflect back how they come across: how they work, decide and communicate, and what they care about. This is a mirror of their words, not a personality test.",
      "", writtenBy(p, cv, story), "",
      sc.length ? "A short self-report questionnaire they took (scored by formula) gave:\n" + sc.join("\n") + "\nYou may use it as a hint of where to look, but every observation must still rest on a quote from the text above.\n" : "",
      "Return ONLY JSON: {\"traits\":[{\"text\":\"one short observation, in plain words, third person\",\"quote\":\"words copied EXACTLY from the text above, 8 to 40 words, that the observation rests on\"}]}",
      "Rules: 6 to 8 observations about how this person works, decides, communicates and what they care about; each rests on a quote that is really in the text above; no type labels or scores in the observation (no MBTI, no Big Five, no diagnosis); no praise or flattery; nothing the text does not show; include one thing that could be a weakness or a limit if the text shows one.",
    ].filter((x) => x !== "").join("\n");
  }
  function parseJson(text) {
    let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const a = t.indexOf("{"), b = t.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
  }
  function parseMirror(text, p, cv, story) {
    const j = parseJson(text), hay = norm(Object.values(p.answers).join(" ") + " " + (story || "") + " " + (cv || ""));
    const out = [], list = j && Array.isArray(j.traits) ? j.traits : [];
    for (const t of list) {
      const tx = str(t && t.text, 300), q = str(t && t.quote, 500);
      if (!tx || !q) continue;
      const nq = norm(q);
      if (nq.split(" ").length < 6 || !hay.includes(nq)) continue;
      if (/\b(mbti|myers|big five|introvert|extrovert|enneagram|narcissis|psychopath|disorder)\b/i.test(tx)) continue;
      out.push({ text: tx, quote: q, keep: true });
    }
    return out.slice(0, 8);
  }

  const api = { LETTER_STYLES, ITEMS, DIMS, SCALE, scoreScale, scaleDone, scaleCount, scaleLines, writtenBy, QUESTIONS, MIN_WORDS, empty, normalize, answered, progress, corpus, block, traitsBlock, hasAny, coverBrief, buildMirrorPrompt, parseMirror };
  root.Profile = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
