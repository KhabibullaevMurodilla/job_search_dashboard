// Training ground: practice for the interviews and tests that follow an
// application. Everything here is pure logic: prompts, parsers that refuse
// malformed model output, scoring and progress. The page supplies the model
// call and the screen.
(function (root) {
  "use strict";

  const MODES = {
    interview: { label: "Mock interview", count: 5, followups: 2 },
    challenge: { label: "Practical challenge", count: 2, followups: 1 },
    quiz: { label: "Technical quiz", count: 8, followups: 0 },
    defence: { label: "Proposal defence", count: 5, followups: 2 },
  };
  const LEVELS = ["standard", "tough"];

  const clip = (s, n) => String(s || "").slice(0, n);
  const str = (v, n) => clip(typeof v === "string" ? v.trim() : "", n || 2000);
  const arr = (v, n, m) => (Array.isArray(v) ? v : []).map((x) => str(x, m || 400)).filter(Boolean).slice(0, n || 6);
  const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

  // The model is asked for JSON; it sometimes wraps it in a fence or a sentence.
  function parseJson(text) {
    let t = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    const a = t.search(/[\[{]/);
    if (a < 0) return null;
    const open = t[a], close = open === "{" ? "}" : "]";
    const b = t.lastIndexOf(close);
    if (b <= a) return null;
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
  }

  // ------------------------------------------------------------ targets
  const targetKey = (kind, id) => `${kind}:${id}`;

  function contextFor(kind, rec) {
    if (kind === "phd") {
      return {
        kind: "phd", title: rec.programme || "PhD programme", org: rec.university || "",
        text: rec.advert || "", requirements: Array.isArray(rec.requirements) ? rec.requirements.map((r) => (typeof r === "string" ? r : r && r.text) || "").filter(Boolean) : [],
        proposal: rec.proposalFull || rec.proposal || "", theme: rec.theme || "",
        sources: (rec.sources || []).filter((s) => s.use !== false).map((s) => s.title).filter(Boolean).slice(0, 12),
      };
    }
    return { kind: "job", title: rec.title || "", org: rec.company || "", text: rec.description || "", requirements: [], proposal: "", theme: "", sources: [] };
  }

  function ctxBlock(ctx) {
    const lines = [
      `--- the ${ctx.kind === "phd" ? "programme" : "role"} ---`,
      `${ctx.title}${ctx.org ? " at " + ctx.org : ""}`,
      ctx.theme ? "Theme: " + ctx.theme : "",
      ctx.requirements.length ? "Requirements listed: " + ctx.requirements.join("; ") : "",
      "",
      clip(ctx.text || "(no description given)", 9000),
    ];
    if (ctx.proposal) lines.push("", "--- the applicant's research proposal ---", clip(ctx.proposal, 12000));
    if (ctx.sources.length) lines.push("", "Papers the proposal cites: " + ctx.sources.join("; "));
    return lines.filter((x) => x !== "").join("\n");
  }

  function whoBlock(cv, story) {
    return ["--- the candidate's CV ---", clip(cv, 12000), story ? "\n--- the candidate's own written account of their background ---\n" + clip(story, 30000) : ""].join("\n");
  }

  const INTERVIEWER = "You are an experienced, fair and demanding interviewer. You do not flatter. You ask what a real panel for this position would ask, in plain words, one question at a time.";

  // ------------------------------------------------------------ readiness map
  function buildReadinessPrompt(o) {
    return [
      "List what this position really requires, and for each requirement say how well the candidate's own record shows it.",
      "",
      ctxBlock(o.ctx), "", whoBlock(o.cv, o.story), "",
      "Return ONLY JSON: {\"requirements\":[{\"requirement\":\"short phrase from the posting\",\"importance\":\"must\"|\"nice\",\"topic\":\"2-4 word practice topic\",\"status\":\"strong\"|\"thin\"|\"missing\",\"evidence\":\"words copied exactly from the CV or the account that show it, or empty\",\"plan\":\"one concrete thing to practise or learn\"}]}",
      "Rules:",
      "- 6 to 12 requirements, the ones that decide this hiring or admission, most important first.",
      "- strong = the record shows it clearly and the evidence quote proves it. thin = related experience only. missing = nothing in the record.",
      "- evidence must be copied EXACTLY, 6 to 30 words, from the CV or the account. If you cannot quote it, status cannot be strong. Never invent evidence.",
      "- Judge only from the record above. Do not assume skills the candidate has not written down.",
    ].join("\n");
  }

  const STATUS = ["strong", "thin", "missing"];
  function parseReadiness(text, corpus) {
    const j = parseJson(text);
    const list = j && Array.isArray(j.requirements) ? j.requirements : Array.isArray(j) ? j : [];
    const hay = norm(corpus);
    const out = [];
    for (const r of list) {
      const requirement = str(r && r.requirement, 200);
      if (!requirement) continue;
      let status = STATUS.indexOf(r.status) >= 0 ? r.status : "thin";
      let evidence = str(r.evidence, 400);
      let unverified = false;
      if (evidence) {
        const q = norm(evidence);
        if (q.split(" ").length < 4 || !hay.includes(q)) { evidence = ""; unverified = true; }
      }
      if (status === "strong" && !evidence) status = "thin";
      if (status === "missing") evidence = "";
      out.push({ requirement, importance: r.importance === "nice" ? "nice" : "must", topic: str(r.topic, 60) || requirement.slice(0, 40), status, evidence, unverified, plan: str(r.plan, 300) });
    }
    return out.slice(0, 14);
  }

  function readinessScore(items) {
    if (!items || !items.length) return 0;
    let got = 0, all = 0;
    for (const r of items) { const w = r.importance === "must" ? 2 : 1; all += w; got += w * (r.status === "strong" ? 1 : r.status === "thin" ? 0.5 : 0); }
    return Math.round((got / all) * 100);
  }

  // ------------------------------------------------------------ questions
  function buildQuestionsPrompt(o) {
    const mode = o.mode, n = o.count || MODES[mode].count;
    const tough = o.difficulty === "tough";
    const common = [
      INTERVIEWER, "",
      ctxBlock(o.ctx), "", whoBlock(o.cv, o.story), "",
      o.focus && o.focus.length ? "The candidate is weakest on: " + o.focus.join("; ") + ". Aim at least " + Math.min(2, o.focus.length) + " questions at these." : "",
      o.gaps && o.gaps.length ? "Gaps between the posting and the candidate's record: " + o.gaps.join("; ") + ". A real panel would probe these." : "",
      o.asked && o.asked.length ? "Do not repeat these earlier questions: " + o.asked.slice(-20).join(" | ") : "",
      tough ? "Difficulty: TOUGH. Ask the questions a sceptical panel asks. Probe for evidence, trade-offs and what went wrong." : "Difficulty: standard.",
    ];
    if (mode === "quiz") {
      return common.concat([
        `Write ${n} multiple-choice technical questions on the skills this position names. Test understanding and judgement, not trivia or acronyms.`,
        "Return ONLY JSON: {\"items\":[{\"topic\":\"2-4 words\",\"question\":\"...\",\"options\":[\"A text\",\"B text\",\"C text\",\"D text\"],\"answer\":0,\"explanation\":\"why it is right and why the tempting wrong answer fails\"}]}",
        "Rules: exactly four options; answer is the index (0 to 3) of the one correct option; the wrong options must be plausible to a half-prepared candidate; each question rests on something the posting actually asks for; the explanation must be correct. If you are unsure a fact is right, ask a different question.",
      ]).filter(Boolean).join("\n");
    }
    const types = mode === "defence"
      ? "motivation, novelty, methods, risk, literature, feasibility, ethics"
      : "motivation, competency, technical, situational, curveball";
    return common.concat([
      mode === "defence"
        ? `Write ${n} questions an examiner or supervisor would put to this applicant about their own proposal and this programme. Use the proposal text. Include what happens if the main result does not appear, and why this method.`
        : `Write ${n} interview questions for this position, mixed across types. At least one must ask for a real example of something the posting requires, at least one must be technical, and one should be a curveball.`,
      "Return ONLY JSON: {\"items\":[{\"topic\":\"2-4 words\",\"type\":\"" + types.split(", ").join("|") + "\",\"question\":\"one question, as spoken\",\"lookFor\":\"what a strong answer must contain\"}]}",
      "Rules: one question per item, no sub-questions; refer to real specifics of the posting; plain spoken English; do not assume experience the candidate has not got, but do test whether they can speak honestly about the gap.",
    ]).filter(Boolean).join("\n");
  }

  function shuffle(a, rng) {
    const r = rng || Math.random;
    const x = a.slice();
    for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; }
    return x;
  }

  function parseItems(mode, text, rng) {
    const j = parseJson(text);
    const list = j && Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : [];
    const out = [];
    for (const r of list) {
      const question = str(r && r.question, 700);
      if (question.length < 15) continue;
      const base = { mode, topic: str(r.topic, 60) || "General", question };
      if (mode === "quiz") {
        const options = arr(r.options, 6, 300);
        const ans = Number(r.answer);
        if (options.length !== 4 || new Set(options.map(norm)).size !== 4 || !Number.isInteger(ans) || ans < 0 || ans > 3) continue;
        const explanation = str(r.explanation, 700);
        if (!explanation) continue;
        const order = shuffle([0, 1, 2, 3], rng);
        out.push(Object.assign(base, { options: order.map((i) => options[i]), answer: order.indexOf(ans), explanation }));
      } else {
        out.push(Object.assign(base, { type: str(r.type, 30) || "general", lookFor: str(r.lookFor, 500) }));
      }
    }
    return out.slice(0, 12);
  }

  // ------------------------------------------------------------ practical challenges
  function buildChallengePrompt(o) {
    const n = o.count || MODES.challenge.count;
    return [
      INTERVIEWER, "",
      ctxBlock(o.ctx), "", whoBlock(o.cv, o.story), "",
      o.focus && o.focus.length ? "The candidate is weakest on: " + o.focus.join("; ") + ". Use at least one of these." : "",
      o.asked && o.asked.length ? "Do not repeat these earlier scenarios: " + o.asked.slice(-12).join(" | ") : "",
      o.difficulty === "tough" ? "Difficulty: TOUGH: a subtle fault, or two interacting faults." : "Difficulty: standard: one clear fault a competent practitioner finds with some care.",
      "",
      `Write ${n} practical tests of the kind this employer would set: a short troubleshooting, review, design or write-a-fix task in the technology the posting names (for a network role: a configuration or a log; for software or data: a short script or query; for research: a flawed experiment or method description).`,
      "Return ONLY JSON: {\"items\":[{\"topic\":\"2-4 words\",\"title\":\"...\",\"scenario\":\"2-4 sentences of context\",\"artefact\":\"the config, log, code or text under test, at most 30 lines, plain text\",\"task\":\"exactly what the candidate must do\",\"reference\":{\"findings\":[\"each fault or key point\"],\"fix\":\"the correct fix or decision\",\"explanation\":\"why\"}}]}",
      "Rules: the fault must really be in the artefact and findable from it alone; the reference must be technically correct (if unsure, change the task); no real company or person names; write the artefact as real text, not a description of text.",
    ].filter(Boolean).join("\n");
  }

  function parseChallenges(text) {
    const j = parseJson(text);
    const list = j && Array.isArray(j.items) ? j.items : Array.isArray(j) ? j : [];
    const out = [];
    for (const r of list) {
      const ref = r && r.reference ? r.reference : {};
      const item = {
        mode: "challenge", topic: str(r && r.topic, 60) || "Practical", title: str(r && r.title, 120) || "Practical task",
        scenario: str(r && r.scenario, 800), artefact: str(r && r.artefact, 3000), task: str(r && r.task, 500),
        reference: { findings: arr(ref.findings, 6, 400), fix: str(ref.fix, 800), explanation: str(ref.explanation, 800) },
      };
      if (!item.artefact || item.task.length < 15 || !item.reference.findings.length) continue;
      item.question = `${item.title}\n\n${item.scenario}\n\n${item.task}`;
      out.push(item);
    }
    return out.slice(0, 4);
  }

  // A second look at a generated test, because a flawed test teaches the wrong thing.
  function buildChallengeCheckPrompt(item) {
    return [
      "You are a strict technical reviewer. Below is a practical test and the author's reference answer. Decide whether the test is fair and the reference is correct.",
      "", "SCENARIO: " + item.scenario, "ARTEFACT:\n" + item.artefact, "TASK: " + item.task,
      "REFERENCE FINDINGS: " + item.reference.findings.join(" | "), "REFERENCE FIX: " + item.reference.fix,
      "", "Check: is each finding really present in the artefact? Is the fix technically correct? Is anything important missed or wrongly stated?",
      "Return ONLY JSON: {\"ok\":true|false,\"problems\":[\"each problem, briefly\"]}",
    ].join("\n");
  }
  function parseCheck(text) {
    const j = parseJson(text);
    if (!j || typeof j !== "object") return { ok: false, problems: ["The reviewer's answer could not be read."], unchecked: true };
    return { ok: j.ok === true, problems: arr(j.problems, 5, 300) };
  }

  // ------------------------------------------------------------ grading
  function buildGradePrompt(o) {
    const it = o.item, mode = it.mode;
    const lines = [
      INTERVIEWER + " Now you grade the candidate's answer, honestly and specifically. Five out of ten is a typical, acceptable answer; do not inflate. Vague, generic or unfocused answers score low whatever their length.",
      "", ctxBlock(o.ctx), "", whoBlock(o.cv, o.story), "",
      "THE QUESTION" + (mode === "challenge" ? " (practical test)" : "") + ":", it.question,
    ];
    if (mode === "challenge") lines.push("", "ARTEFACT UNDER TEST:\n" + it.artefact, "", "REFERENCE (hidden from the candidate): findings: " + it.reference.findings.join(" | ") + ". Fix: " + it.reference.fix + ". Why: " + it.reference.explanation);
    else if (it.lookFor) lines.push("", "What a strong answer must contain: " + it.lookFor);
    lines.push("", "THE EXCHANGE SO FAR:");
    for (const t of o.turns) lines.push(`Interviewer: ${t.q}`, `Candidate: ${t.a || "(no answer)"}`);
    lines.push("",
      o.timedOut ? "The candidate ran out of time; note what a complete answer in the time would have needed." : "",
      "Return ONLY JSON: {\"score\":0-10 integer,\"verdict\":\"one sentence\",\"strengths\":[\"max 3\"],\"gaps\":[\"max 3, specific\"],\"biggestFix\":\"the one change that would improve this answer most\",\"followUp\":\"" + (o.followupsLeft > 0 ? "a sharp follow-up question that probes the weakest or least supported part of what they said, or empty if the answer was complete" : "") + "\",\"modelAnswer\":\"...\",\"unsupportedClaims\":[\"claims about the candidate's own history not found in the CV or account\"]}",
      "Rules:",
      "- Score the content: specificity, correctness, structure, honesty about limits, and for personal questions a real example with a result. If the answer has under 15 words the score is at most 3.",
      mode === "challenge" ? "- For a practical test: credit each reference finding the candidate found, penalise missed faults and wrong fixes, and say which findings they missed." : "",
      o.followupsLeft > 0 ? "- followUp: one question only, in the interviewer's voice, aimed at the weakest point." : "- followUp must be empty.",
      "- modelAnswer: for a question about the candidate's own experience, outline a strong answer using ONLY facts in the CV or account. If their record has no suitable example, say exactly that and name the kind of example to prepare; never invent one. For a technical question give the correct, concise answer.",
      "- unsupportedClaims: only claims about what the candidate did, owned or achieved that the CV or account does not support. Empty if none.",
    );
    return lines.filter((x) => x !== "").join("\n");
  }

  function parseGrade(text) {
    const j = parseJson(text);
    if (!j || typeof j !== "object" || Array.isArray(j)) return null;
    let score = Math.round(Number(j.score));
    if (!Number.isFinite(score)) return null;
    score = Math.max(0, Math.min(10, score));
    return {
      score, verdict: str(j.verdict, 400), strengths: arr(j.strengths, 3), gaps: arr(j.gaps, 3), biggestFix: str(j.biggestFix, 500),
      followUp: str(j.followUp, 500), modelAnswer: str(j.modelAnswer, 2500), unsupportedClaims: arr(j.unsupportedClaims, 5),
    };
  }

  // Figures in a spoken or typed answer that the record does not contain:
  // rehearsing a number you cannot back up is how people get caught.
  function honestyFlags(answer, facts) {
    const P = root.Proposal;
    return P && P.numberCheck ? P.numberCheck(answer, facts) : [];
  }

  function gradeQuiz(item, choice) {
    const correct = choice === item.answer;
    return { correct, score: correct ? 10 : 0 };
  }

  // The item's score across the question and its follow-ups.
  function itemScore(turns) {
    const s = (turns || []).map((t) => t.grade && t.grade.score).filter((x) => Number.isFinite(x));
    if (!s.length) return 0;
    return Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10;
  }

  // ------------------------------------------------------------ progress
  function newStats() { return { topics: {}, sessions: [] }; }
  const topicKey = (t) => norm(t) || "general";

  function recordItem(stats, o) {
    const k = topicKey(o.topic);
    const t = stats.topics[k] || (stats.topics[k] = { name: str(o.topic, 60) || "General", n: 0, sum: 0, last: 0, lastAt: "" });
    t.n += 1; t.sum += o.score; t.last = o.score; t.lastAt = o.at || "";
    return t;
  }
  const avg = (t) => (t.n ? t.sum / t.n : 0);

  function weakTopics(stats, n) {
    return Object.values(stats.topics).filter((t) => t.n >= 1 && (avg(t) < 6.5 || t.last < 5)).sort((a, b) => avg(a) - avg(b) || a.last - b.last).slice(0, n || 3).map((t) => t.name);
  }

  // What to aim the next round at: practised weak spots first, then the
  // must-have requirements the record is thin or missing on and that have
  // never been practised.
  function focusTopics(stats, readiness, n) {
    const out = weakTopics(stats, n || 3);
    for (const r of (readiness || []).slice().sort((a, b) => (a.importance === "must" ? 0 : 1) - (b.importance === "must" ? 0 : 1))) {
      if (out.length >= (n || 3)) break;
      if (r.status === "strong") continue;
      const t = stats.topics[topicKey(r.topic)];
      if (!t && out.indexOf(r.topic) < 0) out.push(r.topic);
    }
    return out.slice(0, n || 3);
  }

  function roundSummary(items) {
    const done = (items || []).filter((i) => Number.isFinite(i.score));
    if (!done.length) return { count: 0, avg: 0, byTopic: [], best: null, worst: null };
    const by = {};
    for (const i of done) { const k = topicKey(i.topic); (by[k] = by[k] || { topic: i.topic, sum: 0, n: 0 }); by[k].sum += i.score; by[k].n += 1; }
    const byTopic = Object.values(by).map((x) => ({ topic: x.topic, avg: Math.round((x.sum / x.n) * 10) / 10 })).sort((a, b) => a.avg - b.avg);
    const total = done.reduce((a, b) => a + b.score, 0);
    return { count: done.length, avg: Math.round((total / done.length) * 10) / 10, byTopic, best: byTopic[byTopic.length - 1], worst: byTopic[0] };
  }

  function addSession(stats, s) {
    const trimmed = Object.assign({}, s, { items: (s.items || []).map((i) => ({ topic: i.topic, mode: i.mode, question: clip(i.question, 300), score: i.score })) });
    stats.sessions.unshift(trimmed);
    stats.sessions = stats.sessions.slice(0, 40);
    return stats;
  }

  function normalizeStats(x) {
    const s = x && typeof x === "object" ? x : {};
    const topics = {};
    for (const [k, v] of Object.entries(s.topics && typeof s.topics === "object" ? s.topics : {})) {
      if (v && Number.isFinite(v.n) && Number.isFinite(v.sum)) topics[k] = { name: str(v.name, 60) || k, n: v.n, sum: v.sum, last: Number.isFinite(v.last) ? v.last : 0, lastAt: str(v.lastAt, 40) };
    }
    return { topics, sessions: Array.isArray(s.sessions) ? s.sessions.slice(0, 40) : [], readiness: s.readiness && typeof s.readiness === "object" ? s.readiness : {} };
  }

  const api = {
    MODES, LEVELS, parseJson, targetKey, contextFor, buildReadinessPrompt, parseReadiness, readinessScore,
    buildQuestionsPrompt, parseItems, buildChallengePrompt, parseChallenges, buildChallengeCheckPrompt, parseCheck,
    buildGradePrompt, parseGrade, honestyFlags, gradeQuiz, itemScore,
    newStats, recordItem, weakTopics, focusTopics, roundSummary, addSession, normalizeStats, topicKey,
  };
  root.Training = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
