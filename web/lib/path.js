/* Path: the automatic route from beginner to expert for the hands-on labs and the coding lab.
   Seven skills, each with five working levels and an Expert (mastered) stage. The path watches every lab
   result, moves a skill up or down on evidence, brings failed drills back on a spaced schedule and always
   offers the next drill. Pure logic: no DOM, no storage (the UI keeps the state). */
(function (root) {
  "use strict";
  const Tasks = root.Codetasks || (typeof require !== "undefined" ? require("./codetasks.js") : null);
  const DAY = 86400000;
  const LEVELS = ["Foundation", "Associate", "Professional", "Senior", "Expert track", "Expert"];
  const MAXL = 6;
  // faults per level; "double" levels combine two independent faults, the first one is taken from `from`.
  const SKILLS = [
    { id: "ospf", name: "OSPF", kind: "net", scenario: "ospf", needs: {},
      pool: { 1: { f: ["shut", "passive", "network"] }, 2: { f: ["hello", "area", "mtu"] }, 3: { f: ["auth", "rid"] }, 4: { f: ["shut", "passive", "network", "hello", "area", "mtu"], d: 1 }, 5: { f: ["auth", "rid", "mtu", "area"], d: 1 } } },
    { id: "bgp", name: "eBGP", kind: "net", scenario: "bgp", needs: {},
      pool: { 1: { f: ["remoteas", "noneighbor", "shut"] }, 2: { f: ["network", "password"] }, 3: { f: ["updsrc", "multihop"] }, 4: { f: ["remoteas", "noneighbor", "shut", "network", "password"], d: 1 }, 5: { f: ["updsrc", "multihop", "password"], d: 1 } } },
    { id: "ibgp", name: "iBGP and next-hop", kind: "net", scenario: "ibgp", needs: { bgp: 2, ospf: 2 },
      pool: { 1: { f: ["nhs"] }, 2: { f: ["updsrc"] }, 3: { f: ["ospfloop"] }, 4: { f: ["nhs", "updsrc"], d: 1 }, 5: { f: ["ospfloop", "nhs"], d: 1 } } },
    { id: "vlan", name: "Switching and VLANs", kind: "net", scenario: "vlan", needs: {},
      pool: { 1: { f: ["access", "shut"] }, 2: { f: ["allowed", "novlan"] }, 3: { f: ["access", "shut"], d: 1 }, 4: { f: ["allowed", "novlan"], d: 1 }, 5: { f: ["allowed", "novlan", "access", "shut"], d: 1 } } },
    { id: "static", name: "Static routing and filters", kind: "net", scenario: "static", needs: {},
      pool: { 1: { f: ["fwd", "ret"] }, 2: { f: ["nexthop", "gw"] }, 3: { f: ["acl"] }, 4: { f: ["fwd", "ret", "nexthop", "gw"], d: 1 }, 5: { f: ["acl", "nexthop", "gw"], d: 1 } } },
    { id: "evpn", name: "VXLAN EVPN fabric", kind: "net", scenario: "evpn", needs: { ospf: 3, bgp: 3, ibgp: 2 },
      pool: { 1: { f: ["nve-shut", "src-down", "vtep-underlay"] }, 2: { f: ["vlan-vni-missing", "vni-mismatch", "af-activate"] }, 3: { f: ["extcomm", "rt-mismatch", "no-rr", "member-vni", "feature-evpn"] }, 4: { f: ["nve-shut", "src-down", "vtep-underlay"], d: 1 }, 5: { f: ["extcomm", "rt-mismatch", "no-rr", "vni-mismatch", "af-activate"], d: 1 } } },
    { id: "code", name: "Network automation coding", kind: "code", needs: {},
      pool: { 1: { lv: 1 }, 2: { lv: 2 }, 3: { lv: 2, other: 1 }, 4: { lv: 3 }, 5: { lv: 3, other: 1 } } },
  ];
  const byId = (id) => SKILLS.find((s) => s.id === id);

  function newState() {
    const skills = {}; for (const s of SKILLS) skills[s.id] = { level: 1, hist: [], mark: 0, last: 0 };
    return { v: 1, started: false, skills, srs: {}, active: null, xp: 0, streak: { days: 0, last: "", best: 0 }, badges: [], counts: { passes: 0, doubles: 0, ups: 0, nohint: 0 }, done: {}, vend: {} };
  }
  const clampN = (n, a, b) => Math.max(a, Math.min(b, Number.isFinite(+n) ? Math.floor(+n) : a));
  function normalize(x) {
    const s = newState(); if (!x || typeof x !== "object") return s;
    s.started = x.started === true; s.xp = clampN(x.xp, 0, 1e7);
    for (const k of Object.keys(s.skills)) { const r = x.skills && x.skills[k]; if (!r || typeof r !== "object") continue;
      const hist = (Array.isArray(r.hist) ? r.hist : []).slice(-40).map((h) => (h && typeof h === "object" ? { lv: clampN(h.lv, 1, 5), pass: h.pass === true, hints: clampN(h.hints, 0, 50), at: clampN(h.at, 0, 4e12), id: String(h.id || "").slice(0, 60) } : null)).filter(Boolean);
      s.skills[k] = { level: clampN(r.level, 1, MAXL), hist, mark: clampN(r.mark, 0, hist.length), last: clampN(r.last, 0, 4e12) }; }
    for (const [k, v] of Object.entries(x.srs && typeof x.srs === "object" ? x.srs : {}).slice(0, 300)) if (v && typeof v === "object") s.srs[String(k).slice(0, 80)] = { box: clampN(v.box, 1, 4), due: clampN(v.due, 0, 4e12) };
    const st = x.streak || {}; s.streak = { days: clampN(st.days, 0, 9999), last: /^\d{4}-\d{2}-\d{2}$/.test(String(st.last)) ? st.last : "", best: clampN(st.best, 0, 9999) };
    s.badges = (Array.isArray(x.badges) ? x.badges : []).filter((b) => BADGES.some((q) => q.id === b)).slice(0, 30);
    for (const k of Object.keys(s.counts)) s.counts[k] = clampN(x.counts && x.counts[k], 0, 1e6);
    for (const [k, v] of Object.entries(x.vend && typeof x.vend === "object" ? x.vend : {}).slice(0, 10)) s.vend[String(k).slice(0, 10)] = clampN(v, 0, 1e6);
    const a = x.active; if (a && typeof a === "object" && byId(a.skill)) s.active = { skill: a.skill, level: clampN(a.level, 1, 5), kind: a.kind === "code" ? "code" : "net", scenario: String(a.scenario || "").slice(0, 20), task: String(a.task || "").slice(0, 40), faults: (Array.isArray(a.faults) ? a.faults : []).map((f) => String(f).slice(0, 30)).slice(0, 12), double: a.double === true, check: a.check === true, id: String(a.id || "").slice(0, 80), mode: String(a.mode || "new").slice(0, 10) };
    for (const [k, v] of Object.entries(x.done && typeof x.done === "object" ? x.done : {}).slice(0, 100)) if (v && typeof v === "object") s.done[String(k).slice(0, 40)] = { py: v.py === true, js: v.js === true };
    return s;
  }

  const locked = (state, sk) => Object.entries(sk.needs || {}).filter(([k, lv]) => state.skills[k].level < lv).map(([k, lv]) => ({ skill: k, level: lv }));
  const unlocked = (state, sk) => locked(state, sk).length === 0;
  function setStart(state, who) { const lv = who === "senior" ? 3 : who === "working" ? 2 : 1; for (const s of SKILLS) { const r = state.skills[s.id]; if (r.level < lv && !r.hist.length) r.level = lv; } state.started = true; return state; }

  // which level a free-play result belongs to when it was not started from the path
  function naturalLevel(sk, r) {
    if (sk.kind === "code") { const t = Tasks.byId(r.task); return !t ? 1 : t.level === 1 ? 1 : t.level === 2 ? 2 : 4; }
    const ids = String(r.fault || "").split("+");
    const lvOf = (f) => { for (let L = 1; L <= 3; L++) if (!sk.pool[L].d && sk.pool[L].f.indexOf(f) >= 0) return L; return 1; };
    const m = Math.max.apply(null, ids.map(lvOf));
    return ids.length > 1 ? (m >= 3 ? 5 : 4) : m;
  }
  function skillOf(r) { return SKILLS.find((s) => (r.kind === "code" ? s.kind === "code" : s.scenario === r.scenario)) || null; }
  function matchesActive(a, r) {
    if (!a) return false;
    if (r.kind === "code") return a.kind === "code" && a.task === r.task;
    return a.kind === "net" && a.scenario === r.scenario && (a.double ? String(r.fault).indexOf("+") > 0 : String(r.fault).indexOf("+") < 0);
  }

  // ---- XP, streak, badges
  const pad = (n) => (n < 10 ? "0" : "") + n;
  function dayKey(t) { const d = new Date(t); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function prevDay(t) { const d = new Date(t); d.setDate(d.getDate() - 1); return dayKey(d.getTime()); }
  function touchStreak(state, now) { const t = dayKey(now); if (state.streak.last !== t) { state.streak.days = state.streak.last === prevDay(now) ? state.streak.days + 1 : 1; state.streak.last = t; state.streak.best = Math.max(state.streak.best, state.streak.days); } }
  const streakNow = (state, now) => { const t = dayKey(now === undefined ? Date.now() : now); return state.streak.last === t || state.streak.last === prevDay(now === undefined ? Date.now() : now) ? state.streak.days : 0; };
  const BADGES = [
    { id: "first", label: "First drill solved", test: (s) => s.counts.passes >= 1 },
    { id: "ten", label: "Ten drills solved", test: (s) => s.counts.passes >= 10 },
    { id: "nohint", label: "Five drills without a hint", test: (s) => s.counts.nohint >= 5 },
    { id: "double", label: "First two-fault incident solved", test: (s) => s.counts.doubles >= 1 },
    { id: "up", label: "Moved up a level", test: (s) => s.counts.ups >= 1 },
    { id: "streak3", label: "Three days in a row", test: (s) => s.streak.best >= 3 },
    { id: "streak7", label: "A week in a row", test: (s) => s.streak.best >= 7 },
    { id: "expert1", label: "One skill at Expert", test: (s) => SKILLS.some((k) => s.skills[k.id].level >= MAXL) },
    { id: "expertall", label: "Every skill at Expert", test: (s) => SKILLS.every((k) => s.skills[k.id].level >= MAXL) },
  ];
  const SRS_DAYS = [0, 1, 3, 7, 16];

  // Record one lab result. r: {kind, scenario|task, fault, pass, hints, lang}. Returns {event} describing level changes.
  function record(state, r, now) {
    const t = now === undefined ? Date.now() : now, sk = skillOf(r); if (!sk) return { event: null };
    const rec = state.skills[sk.id], act = matchesActive(state.active, r) && state.active.skill === sk.id ? state.active : null;
    const lv = act ? act.level : naturalLevel(sk, r), hints = clampN(r.hints, 0, 50), pass = r.pass === true;
    const id = act && act.id ? act.id : (r.kind === "code" ? "code:" + r.task : sk.id + ":" + r.fault + ":" + lv);
    rec.hist.push({ lv, pass, hints, at: t, id }); if (rec.hist.length > 40) { rec.hist.shift(); rec.mark = Math.max(0, rec.mark - 1); }
    rec.last = t; touchStreak(state, t);
    let xp = pass ? 10 * lv + (hints === 0 ? 5 : 0) : 2; state.xp += xp;
    if (pass) { state.counts.passes++; if (hints === 0) state.counts.nohint++; if (String(r.fault || "").indexOf("+") > 0) state.counts.doubles++; if (r.kind === "code" && r.lang) { const d = (state.done[r.task] = state.done[r.task] || { py: false, js: false }); d[r.lang] = true; } }
    if (pass && Array.isArray(r.vendors)) Array.from(new Set(r.vendors.map((v) => String(v).slice(0, 10)))).forEach((v) => { state.vend[v] = (state.vend[v] || 0) + 1; });
    // spaced review of drills that went wrong
    if (!pass) state.srs[id] = { box: 1, due: t + SRS_DAYS[1] * DAY };
    else if (state.srs[id]) { const b = state.srs[id].box + 1; if (b > 4) delete state.srs[id]; else state.srs[id] = { box: b, due: t + SRS_DAYS[b] * DAY }; }
    let event = null;
    const before = rec.level;
    if (act && act.check && pass && rec.level === act.level - 1 && rec.level < MAXL) { rec.level = act.level; rec.mark = rec.hist.length; event = { skill: sk.id, from: before, to: rec.level, why: "level check passed" }; }
    else if (rec.level < MAXL) {
      const win = rec.hist.slice(rec.mark).filter((h) => h.lv >= rec.level).slice(-4);
      const ok = win.filter((h) => h.pass), avgHints = ok.length ? ok.reduce((n, h) => n + h.hints, 0) / ok.length : 0;
      if (win.length >= 3 && ok.length >= 3 && avgHints <= 1.5) { rec.level++; rec.mark = rec.hist.length; event = { skill: sk.id, from: before, to: rec.level, why: "three of the last four solved" }; }
      else if (rec.level > 1) { const last3 = rec.hist.slice(rec.mark).filter((h) => h.lv >= rec.level).slice(-3); if (last3.length === 3 && last3.every((h) => !h.pass)) { rec.level--; rec.mark = rec.hist.length; event = { skill: sk.id, from: before, to: rec.level, why: "three misses in a row, so a step back to consolidate" }; } }
    }
    if (event && event.to > event.from) { state.counts.ups++; xp += 25; state.xp += 25; }
    if (act) state.active = null;
    const nb = BADGES.filter((b) => state.badges.indexOf(b.id) < 0 && b.test(state)); nb.forEach((b) => state.badges.push(b.id));
    return { event, xp, badges: nb.map((b) => b.label), skill: sk.id, level: lv };
  }

  // ---- choosing the next drill
  function pickFrom(list, rnd) { return list[Math.floor(rnd() * list.length)]; }
  function drillFor(state, sk, level, rnd, mode, extra) {
    const p = sk.pool[level], rec = state.skills[sk.id];
    if (sk.kind === "code") {
      const all = Tasks.TASKS.filter((t) => t.level === p.lv), dn = (t) => state.done[t.id] || {};
      let cands = all.map((t) => ({ t, lang: p.other ? (dn(t).py && !dn(t).js ? "js" : !dn(t).py && dn(t).js ? "py" : "py") : (dn(t).py && !dn(t).js ? "js" : "py"), score: (dn(t).py ? 1 : 0) + (dn(t).js ? 1 : 0) }));
      if (p.other) { const w = cands.filter((c) => (dn(c.t).py || dn(c.t).js) && !(dn(c.t).py && dn(c.t).js)); if (w.length) cands = w; }
      const min = Math.min.apply(null, cands.map((c) => c.score)); cands = cands.filter((c) => c.score === min);
      const c = pickFrom(cands, rnd);
      return { kind: "code", skill: sk.id, level, mode, task: c.t.id, lang: c.lang, id: "code:" + c.t.id, title: c.t.title, check: !!(extra && extra.check) };
    }
    const done = {}; rec.hist.forEach((h) => { const f = h.id.split(":")[1]; if (f) done[f] = (done[f] || 0) + 1; });
    const min = Math.min.apply(null, p.f.map((f) => done[f] || 0)), faults = p.f.filter((f) => (done[f] || 0) === min), first = pickFrom(faults, rnd);
    return { kind: "net", skill: sk.id, level, mode, scenario: sk.scenario, faults: p.d ? p.f : [first], fault: first, double: !!p.d, id: sk.id + ":" + (p.d ? "double:" : "") + first + ":" + level, title: sk.name + (p.d ? ": two faults at once" : ""), check: !!(extra && extra.check) };
  }
  function reviewDue(state, now) { return Object.entries(state.srs).filter(([, r]) => r.due <= now).sort((a, b) => a[1].due - b[1].due).map(([id]) => id); }
  function fromId(state, id, rnd) {
    const parts = id.split(":");
    if (parts[0] === "code") { const t = Tasks.byId(parts[1]); return t ? { kind: "code", skill: "code", level: 1, mode: "review", task: t.id, lang: state.done[t.id] && state.done[t.id].py && !state.done[t.id].js ? "js" : "py", id, title: t.title } : null; }
    const sk = byId(parts[0]); if (!sk) return null;
    const lv = clampN(parts[parts.length - 1], 1, 5), dbl = parts[1] === "double", f = parts[dbl ? 2 : 1];
    return { kind: "net", skill: sk.id, level: lv, mode: "review", scenario: sk.scenario, faults: [f], fault: f, double: dbl, id, title: sk.name + (dbl ? ": two faults at once" : "") };
  }
  function next(state, now, rnd) {
    const t = now === undefined ? Date.now() : now, r = rnd || Math.random;
    for (const id of reviewDue(state, t)) { const d = fromId(state, id, r); if (d && unlocked(state, byId(d.skill))) return d; }
    const open = SKILLS.filter((s) => unlocked(state, s) && state.skills[s.id].level < MAXL);
    if (!open.length) return null;
    open.sort((a, b) => state.skills[a.id].level - state.skills[b.id].level || state.skills[a.id].last - state.skills[b.id].last);
    const sk = open[0];
    return drillFor(state, sk, state.skills[sk.id].level, r, "new");
  }
  function levelCheck(state, skillId, rnd) { const sk = byId(skillId), rec = state.skills[skillId]; if (!sk || !unlocked(state, sk) || rec.level >= MAXL) return null; return drillFor(state, sk, rec.level + 1, rnd || Math.random, "check", { check: true }); }
  // what to pass to the lab screens, and the state to remember while the drill is open
  function activate(state, d) { state.active = { skill: d.skill, level: d.level, kind: d.kind, scenario: d.scenario || "", task: d.task || "", faults: d.faults || [], double: !!d.double, check: !!d.check, id: d.id, mode: d.mode }; return state.active; }
  function labOptions(d, seed) { return d.kind === "net" ? { fault: d.fault, double: d.double } : null; }
  // prefer the lab whose vendors the learner has practised least
  const vendorScore = (state, vendors) => Array.from(new Set(vendors || [])).reduce((n, v) => n + 1 / (1 + ((state.vend && state.vend[v]) || 0)), 0);
  function readiness(state) { const per = SKILLS.map((s) => ({ id: s.id, name: s.name, level: state.skills[s.id].level, label: LEVELS[Math.min(state.skills[s.id].level, MAXL) - 1], locked: locked(state, s), pct: Math.round(100 * (state.skills[s.id].level - 1) / (MAXL - 1)) })); return { skills: per, pct: Math.round(per.reduce((n, p) => n + p.pct, 0) / per.length), expert: per.every((p) => p.level >= MAXL) }; }

  const api = { SKILLS, LEVELS, MAXL, BADGES, newState, normalize, setStart, record, next, levelCheck, activate, labOptions, readiness, vendorScore, locked, unlocked, reviewDue, streakNow, naturalLevel, byId, dayKey };
  root.Path = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
