/* Linuxlabui: Linux service troubleshooting labs. A ticket, a Server terminal and a Client terminal,
   hints, a check that runs the same user-facing tests, and an honest "show the cause". */
(function (root) {
  "use strict";
  const Labs = root.Linuxlabs || (typeof require !== "undefined" ? require("./linuxlabs.js") : null);
  const Sh = root.Linuxsh || (typeof require !== "undefined" ? require("./linuxsh.js") : null);
  const KEY = "jr_linuxlabs";

  function mount(host, env) {
    const el = env.el, lsGet = env.lsGet, lsSet = env.lsSet, doc = host.ownerDocument;
    let lab = null, cur = "server", out = { server: [], client: [] }, hist = { server: [], client: [] }, hpos = {}, shown = 0, revealed = false, msg = "", verdict = null, reported = false, scen = "web";
    const save = () => { try { lsSet(KEY, lab ? { lab: Labs.serialise(lab), out: { server: out.server.slice(-120), client: out.client.slice(-120) }, hist: { server: hist.server.slice(-60), client: hist.client.slice(-60) }, shown, revealed, scen, reported } : { scen }); } catch (e) { /* storage may be blocked */ } };
    const report = (pass) => { if (!env.onResult || !lab || reported) return; reported = true; try { env.onResult({ kind: "net", scenario: lab.scenario, fault: lab.faultId, double: !!(lab.opts && lab.opts.double), pass, hints: shown, cmds: lab.cmds || 0, vendors: ["linux"] }); } catch (e) { /* the path must never break a lab */ } };
    function start(scenario, seed, opts) { scen = scenario; lab = Labs.create(scenario, seed || 1 + Math.floor(Math.random() * 1e6), opts || {}); out = { server: [], client: [] }; hist = { server: [], client: [] }; hpos = {}; shown = 0; revealed = false; msg = ""; verdict = null; reported = false; cur = "server"; save(); render(true); return lab; }
    function restoreSaved() { const s = lsGet(KEY, null); if (!s) return; if (s.scen && Labs.SC[s.scen]) scen = s.scen; if (!s.lab) return; try { lab = Labs.restore(s.lab); out = s.out || out; hist = s.hist || hist; shown = s.shown || 0; revealed = !!s.revealed; reported = !!s.reported; } catch (e) { lab = null; } }
    const boxOf = () => (cur === "client" ? lab.client : lab.server);
    const prompt = (b) => `${b.user}@${b.name}:${b.cwd === b.users[b.user].home ? "~" : b.cwd}$ `;
    function runLine(line) {
      const b = boxOf(), p = prompt(b); if (!line.trim()) return; lab.cmds = (lab.cmds || 0) + 1;
      let r = { out: "" }; if (line.trim() === "exit") r = { out: "logout is not needed here: use the tabs to switch machine." }; else { try { r = Sh.runLine(b, line); } catch (e) { r = { out: "The lab shell could not run that: " + (e && e.message ? e.message : "error") }; } }
      out[cur].push({ p, c: line, o: r.out }); if (out[cur].length > 200) out[cur].shift(); hist[cur].push(line); hpos[cur] = hist[cur].length; save();
    }
    function check() {
      const v = Labs.verify(lab); verdict = v;
      if (v.solved && !lab.solved) { lab.solved = true; msg = `Fixed. Score ${Labs.score(lab)} (hints used ${shown}${revealed ? ", cause shown" : ""}, commands ${lab.cmds}).`; report(!revealed); } else if (!v.solved) msg = `${v.problems.length} of ${v.total} checks still fail.`;
      save(); render(false);
    }
    function render(focus) {
      host.textContent = ""; if (!doc) return;
      const sel = el("select", { id: "ll-scen", "aria-label": "Lab type" }, Labs.CATALOG.map((c) => el("option", { value: c.id, text: c.title, selected: c.id === scen ? "selected" : undefined })));
      sel.addEventListener("change", () => { scen = sel.value; save(); });
      host.appendChild(el("div", { class: "row" }, [sel, el("button", { class: "btn", id: "ll-new", text: "New lab", onclick: () => start(sel.value, 0, {}) })]));
      if (!lab) { host.appendChild(el("p", { class: "small", text: "Pick a lab type and press New lab. You get a ticket, a server to diagnose and a client machine to test from. Every lab is different, and some hide two faults at once." })); return; }
      host.appendChild(el("div", { class: "tr-card" }, [el("h4", { text: lab.title + (lab.opts && lab.opts.double ? " (two faults)" : "") }), el("p", { class: "small", text: lab.intro }), el("p", { id: "ll-ticket", class: "ll-ticket", text: lab.ticket })]));
      host.appendChild(el("div", { class: "row nl-tabs", role: "tablist" }, ["server", "client"].map((n) => el("button", { class: "btn" + (n === cur ? " nl-on" : ""), role: "tab", id: "ll-tab-" + n, "aria-selected": n === cur ? "true" : "false", text: n === "server" ? `Server (${lab.server.name})` : "Client", onclick: () => { cur = n; render(true); } }))));
      const b = boxOf(), box = el("div", { id: "ll-term", class: "nl-term", role: "log", "aria-live": "polite", "aria-label": `Terminal of the ${cur}` });
      if (!out[cur].length) box.appendChild(el("div", { class: "small", text: `Connected to the ${cur} (${b.name}, ${b.ip}) as ${b.user}. Type help for the commands available.` }));
      for (const l of out[cur]) { box.appendChild(el("div", { text: l.p + l.c })); if (l.o) box.appendChild(el("pre", { class: "nl-out", text: l.o })); }
      host.appendChild(box);
      const input = el("input", { type: "text", id: "ll-in", class: "nl-in", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": `Command for the ${cur}` });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { const v = input.value; input.value = ""; runLine(v); render(true); }
        else if (e.key === "ArrowUp") { e.preventDefault(); const h = hist[cur] || []; if (h.length) { hpos[cur] = Math.max(0, (hpos[cur] === undefined ? h.length : hpos[cur]) - 1); input.value = h[hpos[cur]]; } }
        else if (e.key === "ArrowDown") { e.preventDefault(); const h = hist[cur] || []; hpos[cur] = Math.min(h.length, (hpos[cur] === undefined ? h.length : hpos[cur]) + 1); input.value = h[hpos[cur]] || ""; }
      });
      host.appendChild(el("label", { class: "nl-line", for: "ll-in" }, [el("span", { class: "nl-prompt", text: prompt(b) }), input]));
      const row = el("div", { class: "row" }, [
        el("button", { class: "btn", id: "ll-check", text: "Check my fix", onclick: check }),
        el("button", { class: "btn", id: "ll-hint", text: shown < lab.hints.length ? `Hint (${shown}/${lab.hints.length})` : "No more hints", disabled: shown >= lab.hints.length ? "disabled" : undefined, onclick: () => { shown++; save(); render(true); } }),
        el("button", { class: "btn", id: "ll-reveal", text: "Show the cause", onclick: () => { if (!revealed && !lab.solved && !root.confirm("Show the cause? This counts against the score and, on the path, as a miss.")) return; if (!revealed && !lab.solved) report(false); revealed = true; save(); render(true); } }),
      ]);
      host.appendChild(row);
      for (let i = 0; i < shown; i++) host.appendChild(el("div", { class: "note", text: `Hint ${i + 1}: ${lab.hints[i]}` }));
      if (msg) host.appendChild(el("div", { class: "note", id: "ll-msg", role: "status", text: msg }));
      if (verdict && !verdict.solved) host.appendChild(el("ul", { id: "ll-problems" }, verdict.problems.map((p) => el("li", { class: "small", text: "Still failing: " + p }))));
      if (revealed || lab.solved) host.appendChild(el("div", { class: "tr-card", id: "ll-why" }, [el("h4", { text: `The cause: ${lab.faultTitle}` }), el("p", { text: lab.why })]));
      if (focus) { const i = host.querySelector("#ll-in"); if (i) { i.focus(); const t = host.querySelector("#ll-term"), fix = () => { if (t) t.scrollTop = t.scrollHeight; }; fix(); if (root.setTimeout) root.setTimeout(fix, 0); } }
    }
    restoreSaved(); render(false);
    return { start, state: () => lab, render };
  }
  const api = { mount }; root.Linuxlabui = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
