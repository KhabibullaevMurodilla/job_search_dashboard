/* Netlabui: the hands-on lab screen (ticket, topology, device terminals, hints, check, reveal). */
(function (root) {
  "use strict";
  const Labs = root.Netlabs || (typeof require !== "undefined" ? require("./netlabs.js") : null);
  const C = root.Netcli || (typeof require !== "undefined" ? require("./netcli.js") : null);
  const KEY = "jr_netlabs", SKEY = "jr_netlabs_stats";
  const ROLE_COLOR = { router: "#2B2B26", switch: "#2A5A8C", host: "#85805E" };

  function mount(host, env) {
    const el = env.el, lsGet = env.lsGet, lsSet = env.lsSet, doc = host.ownerDocument;
    let lab = null, sessions = {}, cur = null, out = {}, hist = {}, hpos = {}, shownHints = 0, revealed = false, msg = "", verdict = null;
    const stats = () => lsGet(SKEY, {}) || {};
    const report = (pass) => { if (!env.onResult || !lab) return; try { env.onResult({ kind: "net", scenario: lab.scenario, fault: lab.faultId, double: !!(lab.opts && lab.opts.double), pass, hints: lab.used || 0, cmds: lab.cmds || 0, vendors: lab.vendors || [] }); } catch (e) { /* the path must never break a lab */ } };
    function save() { if (!lab) return; try { lsSet(KEY, Object.assign(Labs.serialise(lab), { opts: lab.opts, shown: shownHints, revealed })); } catch (e) { /* storage full or blocked */ } }
    function start(scenario, seed, opts, saved) {
      lab = Labs.create(scenario, seed, opts); sessions = {}; out = {}; hist = {}; hpos = {}; verdict = null; msg = "";
      shownHints = 0; revealed = false;
      if (saved) { try { lab.net = saved.net; Labs.finalize(lab.net); lab.used = saved.used || 0; lab.cmds = saved.cmds || 0; lab.solved = !!saved.solved; shownHints = saved.shown || 0; revealed = !!saved.revealed; } catch (e) { lab = Labs.create(scenario, seed, opts); } }
      cur = Object.keys(lab.net.devices).find((n) => lab.net.devices[n].os !== "linux") || Object.keys(lab.net.devices)[0];
      save(); render();
    }
    const sess = (n) => sessions[n] || (sessions[n] = new C.Session(lab.net, n));
    function run(line) {
      const s = sess(cur), r = s.run(line); lab.cmds++;
      (out[cur] = out[cur] || []).push({ p: r.prompt === null || r.prompt === undefined ? "" : r.prompt, c: line, o: r.out });
      if (r.exit) { delete sessions[cur]; }
      hist[cur] = (hist[cur] || []).concat(line); hpos[cur] = hist[cur].length; save();
    }
    function node(d) { return lab.pos[d.name] || { x: 50, y: 50 }; }
    function topo() {
      const ns = "http://www.w3.org/2000/svg", svg = doc.createElementNS(ns, "svg"); svg.setAttribute("viewBox", "0 0 100 34"); svg.setAttribute("role", "img"); svg.setAttribute("aria-label", "Network topology"); svg.style.cssText = "width:100%;max-width:760px;border:1px solid var(--carbon);background:var(--paper-2)";
      const mk = (t, a, txt) => { const e = doc.createElementNS(ns, t); for (const k in a) e.setAttribute(k, a[k]); if (txt !== undefined) e.textContent = txt; return e; };
      const P = (n) => ({ x: 9 + lab.pos[n].x * 0.82, y: 4 + lab.pos[n].y * 0.26 });
      for (const l of lab.links) { const a = P(l.a), b = P(l.b); svg.appendChild(mk("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: "#2B2B26", "stroke-width": 0.5 })); }
      for (const d of Object.values(lab.net.devices)) { const p = P(d.name), sel = d.name === cur, host = d.os === "linux" && d.role === "host";
        const g = mk("g", { tabindex: 0, role: "button", "aria-label": `${d.name}, ${Labs.NAMES[d.os]}${sel ? ", selected" : ""}`, style: "cursor:pointer" });
        g.appendChild(mk("rect", { x: p.x - 7, y: p.y - 4.4, width: 14, height: 8.8, fill: sel ? "#2B2B26" : "#EAE3D2", stroke: ROLE_COLOR[d.role] || "#2B2B26", "stroke-width": sel ? 0.9 : 0.5 }));
        g.appendChild(mk("text", { x: p.x, y: p.y - 0.4, "text-anchor": "middle", "font-size": 2.6, fill: sel ? "#EAE3D2" : "#2B2B26", "font-family": "Courier Prime, monospace", "font-weight": "bold" }, d.name));
        g.appendChild(mk("text", { x: p.x, y: p.y + 2.6, "text-anchor": "middle", "font-size": 1.8, fill: sel ? "#EAE3D2" : "#85805E", "font-family": "Courier Prime, monospace" }, host ? "host" : ({ ios: "IOS-XE", nxos: "NX-OS", eos: "EOS", junos: "Junos", linux: "Linux" })[d.os]));
        const pick = () => { cur = d.name; render(); const inp = host_.querySelector("#nl-in"); if (inp) inp.focus(); };
        g.addEventListener("click", pick); g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } }); svg.appendChild(g); }
      return svg;
    }
    const host_ = host;
    function terminal() {
      const d = lab.net.devices[cur], s = sess(cur), lines = out[cur] || [];
      const box = el("div", { id: "nl-term", class: "nl-term", role: "log", "aria-live": "polite", "aria-label": `Terminal of ${cur}` });
      if (!lines.length) box.appendChild(el("div", { class: "small", text: `Connected to ${d.name} (${Labs.NAMES[d.os]}). Type commands as on the real device.` }));
      for (const l of lines) { box.appendChild(el("div", { text: `${l.p}${l.c}` })); if (l.o) box.appendChild(el("pre", { class: "nl-out", text: l.o })); }
      const prompt = s.prompt ? s.prompt() : (d.os === "linux" ? d.hostname + ":~$ " : "> ");
      const input = el("input", { type: "text", id: "nl-in", class: "nl-in", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-label": `Command for ${cur}` });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { const v = input.value; input.value = ""; run(v); render(true); }
        else if (e.key === "ArrowUp") { e.preventDefault(); const h = hist[cur] || []; if (h.length) { hpos[cur] = Math.max(0, (hpos[cur] === undefined ? h.length : hpos[cur]) - 1); input.value = h[hpos[cur]]; } }
        else if (e.key === "ArrowDown") { e.preventDefault(); const h = hist[cur] || []; hpos[cur] = Math.min(h.length, (hpos[cur] === undefined ? h.length : hpos[cur]) + 1); input.value = h[hpos[cur]] || ""; }
      });
      const row = el("label", { class: "nl-line", for: "nl-in" }, [el("span", { class: "nl-prompt", text: prompt }), input]);
      return { box, row, input };
    }
    function check() {
      const v = Labs.verify(lab); verdict = v;
      if (v.solved && !lab.solved) { lab.solved = true; report(!revealed); const st = stats(); const k = lab.scenario; st[k] = st[k] || { solved: 0, best: 0, byFault: {} }; st[k].solved++; const sc = revealed ? 0 : Labs.score(lab); st[k].best = Math.max(st[k].best, sc); st[k].byFault[lab.faultId] = (st[k].byFault[lab.faultId] || 0) + 1; lsSet(SKEY, st); }
      save(); render();
    }
    function render(keepFocus) {
      host.textContent = ""; if (!doc) return;
      const st = stats(), solvedAll = Object.values(st).reduce((n, x) => n + x.solved, 0);
      const top = el("div", { class: "row" }), sel = el("select", { id: "nl-scenario", "aria-label": "Lab topic" }, Labs.CATALOG.map((c) => el("option", { value: c.id, text: `${c.area}: ${c.title}`, selected: lab && lab.scenario === c.id ? "selected" : undefined })));
      top.appendChild(sel);
      top.appendChild(el("button", { class: "btn", id: "nl-new", text: lab ? "New lab" : "Start a lab", onclick: () => start(sel.value, 1 + Math.floor(Math.random() * 1e6), {}) }));
      if (solvedAll) top.appendChild(el("span", { class: "small", text: `${solvedAll} lab${solvedAll === 1 ? "" : "s"} solved` }));
      host.appendChild(top);
      if (!lab) { host.appendChild(el("p", { class: "small", text: "Each lab is a small network of Cisco IOS-XE, NX-OS, Arista EOS, Juniper Junos and Linux devices with one fault in it. The vendor mix, addresses and the fault are different every time. You get a ticket, a topology and a real command line on every device. You find the fault with show commands, fix it with configuration commands, then press Check." })); return; }
      const card = el("div", { class: "tr-card nl-ticket" }, [el("h4", { text: `Ticket: ${lab.title}` }), el("p", { text: lab.intro }), el("p", { text: lab.ticket }), el("div", { class: "small", text: `Devices: ${Labs.describe(lab).join(", ")}.` })]);
      host.appendChild(card);
      host.appendChild(topo());
      const t = terminal();
      const tabs = el("div", { class: "row nl-tabs", role: "tablist" }, Object.values(lab.net.devices).map((d) => el("button", { class: "btn" + (d.name === cur ? " nl-on" : ""), role: "tab", "aria-selected": d.name === cur ? "true" : "false", text: d.name, onclick: () => { cur = d.name; render(true); } })));
      host.appendChild(tabs); host.appendChild(t.box); host.appendChild(t.row);
      const hints = el("div", { class: "nl-hints" });
      for (let i = 0; i < shownHints; i++) hints.appendChild(el("div", { class: "note", text: `Hint ${i + 1}: ${lab.hints[i]}` }));
      const act = el("div", { class: "row" }, [
        el("button", { class: "btn", id: "nl-hint", text: shownHints < lab.hints.length ? `Hint (${shownHints}/${lab.hints.length}, costs points)` : "No more hints", disabled: shownHints >= lab.hints.length || lab.solved ? "disabled" : undefined, onclick: () => { shownHints++; lab.used = shownHints; save(); render(true); } }),
        el("button", { class: "btn", id: "nl-check", text: "Check my fix", onclick: check }),
        el("button", { class: "btn", id: "nl-reveal", text: "Show the cause", onclick: () => { if (!revealed && !lab.solved && !root.confirm("Show the cause and give up scoring on this lab?")) return; if (!revealed && !lab.solved) report(false); revealed = true; save(); render(true); } }),
      ]);
      host.appendChild(act); host.appendChild(hints);
      if (verdict) { const ok = verdict.solved; host.appendChild(el("div", { class: "tr-card", role: "status" }, [el("h4", { text: ok ? `Fixed. Score ${revealed ? "0 (cause was shown)" : Labs.score(lab)}/100` : "Not fixed yet" }), ok ? el("p", { text: `${lab.cmds} commands, ${lab.used} hint${lab.used === 1 ? "" : "s"}.` }) : el("ul", {}, verdict.problems.slice(0, 6).map((p) => el("li", { text: p })))])); }
      if (revealed || lab.solved) host.appendChild(el("div", { class: "tr-card" }, [el("h4", { text: `Cause: ${lab.faultTitle}` }), el("p", { text: lab.why })]));
      if (keepFocus) { const i = host.querySelector("#nl-in"); if (i) { i.focus(); const b = host.querySelector("#nl-term"), fix = () => { if (b) b.scrollTop = b.scrollHeight; }; fix(); if (root.setTimeout) root.setTimeout(fix, 0); } }
    }
    try { const sv = lsGet(KEY, null); if (sv && sv.scenario && sv.seed) { start(sv.scenario, sv.seed, sv.opts || {}, sv); return { start, state: () => lab }; } } catch (e) { /* ignore a bad save */ }
    render(); return { start, state: () => lab };
  }
  const api = { mount }; root.Netlabui = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
