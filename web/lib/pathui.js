/* Pathui: the "Path to expert" screen. Shows each skill's level, the next drill chosen from the evidence,
   level checks, reviews that are due, XP, streak and badges. It launches drills in the lab screens. */
(function (root) {
  "use strict";
  const P = root.Path || (typeof require !== "undefined" ? require("./path.js") : null);
  const Labs = root.Netlabs || (typeof require !== "undefined" ? require("./netlabs.js") : null);
  const LLabs = root.Linuxlabs || (typeof require !== "undefined" ? require("./linuxlabs.js") : null);
  const KEY = "jr_path";

  function mount(host, env) {
    const el = env.el, lsGet = env.lsGet, lsSet = env.lsSet, doc = host.ownerDocument, rnd = env.rnd || Math.random;
    let st = P.normalize(lsGet(KEY, null)), msg = "", offer = null, skipped = [];
    const save = () => { try { lsSet(KEY, st); } catch (e) { /* storage may be blocked */ } };
    const now = () => (env.now ? env.now() : Date.now());

    function seedFor(d) {
      // a seed whose lab really carries the wanted fault, and the vendor mix the learner has seen least
      let best = null, bs = -1;
      for (let i = 0; i < 8; i++) {
        const seed = 1 + Math.floor(rnd() * 1e6);
        let lab = null; try { lab = (d.lab === "linux" ? LLabs : Labs).create(d.scenario, seed, P.labOptions(d)); } catch (e) { lab = null; }
        if (!lab || String(lab.faultId).split("+")[0] !== d.fault || (d.double && String(lab.faultId).indexOf("+") < 0)) continue;
        const sc = P.vendorScore(st, lab.vendors); if (sc > bs) { bs = sc; best = seed; }
        if (i >= 3 && best) break;
      }
      return best;
    }
    function launch(d) {
      if (d.kind === "net") {
        const seed = seedFor(d); if (!seed) { msg = "This drill could not be built just now. Try another one."; render(); return; }
        skipped = []; P.activate(st, d); save(); render();
        if (d.lab === "linux") { if (env.startLinux) env.startLinux(d.scenario, seed, P.labOptions(d)); } else if (env.startNet) env.startNet(d.scenario, seed, P.labOptions(d));
      } else {
        P.activate(st, d); save(); render();
        if (d.kind === "design") { if (env.openDesign) env.openDesign(d.task); } else if (env.openCode) env.openCode(d.task, d.lang);
      }
      const target = doc.getElementById(d.kind === "net" ? (d.lab === "linux" ? "ll-pack" : "nl-pack") : d.kind === "design" ? "dl-pack" : "cl-pack"); if (target && target.scrollIntoView) { try { target.scrollIntoView({ block: "start" }); } catch (e) { /* ok */ } }
    }
    function onResult(r) {
      const out = P.record(st, r, now()); save();
      const sk = out.skill ? P.byId(out.skill) : null; if (!sk) return;
      const parts = [r.pass ? `Counted for ${sk.name}: +${out.xp} XP.` : `Noted for ${sk.name}. It will come back for review in a day.`];
      if (out.event) parts.push(out.event.to > out.event.from ? `${sk.name} moved up to ${P.LEVELS[out.event.to - 1]}.` : `${sk.name} moved back to ${P.LEVELS[out.event.to - 1]} to consolidate.`);
      if (out.badges && out.badges.length) parts.push("New badge: " + out.badges.join(", ") + ".");
      msg = parts.join(" "); skipped = []; offer = P.next(st, now(), rnd); render();
    }
    function render() {
      host.textContent = ""; if (!doc) return;
      const rd = P.readiness(st);
      if (!st.started) {
        host.appendChild(el("p", { class: "small", style: "max-width:70ch", text: "A route from first steps to expert in eleven skills: OSPF, eBGP, iBGP, switching, static routing and filters, VXLAN EVPN, Linux web, application and SSH troubleshooting, network automation coding, and design and architecture. It watches how each lab goes, raises or lowers each skill's level on evidence, brings missed drills back for review and always offers the next one. Where do you want to start?" }));
        host.appendChild(el("div", { class: "row" }, [["beginner", "New to networking"], ["working", "I work with networks"], ["senior", "Senior engineer"]].map(([k, t]) => el("button", { class: "btn", id: "pt-start-" + k, text: t, onclick: () => { P.setStart(st, k); save(); offer = P.next(st, now(), rnd); render(); } }))));
        host.appendChild(el("p", { class: "small", text: "You can still move up or down: the path follows your results, not this choice." }));
        return;
      }
      host.appendChild(el("div", { class: "row" }, [
        el("strong", { id: "pt-pct", text: rd.expert ? "Expert in every skill" : `${rd.pct}% of the way to expert` }),
        el("span", { class: "small", text: `${st.xp} XP · streak ${P.streakNow(st, now())} day${P.streakNow(st, now()) === 1 ? "" : "s"}` }),
      ]));
      host.appendChild(el("div", { class: "tr-bar", style: "max-width:520px" }, [el("i", { style: `width:${rd.pct}%` })]));
      if (msg) host.appendChild(el("div", { class: "note", id: "pt-msg", role: "status", text: msg }));
      // next drill
      const d = offer || (offer = P.next(st, now(), rnd));
      if (d) {
        const why = d.mode === "review" ? "Review: you missed this one earlier." : d.mode === "check" ? "Level check: pass it to move up straight away." : `Next for ${P.byId(d.skill).name} at ${P.LEVELS[d.level - 1]}.`;
        host.appendChild(el("div", { class: "tr-card", id: "pt-next" }, [el("h4", { text: "Next drill: " + d.title }), el("p", { class: "small", text: why + (d.double ? " Two independent faults are present: find both." : "") + (d.kind === "code" ? ` Language: ${d.lang === "py" ? "Python" : "JavaScript"}.` : "") }),
          el("div", { class: "row" }, [el("button", { class: "btn", id: "pt-go", text: "Start", onclick: () => launch(d) }), d.mode === "review" ? null : el("button", { class: "btn", id: "pt-other", text: "Another one", onclick: () => { skipped.push(d.skill); offer = P.next(st, now(), rnd, skipped); render(); } })])]));
      } else host.appendChild(el("p", { class: "note", text: "Every skill is at Expert. Keep the edge with free practice below." }));
      if (st.active) host.appendChild(el("p", { class: "small", id: "pt-active", text: `Drill in progress: ${P.byId(st.active.skill).name}, level ${st.active.level}. Finish it below, or start another.` }));
      const rows = el("div", { class: "pt-skills" });
      for (const s of rd.skills) {
        const lk = s.locked.length ? "Unlocks at " + s.locked.map((l) => `${P.byId(l.skill).name} ${P.LEVELS[l.level - 1]}`).join(" and ") : "";
        const row = el("div", { class: "pt-row" }, [el("div", { class: "pt-name", text: s.name }), el("div", { class: "small", text: lk ? lk : s.level >= P.MAXL ? "Expert" : `Level ${s.level} of 5: ${s.label}` }), el("div", { class: "tr-bar" }, [el("i", { style: `width:${lk ? 0 : s.pct}%` })])]);
        if (!lk && s.level < P.MAXL) row.appendChild(el("button", { class: "btn pt-check", id: "pt-check-" + s.id, text: "Level check", "aria-label": `Level check for ${s.name}`, onclick: () => { const c = P.levelCheck(st, s.id, rnd); if (c) { offer = c; render(); } } }));
        rows.appendChild(row);
      }
      host.appendChild(rows);
      const due = P.reviewDue(st, now()).length;
      host.appendChild(el("p", { class: "small", text: `${Object.keys(st.srs).length} drill${Object.keys(st.srs).length === 1 ? "" : "s"} waiting for review${due ? `, ${due} due now` : ""}. Vendors met so far: ${Object.keys(st.vend).length ? Object.entries(st.vend).map(([k, v]) => `${Labs.NAMES[k] || k} ${v}`).join(", ") : "none yet"}.` }));
      if (st.badges.length) host.appendChild(el("div", { class: "small", id: "pt-badges", text: "Badges: " + st.badges.map((b) => P.BADGES.find((q) => q.id === b).label).join(" · ") }));
      host.appendChild(el("div", { class: "row" }, [el("button", { class: "btn", id: "pt-reset", text: "Start the path again", onclick: () => { if (!root.confirm("Erase your path progress (levels, reviews, XP)? Lab history stays.")) return; st = P.newState(); msg = ""; offer = null; save(); render(); } })]));
    }
    render(); return { onResult, state: () => st, render };
  }
  const api = { mount }; root.Pathui = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
