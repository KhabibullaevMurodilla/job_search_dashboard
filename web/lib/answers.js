// Answers to the free-text questions on application forms ("Why us?",
// "What have you done?", "Describe a time..."). Written only from the
// applicant's CV, their own account and the posting; checked afterwards.
(function (root) {
  "use strict";

  const words = (t) => (String(t || "").match(/\S+/g) || []).length;

  // What kind of question this is decides what a good answer needs.
  function questionKind(q) {
    const t = String(q || "").toLowerCase();
    if (/\b(why (us|do you want|are you (interested|applying)|this (company|role|team|position))|what (attracts|draws|interests) you|why .* (join|work (for|with|at)))/.test(t)) return "why";
    if (/\b(describe a time|tell us about a time|give an example|an example of|a situation|challenge you (faced|overcame)|how have you|how did you (handle|deal)|what did you do when)\b/.test(t)) return "time";
    if (/\b(what have you (done|worked|built|achieved)|tell us about your (experience|background)|your experience|what (are you|were you) responsible|what you remember|achievement|proud of|walk us through)\b/.test(t)) return "experience";
    if (/\b(strength|weakness|improve|develop|learn|grow|goal)\b/.test(t)) return "self";
    return "general";
  }

  const GUIDE = {
    why: `This is a "why us" question. Name one or two specific things from the posting or the company text above that draw the candidate in, and tie each to something real in the candidate's own history. If the posting says little about the company, say what the ROLE offers and do not state facts about the company that are not in the text above. No flattery, no "innovative", "dynamic" or "passionate".`,
    time: `This asks for a specific episode. Choose the best matching real episode from the CV or the candidate's own account, and tell it in plain prose: the situation and what was at stake, what the candidate did and why, and what came of it. Use only details that are written there. If nothing there matches the question, do not invent an episode: answer briefly from the closest real experience, and end with a line beginning NOTE: that says what kind of example the candidate should add to their account.`,
    experience: `This asks what the candidate has done and what they were responsible for. Lead with the part of their history that matters most for THIS role, in proportion: the relevant work in some detail with its real scale and tools, minor things in a clause, the irrelevant left out. Say what they owned.`,
    self: `This is about the candidate themselves. Answer from what their own account really shows, including a real weakness stated plainly with what they do about it, never a weakness that is secretly a strength.`,
    general: `Answer the question directly from the candidate's real history and the posting.`,
  };

  function defaultLimit(kind) { return { why: 150, time: 220, experience: 220, self: 150, general: 150 }[kind]; }

  function buildAnswerPrompt(o) {
    const kind = questionKind(o.question);
    const limit = o.limit && o.limit > 0 ? o.limit : defaultLimit(kind);
    return [
      "You are helping a job applicant answer one question on an application form. They will submit the answer under their own name, so it must be true and sound like them.",
      "",
      "THE QUESTION:",
      o.question,
      "",
      `--- the role ---\n${o.title || "(role not given)"}${o.company ? " at " + o.company : ""}\n\n${(o.posting || "(no posting text given)").slice(0, 8000)}`,
      "",
      "--- the candidate's CV ---\n" + (o.cv || ""),
      o.story ? "\n--- the candidate's own written account of their background ---\n" + o.story.slice(0, 40000) : "",
      "",
      GUIDE[kind],
      "",
      "RULES THAT ARE NOT NEGOTIABLE:",
      "- Every fact, number, date, tool and employer must come from the CV or the account above. Never add one.",
      "- Anything about the company must come from the posting text above. Do not use outside knowledge of the company.",
      "- Where the candidate lacks something the question asks for, say so briefly and plainly, or leave it out. Never invent experience or hide a gap behind vague words.",
      `- At most ${limit} words. Write to the point and stop; do not pad to reach the limit.`,
      "- No six consecutive words copied from the CV or the account.",
      "- First person, plain professional English, UK spelling. No em-dashes. No stock openers (\"I am writing to\", \"I am excited\", \"I am passionate\"), no lists of three adjectives, no closing line that restates the answer.",
      o.styleText ? "- Match the way the candidate writes. Their measured style: " + o.styleText : "",
      "",
      "Return ONLY the answer text. If you must flag something, add one last line starting with NOTE:.",
    ].filter((x) => x !== "").join("\n");
  }

  // Splits off the optional NOTE: line.
  function splitNote(text) {
    const t = String(text || "").trim().replace(/^```\w*\n?|```$/g, "").trim();
    const m = t.match(/\n\s*NOTE:\s*([\s\S]*)$/i);
    return m ? { answer: t.slice(0, m.index).trim(), note: m[1].trim() } : { answer: t.replace(/^NOTE:.*$/im, "").trim(), note: (t.match(/^NOTE:\s*(.*)$/im) || [])[1] || "" };
  }

  function checkAnswer(answer, o) {
    const P = root.Proposal, D = root.DashboardCore;
    const problems = [];
    const n = words(answer);
    const kind = questionKind(o.question);
    const limit = o.limit && o.limit > 0 ? o.limit : defaultLimit(kind);
    if (n < 25) problems.push(`only ${n} words, too thin to answer the question`);
    if (n > limit) problems.push(`${n} words, over the ${limit}-word limit`);
    if (/—/.test(answer)) problems.push("contains an em dash");
    if (P) {
      const nums = P.numberCheck(answer, [o.cv, o.story, o.posting].join("\n"));
      if (nums.length) problems.push(`these figures are not in your CV, your account or the posting, so check them: ${nums.join(", ")}`);
      const slop = P.slopCheck(answer);
      for (const i of slop.issues) problems.push(`stock phrasing: ${i.label}`);
    }
    if (D) {
      const c1 = D.sharedNgram(answer, o.cv || "", 6);
      if (c1) problems.push(`copies "${c1}" from your CV word-for-word`);
      const c2 = D.sharedNgram(answer, o.story || "", 6);
      if (c2) problems.push(`copies "${c2}" from your written account word-for-word`);
    }
    return { ok: problems.length === 0, problems, words: n, limit, kind };
  }

  const api = { questionKind, buildAnswerPrompt, splitNote, checkAnswer, defaultLimit };
  root.Answers = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
