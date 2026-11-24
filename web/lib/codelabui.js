/* Codelabui: the coding lab screen. A task, an editor, tests that run in the browser,
   hidden tests so an answer cannot be hard-coded, hints, a model solution and an optional review. */
(function (root) {
  "use strict";
  const Tasks = root.Codetasks || (typeof require !== "undefined" ? require("./codetasks.js") : null);
  const Run = root.Coderun || (typeof require !== "undefined" ? require("./coderun.js") : null);
  const KEY = "jr_code";
  const LV = { 1: "Level 1: basics", 2: "Level 2: working code", 3: "Level 3: algorithms" };

  function mount(host, env) {
    const el = env.el, lsGet = env.lsGet, lsSet = env.lsSet, doc = host.ownerDocument;
    const runner = env.runner || Run.browserRunner();
    let st = lsGet(KEY, null) || {}; st.drafts = st.drafts || {}; st.solved = st.solved || {}; st.last = st.last || { id: Tasks.TASKS[0].id, lang: "py" }; st.hints = st.hints || {}; st.viewed = st.viewed || {};
    let result = null, busy = false, note = "", review = "", status = "idle";
    const save = () => { try { lsSet(KEY, st); } catch (e) { /* storage may be blocked */ } };
    const task = () => Tasks.byId(st.last.id) || Tasks.TASKS[0];
    const dk = () => st.last.id + "|" + st.last.lang;
    const code = () => (st.drafts[dk()] !== undefined ? st.drafts[dk()] : task().starter[st.last.lang]);
    if (runner.onStatus) runner.onStatus((s) => { status = s; const n = host.querySelector("#cl-status"); if (n) n.textContent = s === "loading" ? "Loading the Python runtime (about 10 MB, only the first time)..." : s === "running" ? "Running..." : ""; });

    async function go(hidden) {
      if (busy) return; const ta = host.querySelector("#cl-code"); if (ta) { st.drafts[dk()] = ta.value; save(); }
      busy = true; result = null; note = ""; review = ""; render();
      const r = await Run.grade(task(), st.last.lang, code(), runner, { visibleOnly: !hidden });
      busy = false; result = Object.assign({ hidden }, r);
      if (hidden && r.ok && r.allPassed) { const s = (st.solved[st.last.id] = st.solved[st.last.id] || {}); if (!s[st.last.lang]) s[st.last.lang] = { at: Date.now(), hints: st.hints[dk()] || 0, viewed: !!st.viewed[dk()] }; }
      save(); render(true);
    }
    function listing() {
      const all = Tasks.TASKS, done = all.filter((t) => st.solved[t.id] && (st.solved[t.id].py || st.solved[t.id].js)).length;
      return { done, total: all.length };
    }
    function resultView() {
      if (busy) return el("p", { class: "small", id: "cl-status", role: "status", text: status === "loading" ? "Loading the Python runtime (about 10 MB, only the first time)..." : "Running..." });
      if (!result) return el("p", { class: "small", id: "cl-status", role: "status" });
      if (!result.ok) return el("div", { class: "tr-card", role: "status", id: "cl-result" }, [el("h4", { text: result.timedOut ? "Stopped" : "Your code could not run" }), el("pre", { class: "nl-out cl-pre", text: result.error })]);
      const parts = [], ex = result.cases.filter((c) => c.kind === "example"), hid = result.cases.filter((c) => c.kind !== "example");
      const exOk = ex.filter((c) => c.pass).length, hidOk = hid.filter((c) => c.pass).length;
      parts.push(el("h4", { text: result.hidden ? (result.allPassed ? `All ${result.total} tests passed` : `${result.passed} of ${result.total} tests passed`) : `${exOk} of ${ex.length} examples passed` }));
      if (result.hidden) parts.push(el("p", { class: "small", text: `Examples: ${exOk}/${ex.length}. Hidden tests (edge cases and random inputs): ${hidOk}/${hid.length}.` }));
      if (result.allPassed && result.hidden) parts.push(el("p", { text: "Solved. Compare with the model solution to see a different way, then try the other language." }));
      const bad = result.firstFail !== null ? result.cases[result.firstFail] : null;
      if (bad) { parts.push(el("p", { class: "small", text: bad.kind === "example" ? "First failing example:" : "First failing hidden test (" + bad.kind + "):" }));
        parts.push(el("pre", { class: "nl-out cl-pre", text: "input    " + JSON.stringify(bad.args) + "\nexpected " + JSON.stringify(bad.expected) + "\n" + (bad.error ? "error    " + bad.error : "got      " + (bad.undef ? "nothing (the function returned no value)" : JSON.stringify(bad.got))) })); }
      if (result.stdout) parts.push(el("details", {}, [el("summary", { text: "Printed output" }), el("pre", { class: "nl-out cl-pre", text: result.stdout })]));
      return el("div", { class: "tr-card", role: "status", id: "cl-result" }, parts);
    }
    function render(focusRes) {
      host.textContent = ""; const t = task(), lang = st.last.lang, p = listing();
      const sel = el("select", { id: "cl-task", "aria-label": "Task" }, [1, 2, 3].map((lv) => el("optgroup", { label: LV[lv] }, Tasks.TASKS.filter((x) => x.level === lv).map((x) => el("option", { value: x.id, text: (st.solved[x.id] && (st.solved[x.id].py || st.solved[x.id].js) ? "✓ " : "") + x.title, selected: x.id === t.id ? "selected" : undefined })))));
      sel.addEventListener("change", () => { st.last.id = sel.value; result = null; review = ""; save(); render(); });
      const lg = el("select", { id: "cl-lang", "aria-label": "Language" }, [el("option", { value: "py", text: "Python", selected: lang === "py" ? "selected" : undefined }), el("option", { value: "js", text: "JavaScript", selected: lang === "js" ? "selected" : undefined })]);
      lg.addEventListener("change", () => { const ta = host.querySelector("#cl-code"); if (ta) st.drafts[dk()] = ta.value; st.last.lang = lg.value; result = null; review = ""; save(); render(); });
      host.appendChild(el("div", { class: "row" }, [sel, lg, el("span", { class: "small", text: `${p.done} of ${p.total} tasks solved` })]));
      const sv = st.solved[t.id] || {};
      host.appendChild(el("div", { class: "tr-card" }, [el("h4", { text: `${t.title}  ·  ${t.topic}` }), el("p", { text: t.statement }), el("div", { class: "small", text: "Examples" }),
        el("pre", { class: "nl-out cl-pre", text: t.examples.map((e) => `${t.names[lang]}(${e.args.map((a) => JSON.stringify(a)).join(", ")})  ->  ${JSON.stringify(e.out)}`).join("\n") }),
        el("div", { class: "small", text: (sv.py ? "Python solved. " : "") + (sv.js ? "JavaScript solved. " : "") })]));
      const ta = el("textarea", { id: "cl-code", class: "cl-code", spellcheck: "false", autocapitalize: "off", "aria-label": `${lang === "py" ? "Python" : "JavaScript"} code editor`, rows: "14" });
      ta.value = code();
      ta.addEventListener("input", () => { st.drafts[dk()] = ta.value; save(); });
      ta.addEventListener("keydown", (e) => { if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); const s = ta.selectionStart; ta.value = ta.value.slice(0, s) + "    " + ta.value.slice(ta.selectionEnd); ta.selectionStart = ta.selectionEnd = s + 4; st.drafts[dk()] = ta.value; } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(true); } });
      host.appendChild(ta);
      const hn = st.hints[dk()] || 0;
      host.appendChild(el("div", { class: "row" }, [
        el("button", { class: "btn", id: "cl-run", text: "Run examples", disabled: busy ? "disabled" : undefined, onclick: () => go(false) }),
        el("button", { class: "btn", id: "cl-submit", text: "Submit (all tests)", disabled: busy ? "disabled" : undefined, onclick: () => go(true) }),
        el("button", { class: "btn", id: "cl-hint", text: hn < t.hints.length ? `Hint (${hn}/${t.hints.length})` : "No more hints", disabled: hn >= t.hints.length ? "disabled" : undefined, onclick: () => { st.hints[dk()] = hn + 1; save(); render(); } }),
        el("button", { class: "btn", id: "cl-model", text: "Model solution", onclick: () => { if (!st.viewed[dk()] && !root.confirm("Show the model solution? Try the hints first.")) return; st.viewed[dk()] = true; save(); render(); } }),
        el("button", { class: "btn", id: "cl-reset", text: "Reset code", onclick: () => { if (!root.confirm("Replace your code with the starter?")) return; delete st.drafts[dk()]; result = null; save(); render(); } }),
      ]));
      for (let i = 0; i < hn; i++) host.appendChild(el("div", { class: "note", text: `Hint ${i + 1}: ${t.hints[i]}` }));
      host.appendChild(resultView());
      if (st.viewed[dk()]) host.appendChild(el("div", { class: "tr-card", id: "cl-solution" }, [el("h4", { text: "Model solution" }), el("pre", { class: "nl-out cl-pre", text: t.sol[lang] })]));
      if (env.callGemini && result && result.ok && result.hidden) {
        host.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "cl-review", text: "Ask for a code review", onclick: async () => { review = "Reviewing..."; render(); try { review = await env.callGemini(`You are a senior network automation engineer reviewing a learner's ${lang === "py" ? "Python" : "JavaScript"} solution. The task: ${t.statement}\nTest result: ${result.passed}/${result.total} passed.\nSolution:\n${code()}\n\nGive at most 5 short, concrete observations (correctness risks, edge cases, readability, complexity, what a production version would do differently). Plain text, no preamble. Do not rewrite the whole solution.`); } catch (e) { review = "The review could not be fetched: " + (e && e.message || e); } render(); } })]));
        if (review) host.appendChild(el("div", { class: "note", id: "cl-review-text", text: review, style: "white-space:pre-wrap" }));
      }
      if (focusRes) { const r = host.querySelector("#cl-result, #cl-status"); if (r && r.scrollIntoView) { try { r.scrollIntoView({ block: "nearest" }); } catch (e) { /* ok */ } } }
    }
    render(); return { render, state: () => st };
  }
  const api = { mount }; root.Codelabui = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
