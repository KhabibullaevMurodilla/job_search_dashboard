/* Linuxsh: a small Linux shell over a JSON-serialisable machine ("box"): files with owners and modes,
   users, sudo, quoting, pipes, redirects and the everyday commands. Services (systemd, nginx, ssh, firewall,
   curl, ssh client) are added by linuxsvc.js through Sh.cmds. */
(function (root) {
  "use strict";
  const cmds = {};
  const BASE = new Date(Date.UTC(2026, 10, 24, 9, 0, 0));

  // ---------------------------------------------------------------- box and files
  function newBox(o) {
    const home = "/home/" + (o.user || "admin");
    const b = { name: o.name || "web1", ip: o.ip || "10.0.0.5", client: !!o.client, user: o.user || "admin", cwd: home, fs: {}, users: {}, units: {}, procs: [], fw: { enabled: true, rules: [] }, journal: {}, disk: { size: 20000, base: 6000, full: false }, nextPid: 1200, env: {} };
    b.users.root = { uid: 0, groups: ["root"], home: "/root", sudo: true, locked: false };
    b.users[b.user] = { uid: 1000, groups: [b.user, "sudo", "adm"], home, sudo: true, locked: false };
    for (const d of ["/", "/etc", "/home", "/root", "/var", "/var/log", "/var/www", "/usr", "/usr/sbin", "/usr/bin", "/opt", "/run", "/tmp", "/lib", "/lib/systemd", "/lib/systemd/system", "/etc/systemd", "/etc/systemd/system", home]) b.fs[d] = { t: "d", mode: 0o755, owner: d === home ? b.user : "root", group: d === home ? b.user : "root" };
    b.fs["/tmp"].mode = 0o1777; b.fs["/root"].mode = 0o700;
    return b;
  }
  const dirname = (p) => (p === "/" ? "/" : p.replace(/\/[^/]*$/, "") || "/");
  const base = (p) => p.replace(/^.*\//, "");
  function norm(b, p) {
    if (p === "~" || p.startsWith("~/")) p = (b.users[b.user].home || "/") + p.slice(1);
    if (p[0] !== "/") p = b.cwd + "/" + p;
    const out = []; for (const s of p.split("/")) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }
    return "/" + out.join("/");
  }
  const node = (b, p) => b.fs[p] || null;
  function addFile(b, p, data, o) { o = o || {}; const par = dirname(p); mkdirs(b, par, o); b.fs[p] = { t: "f", mode: o.mode === undefined ? 0o644 : o.mode, owner: o.owner || "root", group: o.group || o.owner || "root", data: data === undefined ? "" : data, mb: o.mb || 0 }; return b.fs[p]; }
  function mkdirs(b, p, o) { if (b.fs[p]) return; mkdirs(b, dirname(p), o); b.fs[p] = { t: "d", mode: (o && o.dmode) || 0o755, owner: (o && o.downer) || "root", group: (o && o.dgroup) || (o && o.downer) || "root" }; }
  const children = (b, p) => Object.keys(b.fs).filter((k) => k !== p && dirname(k) === p).sort();
  const groupsOf = (b, u) => (b.users[u] ? b.users[u].groups.concat([u]) : [u]);
  // who: {user, root}
  function can(b, who, n, bit) {
    if (!n) return false; if (who.root) return bit !== "x" || n.t === "d" || (n.mode & 0o111) > 0;
    const m = n.mode, sh = who.user === n.owner ? 6 : groupsOf(b, who.user).indexOf(n.group) >= 0 ? 3 : 0, mask = bit === "r" ? 4 : bit === "w" ? 2 : 1;
    return ((m >> sh) & mask) !== 0;
  }
  // can the user reach (traverse) the path's directories and then do `bit` on the final node?
  function access(b, who, p, bit) {
    const parts = p.split("/").filter(Boolean); let cur = "";
    for (let i = 0; i < parts.length - 1; i++) { cur += "/" + parts[i]; const n = node(b, cur); if (!n) return { ok: false, err: "No such file or directory" }; if (!can(b, who, n, "x")) return { ok: false, err: "Permission denied" }; }
    const n = node(b, p); if (!n) return { ok: false, err: "No such file or directory" };
    if (bit && !can(b, who, n, bit)) return { ok: false, err: "Permission denied" };
    return { ok: true, node: n };
  }
  const modeStr = (n) => { const m = n.mode; let s = n.t === "d" ? "d" : "-"; for (let i = 2; i >= 0; i--) { const x = (m >> (i * 3)) & 7; s += (x & 4 ? "r" : "-") + (x & 2 ? "w" : "-") + (x & 1 ? "x" : "-"); } if (m & 0o1000) s = s.slice(0, -1) + (s.slice(-1) === "x" ? "t" : "T"); return s; };
  const sizeOf = (n) => (n.t === "d" ? 4096 : Math.max((n.data || "").length, (n.mb || 0) * 1048576));
  function diskUsed(b) { return b.disk.base + Object.values(b.fs).reduce((a, n) => a + (n.mb || 0), 0); }
  const diskFull = (b) => b.disk.full || diskUsed(b) >= b.disk.size;
  const stamp = (b) => { const d = new Date(BASE.getTime() + (b.tick || 0) * 1000); return d; };
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const ts = (d) => `${mon[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, " ")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
  function log(b, unit, text, ident) { b.tick = (b.tick || 0) + 1; (b.journal[unit] = b.journal[unit] || []).push(`${ts(stamp(b))} ${b.name} ${ident || unit}[${b.nextPid}]: ${text}`); if (b.journal[unit].length > 80) b.journal[unit].shift(); }
  function logSys(b, unit, text) { b.tick = (b.tick || 0) + 1; (b.journal[unit] = b.journal[unit] || []).push(`${ts(stamp(b))} ${b.name} systemd[1]: ${text}`); }

  // ---------------------------------------------------------------- tokenising
  function tokenize(line) {
    const toks = []; let cur = "", has = false, q = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === q) q = null; else if (c === "\\" && q === '"' && i + 1 < line.length && '"\\$'.indexOf(line[i + 1]) >= 0) cur += line[++i]; else cur += c; continue; }
      if (c === "'" || c === '"') { q = c; has = true; continue; }
      if (c === "\\" && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
      if (/\s/.test(c)) { if (has || cur) { toks.push({ s: cur }); cur = ""; has = false; } continue; }
      if (c === "|" || c === ";" || c === "&" || c === ">" || c === "<") {
        if (has || cur) { toks.push({ s: cur }); cur = ""; has = false; }
        let op = c; if ((c === "|" || c === "&" || c === ">") && line[i + 1] === c) { op = c + c; i++; }
        toks.push({ op }); continue;
      }
      cur += c; has = true;
    }
    if (q) return { err: "unexpected EOF while looking for matching `" + q + "'" };
    if (has || cur) toks.push({ s: cur });
    return { toks };
  }

  // ---------------------------------------------------------------- running
  function runLine(b, line) {
    const t = tokenize(line); if (t.err) return { out: "bash: " + t.err, code: 2 };
    // split into sequences by ; && ||
    const seqs = []; let cur = [], sep = ";";
    for (const k of t.toks) { if (k.op === ";" || k.op === "&&" || k.op === "||") { seqs.push({ sep, toks: cur }); cur = []; sep = k.op; } else cur.push(k); }
    seqs.push({ sep, toks: cur });
    let out = "", code = 0;
    for (const s of seqs) {
      if (!s.toks.length) continue;
      if (s.sep === "&&" && code !== 0) continue; if (s.sep === "||" && code === 0) continue;
      const r = runPipe(b, s.toks); if (r.out) out += (out && !out.endsWith("\n") ? "\n" : "") + r.out; code = r.code;
    }
    return { out: out.replace(/\n$/, ""), code };
  }
  function runPipe(b, toks) {
    const stages = [[]]; for (const k of toks) { if (k.op === "|") stages.push([]); else stages[stages.length - 1].push(k); }
    let input = null, last = { out: "", code: 0 };
    for (let i = 0; i < stages.length; i++) {
      let args = [], redir = null;
      for (let j = 0; j < stages[i].length; j++) { const k = stages[i][j]; if (k.op === ">" || k.op === ">>") { const f = stages[i][j + 1]; if (!f || f.s === undefined) return { out: "bash: syntax error near unexpected token `newline'", code: 2 }; redir = { mode: k.op, file: f.s }; j++; } else if (k.op) return { out: "bash: syntax error near unexpected token `" + k.op + "'", code: 2 }; else args.push(k.s); }
      if (!args.length) return { out: "", code: 0 };
      last = runCmd(b, args, input);
      if (redir) { const r = writeRedirect(b, redir, last.out, currentWho(b, args)); last = { out: r || "", code: r ? 1 : last.code }; }
      input = last.out; if (i < stages.length - 1 && last.code !== 0 && last.out && /^[a-z]/i.test(last.out) === false) { /* keep going like bash */ }
    }
    return last;
  }
  function currentWho(b, args) { return b._who || { user: b.user, root: false }; }
  function writeRedirect(b, redir, text, who) {
    const p = norm(b, redir.file), ex = node(b, p);
    if (ex && ex.t === "d") return `bash: ${redir.file}: Is a directory`;
    if (p === "/dev/null") return "";
    if (!ex) { const par = access(b, who, dirname(p), "w"); if (!par.ok) return `bash: ${redir.file}: ${par.err}`; }
    else { const a = access(b, who, p, "w"); if (!a.ok) return `bash: ${redir.file}: ${a.err}`; }
    if (diskFull(b) && p.indexOf("/var/log") !== 0 && p.indexOf("/tmp") !== 0 && p.indexOf("/home") !== 0) { /* writes of small config files still work in the lab */ }
    const data = text.length && !text.endsWith("\n") ? text + "\n" : text;
    if (!ex) addFile(b, p, redir.mode === ">>" ? data : data, { owner: who.root ? "root" : who.user, group: who.root ? "root" : who.user, mode: 0o644 }); else ex.data = redir.mode === ">>" ? (ex.data || "") + data : data;
    return "";
  }
  function runCmd(b, args, input) {
    let who = { user: b.user, root: false }, a = args.slice();
    if (a[0] === "sudo") {
      a.shift(); let asUser = null; while (a[0] && a[0][0] === "-") { if (a[0] === "-u" && a[1]) { asUser = a[1]; a.splice(0, 2); } else if (a[0] === "-n" || a[0] === "-E" || a[0] === "-H") a.shift(); else if (a[0] === "-i" || a[0] === "-s") { a.shift(); } else break; }
      if (!a.length) return { out: "usage: sudo -h | -K | -k | -V", code: 1 };
      const u = b.users[b.user]; if (!u || !u.sudo) return { out: `${b.user} is not in the sudoers file.  This incident will be reported.`, code: 1 };
      if (asUser) { if (!b.users[asUser]) return { out: `sudo: unknown user ${asUser}`, code: 1 }; who = { user: asUser, root: asUser === "root" }; } else who = { user: "root", root: true };
    }
    a = a.map((x, i) => (i > 0 && /[*?]/.test(x) && x[0] !== "-" ? globExpand(b, x) : [x])).reduce((acc, x) => acc.concat(x), []);
    const name = a[0], f = cmds[name];
    if (!f) { if (/^\.?\//.test(name)) { const p = norm(b, name), n = node(b, p); if (!n) return { out: `bash: ${name}: No such file or directory`, code: 127 }; return { out: `bash: ${name}: Permission denied`, code: 126 }; } return { out: `${name}: command not found`, code: 127 }; }
    if (b.client && !f.client) return { out: `${name}: command not found`, code: 127 };
    b._who = who;
    try { const r = f.run(b, a.slice(1), { who, input, sudo: who.root }); return { out: r.out === undefined ? "" : r.out, code: r.code || 0 }; } finally { b._who = null; }
  }
  function globExpand(b, pat) {
    const abs = norm(b, pat.replace(/\/$/, "")); if (!/[*?]/.test(abs)) return [pat];
    const re = new RegExp("^" + abs.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$");
    const hit = Object.keys(b.fs).filter((k) => re.test(k) && (base(k)[0] !== "." || base(abs)[0] === ".")).sort();
    return hit.length ? hit.map((h) => (pat[0] === "/" || pat[0] === "~" ? h : h.replace(b.cwd + "/", ""))) : [pat];
  }
  const def = (name, run, o) => { cmds[name] = Object.assign({ run, client: false }, o || {}); };
  const usage = (c, m) => ({ out: m, code: c });
  const isFlag = (s) => s.length > 1 && s[0] === "-";
  const stripFlags = (args) => ({ flags: args.filter(isFlag).join(""), rest: args.filter((x) => !isFlag(x)) });
  function readFile(b, who, arg, name) { const p = norm(b, arg), r = access(b, who, p, "r"); if (!r.ok) return { err: `${name}: ${arg}: ${r.err}` }; if (r.node.t === "d") return { err: `${name}: ${arg}: Is a directory` }; return { data: r.node.data || "" }; }

  // ---------------------------------------------------------------- basic commands
  def("pwd", (b) => ({ out: b.cwd }), { client: true });
  def("whoami", (b, a, c) => ({ out: c.who.user }), { client: true });
  def("hostname", (b) => ({ out: b.name }), { client: true });
  def("id", (b, a, c) => { const u = a[0] || c.who.user, r = b.users[u]; if (!r) return { out: `id: '${u}': no such user`, code: 1 }; const g = [u].concat(r.groups.filter((x) => x !== u)); return { out: `uid=${r.uid}(${u}) gid=${r.uid}(${u}) groups=${g.map((x, i) => (i === 0 ? r.uid : 100 + i) + "(" + x + ")").join(",")}` }; }, { client: true });
  def("date", (b) => ({ out: ts(stamp(b)) + " UTC 2026" }), { client: true });
  def("uname", (b, a) => ({ out: a.length ? `Linux ${b.name} 5.15.0-91-generic #101-Ubuntu SMP x86_64 GNU/Linux` : "Linux" }), { client: true });
  def("clear", () => ({ out: "" }), { client: true });
  def("cd", (b, a, c) => { const p = norm(b, a[0] || "~"), r = access(b, c.who, p, "x"); if (!r.ok) return { out: `bash: cd: ${a[0]}: ${r.err}`, code: 1 }; if (r.node.t !== "d") return { out: `bash: cd: ${a[0]}: Not a directory`, code: 1 }; b.cwd = p; return { out: "" }; }, { client: true });
  def("echo", (b, a) => { let nl = true, esc = false; while (a[0] === "-n" || a[0] === "-e") { if (a[0] === "-n") nl = false; else esc = true; a = a.slice(1); } let s = a.join(" "); if (esc) s = s.replace(/\\n/g, "\n").replace(/\\t/g, "\t"); return { out: s + (nl ? "" : "") }; }, { client: true });
  def("printf", (b, a) => { let f = (a[0] || "").replace(/\\n/g, "\n").replace(/\\t/g, "\t"), i = 1; f = f.replace(/%s/g, () => (a[i++] || "")); return { out: f.replace(/\n$/, "") }; });
  def("ls", (b, a, c) => {
    const { flags, rest } = stripFlags(a), long = /l/.test(flags), all = /a/.test(flags), human = /h/.test(flags), bySize = /S/.test(flags), targets = rest.length ? rest : ["."], out = [];
    for (const t of targets) {
      const p = norm(b, t), r = access(b, c.who, p, null); if (!r.ok) { out.push(`ls: cannot access '${t}': ${r.err}`); continue; }
      let names; let showHead = targets.length > 1;
      if (r.node.t === "d") { const d = access(b, c.who, p, "r"); if (!d.ok) { out.push(`ls: cannot open directory '${t}': ${d.err}`); continue; } names = children(b, p); if (showHead) out.push(t + ":"); } else names = [p];
      const one = r.node.t !== "d"; const list = (all && !one ? [".", ".."] : []).concat(names.map((x) => (one ? x : x))).filter((x) => all || one || base(x)[0] !== ".");
      if (bySize) list.sort((x, y) => sizeOf(node(b, y) || { t: 'f', data: '' }) - sizeOf(node(b, x) || { t: 'f', data: '' }));
      const hs = (n) => { const z = sizeOf(n); return !human ? String(z) : z >= 1073741824 ? (z / 1073741824).toFixed(1).replace(/\.0$/, '') + 'G' : z >= 1048576 ? Math.round(z / 1048576) + 'M' : z >= 1024 ? (z / 1024).toFixed(1).replace(/\.0$/, '') + 'K' : String(z); };
      if (long) for (const x of list) { const n = x === "." || x === ".." ? node(b, p) : node(b, x); const nm = x === "." || x === ".." ? x : one ? t : base(x); out.push(`${modeStr(n)} 1 ${n.owner.padEnd(8)} ${n.group.padEnd(8)} ${hs(n).padStart(8)} Nov 24 09:00 ${nm}`); }
      else if (list.length) out.push(list.map((x) => (x === "." || x === ".." ? x : one ? t : base(x))).join("  "));
    }
    return { out: out.join("\n") };
  });
  def("cat", (b, a, c) => { if (!a.length) return { out: c.input || "" }; const o = []; let code = 0; for (const x of a) { const r = readFile(b, c.who, x, "cat"); if (r.err) { o.push(r.err); code = 1; } else o.push(r.data.replace(/\n$/, "")); } return { out: o.join("\n"), code }; }, { client: true });
  const lines = (s) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));
  function numArg(a) { let n = 10; const rest = []; for (let i = 0; i < a.length; i++) { if (a[i] === "-n" && a[i + 1]) { n = parseInt(a[++i], 10); } else if (/^-\d+$/.test(a[i])) n = -parseInt(a[i], 10); else if (/^-n\d+$/.test(a[i])) n = parseInt(a[i].slice(2), 10); else if (a[i] === "-f" || a[i] === "--no-pager") { /* ignore */ } else rest.push(a[i]); } return { n, rest }; }
  def("head", (b, a, c) => { const { n, rest } = numArg(a); let data = c.input; if (rest.length) { const r = readFile(b, c.who, rest[0], "head"); if (r.err) return { out: r.err, code: 1 }; data = r.data; } return { out: lines(data || "").slice(0, n).join("\n") }; });
  def("tail", (b, a, c) => { const { n, rest } = numArg(a); let data = c.input; if (rest.length) { const r = readFile(b, c.who, rest[0], "tail"); if (r.err) return { out: r.err, code: 1 }; data = r.data; } const l = lines(data || ""); return { out: l.slice(Math.max(0, l.length - n)).join("\n") }; });
  def("wc", (b, a, c) => { const { flags, rest } = stripFlags(a); let data = c.input || ""; if (rest.length) { const r = readFile(b, c.who, rest[0], "wc"); if (r.err) return { out: r.err, code: 1 }; data = r.data; } const n = lines(data).length; return { out: /l/.test(flags) ? String(n) : `${n} ${data.split(/\s+/).filter(Boolean).length} ${data.length}` }; });
  def("sort", (b, a, c) => ({ out: lines(c.input || "").sort().join("\n") }));
  def("uniq", (b, a, c) => ({ out: lines(c.input || "").filter((x, i, l) => i === 0 || x !== l[i - 1]).join("\n") }));
  def("cut", (b, a, c) => { let d = "\t", f = 1; for (let i = 0; i < a.length; i++) { if (a[i] === "-d") d = a[++i]; else if (a[i].startsWith("-d")) d = a[i].slice(2); else if (a[i] === "-f") f = parseInt(a[++i], 10); else if (a[i].startsWith("-f")) f = parseInt(a[i].slice(2), 10); } return { out: lines(c.input || "").map((l) => l.split(d)[f - 1] || "").join("\n") }; });
  def("grep", (b, a, c) => {
    let ic = false, num = false, inv = false, cnt = false, rec = false; const rest = [];
    for (const x of a) { if (isFlag(x) && !/^-e$/.test(x)) { if (/i/.test(x)) ic = true; if (/n/.test(x)) num = true; if (/v/.test(x)) inv = true; if (/c/.test(x)) cnt = true; if (/[rR]/.test(x)) rec = true; } else rest.push(x); }
    if (!rest.length) return { out: "Usage: grep [OPTION]... PATTERNS [FILE]...", code: 2 };
    let re; try { re = new RegExp(rest[0], ic ? "i" : ""); } catch (e) { return { out: "grep: Invalid regular expression", code: 2 }; }
    const files = rest.slice(1), out = []; let any = false;
    const scan = (txt, label) => { let n = 0; lines(txt).forEach((l, i) => { if (re.test(l) !== inv) { n++; any = true; if (!cnt) out.push((label ? label + ":" : "") + (num ? i + 1 + ":" : "") + l); } }); if (cnt) out.push((label ? label + ":" : "") + n); };
    if (!files.length) scan(c.input || "", "");
    else for (const f of files) { const p = norm(b, f), r = access(b, c.who, p, null); if (!r.ok) { out.push(`grep: ${f}: ${r.err}`); continue; }
      if (r.node.t === "d") { if (!rec) { out.push(`grep: ${f}: Is a directory`); continue; } const walk = (d) => { for (const ch of children(b, d)) { const n = node(b, ch); if (n.t === "d") walk(ch); else if (can(b, c.who, n, "r")) scan(n.data || "", ch); } }; walk(p); }
      else { const rr = access(b, c.who, p, "r"); if (!rr.ok) out.push(`grep: ${f}: ${rr.err}`); else scan(r.node.data || "", files.length > 1 || rec ? f : ""); } }
    return { out: out.join("\n"), code: any || cnt ? 0 : 1 };
  });
  def("tee", (b, a, c) => { const app = a.indexOf("-a") >= 0, fs = a.filter((x) => !isFlag(x)); let err = ""; for (const f of fs) { const e = writeRedirect(b, { mode: app ? ">>" : ">", file: f }, c.input || "", c.who); if (e) err += e + "\n"; } return { out: (c.input || "").replace(/\n$/, "") + (err ? "\n" + err.trim() : "") , code: err ? 1 : 0 }; });
  def("touch", (b, a, c) => { const o = []; for (const f of a.filter((x) => !isFlag(x))) { const p = norm(b, f); if (!node(b, p)) { const par = access(b, c.who, dirname(p), "w"); if (!par.ok) { o.push(`touch: cannot touch '${f}': ${par.err}`); continue; } addFile(b, p, "", { owner: c.who.user, group: c.who.user }); } } return { out: o.join("\n"), code: o.length ? 1 : 0 }; });
  def("mkdir", (b, a, c) => { const pf = a.indexOf("-p") >= 0, o = []; for (const f of a.filter((x) => !isFlag(x))) { const p = norm(b, f); if (node(b, p)) { if (!pf) o.push(`mkdir: cannot create directory '${f}': File exists`); continue; } if (!node(b, dirname(p)) && !pf) { o.push(`mkdir: cannot create directory '${f}': No such file or directory`); continue; } const par = access(b, c.who, node(b, dirname(p)) ? dirname(p) : "/", "w"); if (!par.ok && node(b, dirname(p))) { o.push(`mkdir: cannot create directory '${f}': ${par.err}`); continue; } mkdirs(b, p, { downer: c.who.user }); } return { out: o.join("\n"), code: o.length ? 1 : 0 }; });
  def("rm", (b, a, c) => { const { flags, rest } = stripFlags(a), rec = /[rR]/.test(flags), force = /f/.test(flags), o = []; for (const f of rest) { const p = norm(b, f), n = node(b, p); if (!n) { if (!force) o.push(`rm: cannot remove '${f}': No such file or directory`); continue; } const par = access(b, c.who, dirname(p), "w"); if (!par.ok) { o.push(`rm: cannot remove '${f}': ${par.err}`); continue; } if (n.t === "d" && !rec) { o.push(`rm: cannot remove '${f}': Is a directory`); continue; } for (const k of Object.keys(b.fs)) if (k === p || k.startsWith(p + "/")) delete b.fs[k]; } return { out: o.join("\n"), code: o.length ? 1 : 0 }; });
  def("truncate", (b, a, c) => { const f = a.filter((x) => !isFlag(x) && !/^\d+$/.test(x))[0]; if (!f) return usage(1, "truncate: missing file operand"); const p = norm(b, f), r = access(b, c.who, p, "w"); if (!r.ok) return { out: `truncate: cannot open '${f}' for writing: ${r.err}`, code: 1 }; r.node.data = ""; r.node.mb = 0; return { out: "" }; });
  def("cp", (b, a, c) => { const rest = a.filter((x) => !isFlag(x)); if (rest.length < 2) return usage(1, "cp: missing destination file operand"); const s = norm(b, rest[0]), r = readFile(b, c.who, rest[0], "cp"); if (r.err) return { out: r.err, code: 1 }; let d = norm(b, rest[1]); if (node(b, d) && node(b, d).t === "d") d += "/" + base(s); const par = access(b, c.who, dirname(d), "w"); if (!par.ok) return { out: `cp: cannot create regular file '${rest[1]}': ${par.err}`, code: 1 }; addFile(b, d, r.data, { owner: c.who.user, group: c.who.user, mode: node(b, s).mode }); return { out: "" }; });
  def("mv", (b, a, c) => { const rest = a.filter((x) => !isFlag(x)); if (rest.length < 2) return usage(1, "mv: missing destination file operand"); const s = norm(b, rest[0]), n = node(b, s); if (!n) return { out: `mv: cannot stat '${rest[0]}': No such file or directory`, code: 1 }; let d = norm(b, rest[1]); if (node(b, d) && node(b, d).t === "d") d += "/" + base(s); const p1 = access(b, c.who, dirname(s), "w"), p2 = access(b, c.who, dirname(d), "w"); if (!p1.ok || !p2.ok) return { out: `mv: cannot move '${rest[0]}' to '${rest[1]}': Permission denied`, code: 1 }; for (const k of Object.keys(b.fs)) if (k === s || k.startsWith(s + "/")) { b.fs[d + k.slice(s.length)] = b.fs[k]; delete b.fs[k]; } return { out: "" }; });
  def("chmod", (b, a, c) => {
    const { flags, rest } = stripFlags(a), rec = /R/.test(flags); if (rest.length < 2) return usage(1, "chmod: missing operand"); const mode = rest[0], o = [];
    const apply = (n) => { if (/^[0-7]{3,4}$/.test(mode)) { n.mode = parseInt(mode, 8); return true; } const m = /^([ugoa]*)([+\-=])([rwxXst]*)$/.exec(mode); if (!m) return false; const who = m[1] || "a", bits = (m[3].indexOf("r") >= 0 ? 4 : 0) | (m[3].indexOf("w") >= 0 ? 2 : 0) | (m[3].indexOf("x") >= 0 || (m[3].indexOf("X") >= 0 && n.t === "d") ? 1 : 0); let mask = 0; if (/u|a/.test(who)) mask |= bits << 6; if (/g|a/.test(who)) mask |= bits << 3; if (/o|a/.test(who)) mask |= bits; if (m[2] === "+") n.mode |= mask; else if (m[2] === "-") n.mode &= ~mask; else { let clr = 0; if (/u|a/.test(who)) clr |= 7 << 6; if (/g|a/.test(who)) clr |= 7 << 3; if (/o|a/.test(who)) clr |= 7; n.mode = (n.mode & ~clr) | mask; } return true; };
    if (!/^[0-7]{3,4}$/.test(mode) && !/^([ugoa]*)([+\-=])([rwxXst]*)$/.test(mode)) return { out: `chmod: invalid mode: '${mode}'`, code: 1 };
    for (const f of rest.slice(1)) { const p = norm(b, f), n = node(b, p); if (!n) { o.push(`chmod: cannot access '${f}': No such file or directory`); continue; } if (!c.who.root && c.who.user !== n.owner) { o.push(`chmod: changing permissions of '${f}': Operation not permitted`); continue; } apply(n); if (rec && n.t === "d") for (const k of Object.keys(b.fs)) if (k.startsWith(p + "/")) apply(b.fs[k]); }
    return { out: o.join("\n"), code: o.length ? 1 : 0 };
  }, { client: true });
  def("chown", (b, a, c) => { const { flags, rest } = stripFlags(a), rec = /R/.test(flags); if (rest.length < 2) return usage(1, "chown: missing operand"); const [u, g] = rest[0].split(":"); if (u && !b.users[u]) return { out: `chown: invalid user: '${rest[0]}'`, code: 1 }; if (!c.who.root) return { out: `chown: changing ownership of '${rest[1]}': Operation not permitted`, code: 1 }; const o = []; for (const f of rest.slice(1)) { const p = norm(b, f), n = node(b, p); if (!n) { o.push(`chown: cannot access '${f}': No such file or directory`); continue; } const set = (x) => { if (u) x.owner = u; if (g) x.group = g; else if (u && rest[0].indexOf(":") >= 0) x.group = u; }; set(n); if (rec && n.t === "d") for (const k of Object.keys(b.fs)) if (k.startsWith(p + "/")) set(b.fs[k]); } return { out: o.join("\n"), code: o.length ? 1 : 0 }; });
  def("stat", (b, a, c) => { const f = a.filter((x) => !isFlag(x))[0]; if (!f) return usage(1, "stat: missing operand"); const p = norm(b, f), r = access(b, c.who, p, null); if (!r.ok) return { out: `stat: cannot statx '${f}': ${r.err}`, code: 1 }; const n = r.node; return { out: `  File: ${f}\n  Size: ${sizeOf(n)}\nAccess: (${(n.mode & 0o7777).toString(8).padStart(4, "0")}/${modeStr(n)})  Uid: ( ${(b.users[n.owner] || {}).uid || 0}/${n.owner})   Gid: ( 0/${n.group})` }; });
  def("namei", (b, a, c) => { const f = a.filter((x) => !isFlag(x))[0]; if (!f) return usage(1, "namei: missing operand"); const p = norm(b, f), parts = p.split("/").filter(Boolean), out = ["f: " + p]; let cur = ""; out.push(` ${modeStr(node(b, "/"))} root root /`); for (const s of parts) { cur += "/" + s; const n = node(b, cur); if (!n) { out.push(`     ${s} - No such file or directory`); break; } out.push(` ${modeStr(n)} ${n.owner} ${n.group} ${s}`); } return { out: out.join("\n") }; });
  def("sed", (b, a, c) => {
    let inplace = false, expr = null, quiet = false; const files = [];
    for (let i = 0; i < a.length; i++) { const x = a[i]; if (x === "-i" || x.startsWith("-i")) inplace = true; else if (x === "-n") quiet = true; else if (x === "-e") expr = a[++i]; else if (x === "-E" || x === "-r") { /* same */ } else if (expr === null) expr = x; else files.push(x); }
    if (expr === null) return usage(1, "Usage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...");
    const transform = (txt) => {
      const m = /^s(.)(.*?)(?<!\\)\1(.*?)(?<!\\)\1([gI]*)$/.exec(expr);
      if (m) { const sep = m[1], un = (s) => s.split("\\" + sep).join(sep); let re; try { re = new RegExp(un(m[2]), m[4].indexOf("g") >= 0 ? "g" : ""); } catch (e) { return null; } return lines(txt).map((l) => l.replace(re, un(m[3]).replace(/\\n/g, "\n"))).join("\n") + (txt.endsWith("\n") || txt === "" ? "\n" : ""); }
      const d = /^(?:(\d+)|\/(.*)\/)d$/.exec(expr); if (d) { let re = d[2] ? new RegExp(d[2]) : null; return lines(txt).filter((l, i) => (d[1] ? i + 1 !== parseInt(d[1], 10) : !re.test(l))).join("\n") + "\n"; }
      const pr = /^(\d+)p$/.exec(expr); if (pr && quiet) return (lines(txt)[parseInt(pr[1], 10) - 1] || "") + "\n";
      return null;
    };
    if (!files.length) { const r = transform(c.input || ""); if (r === null) return { out: `sed: -e expression #1, char ${expr.length}: unknown command`, code: 1 }; return { out: r.replace(/\n$/, "") }; }
    const o = [];
    for (const f of files) { const p = norm(b, f), rd = access(b, c.who, p, "r"); if (!rd.ok) { o.push(`sed: can't read ${f}: ${rd.err === "Permission denied" ? "Permission denied" : "No such file or directory"}`); continue; }
      const r = transform(rd.node.data || ""); if (r === null) return { out: `sed: -e expression #1, char ${expr.length}: unknown command`, code: 1 };
      if (inplace) { const w = access(b, c.who, dirname(p), "w"); if (!w.ok) { o.push(`sed: couldn't open temporary file ${dirname(f)}/sedXXXX: Permission denied`); continue; } rd.node.data = r; } else o.push(r.replace(/\n$/, "")); }
    return { out: o.join("\n"), code: 0 };
  });
  def("nano", () => ({ out: "No interactive editor in this lab. Change files with sed -i, or write them with tee (for example: echo 'line' | sudo tee -a /etc/file).", code: 1 }));
  cmds.vi = cmds.nano; cmds.vim = cmds.nano;
  def("which", (b, a) => { const known = Object.keys(cmds); return { out: a.filter((x) => known.indexOf(x) >= 0).map((x) => "/usr/bin/" + x).join("\n"), code: a.every((x) => known.indexOf(x) >= 0) ? 0 : 1 }; });
  def("df", (b, a) => { const h = a.join(" ").indexOf("h") >= 0, used = diskUsed(b), size = b.disk.size, full = diskFull(b), u = full ? size : used, fmt = (m) => (h ? (m >= 1024 ? (m / 1024).toFixed(1).replace(/\.0$/, "") + "G" : m + "M") : String(m * 1024)); return { out: `Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1       ${fmt(size).padStart(4)}  ${fmt(u).padStart(4)} ${fmt(size - u).padStart(5)} ${String(Math.min(100, Math.round((100 * u) / size))).padStart(3)}% /\ntmpfs           ${h ? "1.0G" : "1048576"}     0  ${h ? "1.0G" : "1048576"}   0% /dev/shm` }; });
  def("du", (b, a, c) => {
    const { flags, rest } = stripFlags(a), depth = a.some((x) => /--max-depth=1|^-d1$/.test(x)), sum = /s/.test(flags) || !depth, sz = (x) => (x >= 1024 ? (x / 1024).toFixed(1).replace(/\.0$/, "") + "G" : x >= 1 ? Math.round(x) + "M" : "4.0K"), out = [];
    const tot = (p) => { let mb = 0; for (const k of Object.keys(b.fs)) if (k === p || k.startsWith(p + "/")) mb += b.fs[k].mb || 0; return mb; };
    for (const t of rest.length ? rest : ["."]) { const p = norm(b, t); if (!node(b, p)) { out.push(`du: cannot access '${t}': No such file or directory`); continue; } if (depth && node(b, p).t === "d") for (const ch of children(b, p)) out.push(`${sz(tot(ch))}\t${ch}`); out.push(`${sz(tot(p))}\t${t === "." ? "." : p}`); }
    return { out: out.join("\n") };
  });
  def("free", () => ({ out: "               total        used        free      shared  buff/cache   available\nMem:           1.9Gi       412Mi       1.1Gi       1.0Mi       470Mi       1.4Gi\nSwap:             0B          0B          0B" }));
  def("getent", (b, a) => { if (a[0] === "passwd" && a[1]) { const u = b.users[a[1]]; return u ? { out: `${a[1]}:x:${u.uid}:${u.uid}::${u.home}:/bin/bash` } : { out: "", code: 2 }; } return { out: "", code: 2 }; });
  def("help", () => ({ out: "This lab shell supports: ls cat head tail grep wc sort uniq cut sed tee touch mkdir rm cp mv chmod chown stat namei id whoami cd pwd df du free ps ss curl and the service tools systemctl journalctl nginx ufw iptables ssh. Use sudo for root. Pipes, redirects and quotes work." }), { client: true });
  def("exit", () => ({ out: "", exit: true }), { client: true });

  const Sh = { cmds, def, newBox, runLine, norm, node, addFile, mkdirs, children, access, can, groupsOf, modeStr, dirname, base, log, logSys, ts, stamp, diskFull, diskUsed, lines, readFile, tokenize };
  root.Linuxsh = Sh; if (typeof module !== "undefined" && module.exports) module.exports = Sh;
})(typeof self !== "undefined" ? self : globalThis);
