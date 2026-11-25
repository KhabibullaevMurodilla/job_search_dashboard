/* Designlabui: design and architecture cases. Choose, justify, get a rubric score with the reasoning for every option. */
(function (root) {
  "use strict";
  const D = root.Designcases || (typeof require !== "undefined" ? require("./designcases.js") : null);
  const KEY = "jr_design";
  const LV = { 1: "Level 1: foundations", 2: "Level 2: working designs", 3: "Level 3: scale and policy", 4: "Level 4: data centre and automation", 5: "Level 5: failure domains and migration" };

  function mount(host, env) {
    const el = env.el, lsGet = env.lsGet, lsSet = env.lsSet, doc = host.ownerDocument;
    let st = lsGet(KEY, null) || {}; st.last = st.last || D.CASES[0].id; st.answers = st.answers || {}; st.done = st.done || {};
    let result = null, review = "", hintsShown = 0, reported = { pass: false, fail: false };
    const save = () => { try { lsSet(KEY, st); } catch (e) { /* storage may be blocked */ } };
    const cur = () => D.byId(st.last) || D.CASES[0];
    const ans = () => (st.answers[st.last] = st.answers[st.last] || { picks: {}, text: "" });
    const report = (pass) => { if (!env.onResult) return; try { env.onResult({ kind: "design", case: st.last, pass, hints: hintsShown }); } catch (e) { /* the path must never break a lab */ } };

    function submit() {
      const c = cur(), a = ans(), ta = host.querySelector("#dl-text"); if (ta) { a.text = ta.value; }
      const r = D.grade(c, a); result = r; review = "";
      if (r.answered) {
        const best = st.done[c.id] ? st.done[c.id].score : -1; if (r.total > best) st.done[c.id] = { score: r.total, at: Date.now(), pass: r.pass };
        if (r.pass && !reported.pass) { reported.pass = true; report(true); } else if (!r.pass && !reported.fail && !reported.pass) { reported.fail = true; report(false); }
      }
      save(); render(true);
    }
    function decisionView(d, i) {
      const a = ans(), box = el("fieldset", { class: "dl-dec" }, [el("legend", { text: `${i + 1}. ${d.q}${d.kind === "multi" ? " (choose all that apply)" : ""}` })]);
      const gd = result ? result.decisions.find((x) => x.id === d.id) : null;
      d.options.forEach((o) => {
        const id = `dl-${d.id}-${o.id}`, picked = d.kind === "single" ? a.picks[d.id] === o.id : (a.picks[d.id] || []).indexOf(o.id) >= 0;
        const inp = el("input", { type: d.kind === "single" ? "radio" : "checkbox", id, name: "dl-" + d.id, value: o.id, checked: picked ? "checked" : undefined, disabled: result ? "disabled" : undefined });
        inp.addEventListener("change", () => { if (d.kind === "single") a.picks[d.id] = o.id; else { const s = new Set(a.picks[d.id] || []); if (inp.checked) s.add(o.id); else s.delete(o.id); a.picks[d.id] = Array.from(s); } save(); });
        const lab = el("label", { for: id, class: "dl-opt" }, [inp, el("span", { text: " " + o.text })]);
        box.appendChild(lab);
        if (result) box.appendChild(el("div", { class: "small dl-why", text: `${picked ? "Your choice. " : ""}${o.pts > 0 ? "Sound" : o.pts === 0 ? "Weak" : "Wrong"}: ${o.why}` }));
      });
      if (gd) box.appendChild(el("div", { class: "small", text: `Score: ${gd.got} of ${gd.max}.` }));
      return box;
    }
    function render(focusRes) {
      host.textContent = ""; if (!doc) return;
      const c = cur(), a = ans(), doneN = D.CASES.filter((x) => st.done[x.id] && st.done[x.id].pass).length;
      const sel = el("select", { id: "dl-case", "aria-label": "Case" }, [1, 2, 3, 4, 5].map((lv) => el("optgroup", { label: LV[lv] }, D.CASES.filter((x) => x.level === lv).map((x) => el("option", { value: x.id, text: (st.done[x.id] && st.done[x.id].pass ? "✓ " : "") + x.title, selected: x.id === c.id ? "selected" : undefined })))));
      sel.addEventListener("change", () => { st.last = sel.value; result = null; review = ""; hintsShown = 0; reported = { pass: false, fail: false }; save(); render(); });
      host.appendChild(el("div", { class: "row" }, [sel, el("span", { class: "small", text: `${doneN} of ${D.CASES.length} cases passed` })]));
      host.appendChild(el("div", { class: "tr-card" }, [el("h4", { text: `${c.title}  ·  ${c.topic}` }), el("p", { text: c.brief })]));
      c.decisions.forEach((d, i) => host.appendChild(decisionView(d, i)));
      const ta = el("textarea", { id: "dl-text", class: "cl-code dl-text", rows: "6", "aria-label": "Your justification", placeholder: "Explain your design in your own words (25 words or more adds a second score for the ideas you cover).", disabled: result ? "disabled" : undefined });
      ta.value = a.text || ""; ta.addEventListener("input", () => { a.text = ta.value; save(); });
      host.appendChild(ta);
      const row = el("div", { class: "row" });
      if (!result) {
        row.appendChild(el("button", { class: "btn", id: "dl-submit", text: "Score my design", onclick: submit }));
        row.appendChild(el("button", { class: "btn", id: "dl-hint", text: hintsShown < c.concepts.length ? `Hint (${hintsShown}/${c.concepts.length})` : "No more hints", disabled: hintsShown >= c.concepts.length ? "disabled" : undefined, onclick: () => { hintsShown++; render(); } }));
      } else row.appendChild(el("button", { class: "btn", id: "dl-again", text: "Try again", onclick: () => { st.answers[c.id] = { picks: {}, text: "" }; result = null; review = ""; reported.fail = true; save(); render(); } }));
      host.appendChild(row);
      for (let i = 0; i < hintsShown && !result; i++) host.appendChild(el("div", { class: "note", text: `Hint ${i + 1}: think about ${c.concepts[i].label}.` }));
      if (result) {
        if (!result.answered) host.appendChild(el("div", { class: "tr-card", id: "dl-result", role: "status" }, [el("h4", { text: "Answer every single-choice question first" })]));
        else {
          const parts = [el("h4", { text: `${result.pass ? "Passed" : "Not yet"}: ${result.total}/100` }), el("p", { class: "small", text: `Decisions ${result.dPct}%.` + (result.useText ? ` Justification ${result.cPct}% of the key ideas.` : " Write 25 or more words of justification to add the second score.") })];
          parts.push(el("div", { class: "small", text: "Ideas a strong answer covers:" }));
          parts.push(el("ul", {}, result.concepts.map((k) => el("li", { class: "small", text: `${k.hit ? "Covered" : "Not mentioned"}: ${k.label}` }))));
          parts.push(el("details", { open: "open" }, [el("summary", { text: "Reference design" }), el("p", { text: c.model })]));
          host.appendChild(el("div", { class: "tr-card", id: "dl-result", role: "status" }, parts));
          if (env.callGemini && a.text && a.text.split(/\s+/).length >= 25) host.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "dl-review", text: "Ask for a critique of my justification", onclick: async () => { review = "Reviewing..."; render(); try { review = await env.callGemini(`You are a principal network architect. Case: ${c.brief}\nReference design: ${c.model}\nLearner's justification: ${a.text}\nIn under 150 words say what is right, what is wrong or missing, and one trade-off they did not consider. Do not invent facts about the case.`); } catch (e) { review = "The review could not be fetched: " + (e && e.message ? e.message : "unknown error"); } render(); } })]));
          if (review) host.appendChild(el("div", { class: "note", id: "dl-review-text", text: review, style: "white-space:pre-wrap" }));
        }
      }
      if (focusRes) { const r = host.querySelector("#dl-result"); if (r && r.scrollIntoView) { try { r.scrollIntoView({ block: "nearest" }); } catch (e) { /* ok */ } } }
    }
    function open(id) { if (!D.byId(id)) return false; st.last = id; result = null; review = ""; hintsShown = 0; reported = { pass: false, fail: false }; st.answers[id] = { picks: {}, text: "" }; save(); render(); return true; }
    render(); return { render, open, state: () => st };
  }
  const api = { mount }; root.Designlabui = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
