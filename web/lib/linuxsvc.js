/* Linuxsvc: services on the Linuxsh machine: systemd units, nginx (real config parser), an app service,
   sshd, a firewall (ufw / iptables), ss/ps, curl and the ssh client between two machines. */
(function (root) {
  "use strict";
  const Sh = root.Linuxsh || (typeof require !== "undefined" ? require("./linuxsh.js") : null);
  const { def, norm, node, access, addFile, log, logSys, lines, diskFull } = Sh;
  const NGX = "nginx/1.18.0 (Ubuntu)";

  // ---------------------------------------------------------------- generic helpers
  function link(server, client) { Object.defineProperty(server, "peer", { value: client, enumerable: false, configurable: true, writable: true }); Object.defineProperty(client, "peer", { value: server, enumerable: false, configurable: true, writable: true }); }
  const procOnPort = (b, port) => b.procs.find((p) => (p.ports || []).indexOf(port) >= 0) || null;
  const unitName = (n) => { n = String(n || "").replace(/\.service$/, ""); return n === "sshd" ? "ssh" : n; };
  function parseIni(text) { const o = {}; let sec = ""; for (const l of lines(text || "")) { const t = l.trim(); if (!t || t[0] === "#" || t[0] === ";") continue; const m = /^\[(.+)\]$/.exec(t); if (m) { sec = m[1]; o[sec] = o[sec] || {}; continue; } const i = t.indexOf("="); if (i > 0 && sec) o[sec][t.slice(0, i).trim()] = t.slice(i + 1).trim(); } return o; }
  function parseEnv(text) { const o = {}; for (const l of lines(text || "")) { const t = l.trim(); if (!t || t[0] === "#") continue; const i = t.indexOf("="); if (i > 0) o[t.slice(0, i).trim()] = t.slice(i + 1).trim().replace(/^["']|["']$/g, ""); } return o; }

  // ---------------------------------------------------------------- nginx config parser
  const KNOWN = new Set(["user", "worker_processes", "pid", "events", "worker_connections", "http", "include", "access_log", "error_log", "server", "listen", "server_name", "root", "index", "location", "try_files", "proxy_pass", "proxy_set_header", "ssl_certificate", "ssl_certificate_key", "ssl_protocols", "return", "default_type", "sendfile", "keepalive_timeout", "client_max_body_size", "error_page", "gzip", "charset", "types_hash_max_size", "upstream", "add_header", "rewrite", "autoindex", "alias", "fastcgi_pass", "proxy_read_timeout", "proxy_connect_timeout"]);
  function lex(text, file) {
    const toks = []; let line = 1;
    for (let i = 0; i < text.length;) {
      const c = text[i];
      if (c === "\n") { line++; i++; continue; } if (/\s/.test(c)) { i++; continue; }
      if (c === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
      if (c === ";" || c === "{" || c === "}") { toks.push({ t: c, line }); i++; continue; }
      let w = "", q = null; const l0 = line;
      while (i < text.length) { const d = text[i]; if (q) { if (d === q) { q = null; i++; continue; } if (d === "\n") line++; w += d; i++; continue; } if (d === '"' || d === "'") { q = d; i++; continue; } if (/\s/.test(d) || d === ";" || d === "{" || d === "}") break; w += d; i++; }
      toks.push({ t: "w", v: w, line: l0 });
    }
    return toks;
  }
  function parseConf(text, file, errs) {
    const toks = lex(text, file); let i = 0;
    const err = (m, ln) => { errs.push(`[emerg] ${m} in ${file}:${ln}`); };
    function block(depth) {
      const out = [];
      for (;;) {
        if (i >= toks.length) { if (depth > 0) { err('unexpected end of file, expecting "}"', toks.length ? toks[toks.length - 1].line : 1); } return out; }
        const t = toks[i];
        if (t.t === "}") { if (depth === 0) { err('unexpected "}"', t.line); i++; return out; } i++; return out; }
        if (t.t === ";" || t.t === "{") { err(`unexpected "${t.t}"`, t.line); i++; return out; }
        const words = []; const start = t.line;
        while (i < toks.length && toks[i].t === "w") { words.push(toks[i].v); i++; }
        if (i >= toks.length) { err('unexpected end of file, expecting ";" or "}"', toks[toks.length - 1].line); return out; }
        const e = toks[i];
        if (e.t === "}") { err('unexpected "}"', e.line); i++; return out; }
        if (e.t === ";") { i++; out.push({ name: words[0], args: words.slice(1), line: start }); continue; }
        i++; const kids = block(depth + 1); out.push({ name: words[0], args: words.slice(1), line: start, kids });
        if (errs.length) return out;
      }
    }
    return block(0);
  }
  function check(d, file, errs) {
    if (!KNOWN.has(d.name)) { errs.push(`[emerg] unknown directive "${d.name}" in ${file}:${d.line}`); return; }
    const one = ["root", "proxy_pass", "ssl_certificate", "ssl_certificate_key", "pid", "user_"]; if (one.indexOf(d.name) >= 0 && d.args.length !== 1) errs.push(`[emerg] invalid number of arguments in "${d.name}" directive in ${file}:${d.line}`);
    if (d.name === "listen" && !d.args.length) errs.push(`[emerg] invalid number of arguments in "listen" directive in ${file}:${d.line}`);
    for (const k of d.kids || []) check(k, file, errs);
  }
  function nginxLoad(b) {
    const errs = [], m = node(b, "/etc/nginx/nginx.conf"); if (!m) return { errors: ["[emerg] open() \"/etc/nginx/nginx.conf\" failed (2: No such file or directory)"], servers: [] };
    const top = parseConf(m.data || "", "/etc/nginx/nginx.conf", errs); top.forEach((d) => check(d, "/etc/nginx/nginx.conf", errs));
    const servers = []; if (errs.length) return { errors: errs, servers };
    const http = top.find((d) => d.name === "http"); const inc = [];
    const collect = (ds) => { for (const d of ds) { if (d.name === "server") inc.push(d); if (d.name === "include" && /conf\.d\/\*\.conf$/.test(d.args[0] || "")) { for (const f of Sh.children(b, "/etc/nginx/conf.d").filter((x) => /\.conf$/.test(x))) { const e2 = [], ds2 = parseConf(node(b, f).data || "", f, e2); ds2.forEach((x) => check(x, f, e2)); if (e2.length) { errs.push(...e2); return; } collect(ds2); } } if (d.kids && d.name !== "server") collect(d.kids); } };
    if (http) collect(http.kids || []);
    for (const s of inc) {
      const o = { listens: [], names: [], root: "", index: ["index.html"], locs: [], cert: "", key: "", line: s.line };
      for (const k of s.kids || []) {
        if (k.name === "listen") { const spec = k.args[0] || "", m2 = /(\d+)$/.exec(spec.replace(/\]$/, "")); o.listens.push({ port: m2 ? parseInt(m2[1], 10) : 80, ssl: k.args.indexOf("ssl") >= 0 }); }
        else if (k.name === "server_name") o.names = k.args; else if (k.name === "root") o.root = k.args[0] || ""; else if (k.name === "index") o.index = k.args;
        else if (k.name === "ssl_certificate") o.cert = k.args[0] || ""; else if (k.name === "ssl_certificate_key") o.key = k.args[0] || "";
        else if (k.name === "location") { const loc = { path: k.args[k.args.length - 1] || "/", proxy: "" }; for (const q of k.kids || []) if (q.name === "proxy_pass") loc.proxy = q.args[0] || ""; o.locs.push(loc); }
      }
      if (!o.listens.length) o.listens.push({ port: 80, ssl: false });
      if (o.cert && !node(b, o.cert)) errs.push(`[emerg] cannot load certificate "${o.cert}": BIO_new_file() failed (SSL: error:02001002:system library:fopen:No such file or directory)`);
      else if (o.key && !node(b, o.key)) errs.push(`[emerg] cannot load certificate key "${o.key}": BIO_new_file() failed (SSL: error:02001002:system library:fopen:No such file or directory)`);
      servers.push(o);
    }
    return { errors: errs, servers };
  }
  function page(code, text) { return `<html>\n<head><title>${code} ${text}</title></head>\n<body>\n<center><h1>${code} ${text}</h1></center>\n<hr><center>${NGX}</center>\n</body>\n</html>`; }
  const STATUS = { 200: "OK", 403: "Forbidden", 404: "Not Found", 502: "Bad Gateway", 500: "Internal Server Error" };
  // what nginx (the running one) answers on a port
  function serveNginx(b, model, port, uri) {
    const s = model.servers.find((x) => x.listens.some((l) => l.port === port)); if (!s) return null;
    const loc = s.locs.filter((l) => uri.indexOf(l.path) === 0).sort((a, c) => c.path.length - a.path.length)[0] || { path: "/", proxy: "" };
    if (loc.proxy) {
      const m = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(loc.proxy), up = m ? parseInt(m[1], 10) : 80, p = procOnPort(b, up);
      if (!p) return { status: 502, body: page(502, "Bad Gateway"), server: NGX };
      if (p.unit === "app") return { status: 200, body: b.appBody || "ok", server: NGX };
      return { status: 200, body: "upstream answered", server: NGX };
    }
    let path = (s.root || "/etc/nginx/html") + uri.split("?")[0]; path = path.replace(/\/+$/, "") || "/";
    const who = { user: "www-data", root: false };
    let r = access(b, who, path, null);
    if (!r.ok) return r.err === "Permission denied" ? { status: 403, body: page(403, "Forbidden"), server: NGX } : { status: 404, body: page(404, "Not Found"), server: NGX };
    if (r.node.t === "d") { let found = null; for (const ix of s.index) { const fp = path + "/" + ix, a = access(b, who, fp, null); if (a.ok) { found = fp; break; } else if (a.err === "Permission denied") return { status: 403, body: page(403, "Forbidden"), server: NGX }; } if (!found) return { status: 403, body: page(403, "Forbidden"), server: NGX }; path = found; }
    const rr = access(b, who, path, "r"); if (!rr.ok) return { status: 403, body: page(403, "Forbidden"), server: NGX };
    return { status: 200, body: rr.node.data || "", server: NGX };
  }

  // ---------------------------------------------------------------- firewall
  function fwAllows(b, port, proto) { if (!b.fw.enabled) return true; for (const r of b.fw.rules) if (String(r.port) === String(port) && (r.proto === proto || r.proto === "any")) return r.action === "allow"; return false; }

  // ---------------------------------------------------------------- units
  const DESC = { nginx: "A high performance web server and a reverse proxy server", apache2: "The Apache HTTP Server", ssh: "OpenBSD Secure Shell server", app: "Application service" };
  function unitPath(b, n) { return n === "app" ? "/etc/systemd/system/app.service" : "/lib/systemd/system/" + (n === "ssh" ? "ssh" : n) + ".service"; }
  function addUnit(b, name, kind, o) { o = o || {}; b.units[name] = { kind, enabled: o.enabled !== false, active: o.active || "inactive", pid: 0, fail: "", loaded: null, inst: null, result: "" }; if (kind === "app") b.units[name].loaded = (node(b, unitPath(b, name)) || {}).data || ""; if (!node(b, unitPath(b, name))) addFile(b, unitPath(b, name), `[Unit]\nDescription=${DESC[kind] || name}\n\n[Service]\nExecStart=/usr/sbin/${name}\n\n[Install]\nWantedBy=multi-user.target\n`); return b.units[name]; }
  function stopUnit(b, name) { const u = b.units[name]; if (!u) return; b.procs = b.procs.filter((p) => p.unit !== name); if (u.active === "active") { u.active = "inactive"; u.inst = null; logSys(b, name, `Stopped ${DESC[u.kind] || name}.`); } }
  function fail(b, name, ident, msgs, sys) { const u = b.units[name]; u.active = "failed"; u.inst = null; b.procs = b.procs.filter((p) => p.unit !== name); logSys(b, name, `Starting ${DESC[u.kind] || name}...`); for (const m of msgs) log(b, name, m, ident); for (const m of sys) logSys(b, name, m); u.result = sys.join(" "); return false; }
  function bind(b, name, user, cmd, ports) { const pid = b.nextPid++; b.procs.push({ pid, user, cmd, unit: name, ports }); if (user === "root" && name === "nginx") b.procs.push({ pid: b.nextPid++, user: "www-data", cmd: "nginx: worker process", unit: name, ports: [] }); const u = b.units[name]; u.active = "active"; u.pid = pid; return pid; }
  function startUnit(b, name) {
    const u = b.units[name]; if (!u) return false; if (u.active === "active") return true;
    const bad = (ident, msgs, code) => fail(b, name, ident, msgs, [`${name}.service: ${code}`, `${name}.service: Failed with result 'exit-code'.`, `Failed to start ${DESC[u.kind]}.`]);
    if (u.kind === "nginx") {
      const m = nginxLoad(b); if (m.errors.length) return bad("nginx", m.errors.map((e) => "nginx: " + e).concat(["nginx: configuration file /etc/nginx/nginx.conf test failed"]), "Control process exited, code=exited, status=1/FAILURE");
      if (diskFull(b)) return bad("nginx", [`nginx: [emerg] open() "/var/log/nginx/access.log" failed (28: No space left on device)`], "Control process exited, code=exited, status=1/FAILURE");
      const ports = []; m.servers.forEach((s) => s.listens.forEach((l) => { if (ports.indexOf(l.port) < 0) ports.push(l.port); }));
      for (const p of ports) if (procOnPort(b, p)) return bad("nginx", [`nginx: [emerg] bind() to 0.0.0.0:${p} failed (98: Address already in use)`, `nginx: [emerg] still could not bind()`], "Control process exited, code=exited, status=1/FAILURE");
      logSys(b, name, `Starting ${DESC.nginx}...`); bind(b, name, "root", "nginx: master process /usr/sbin/nginx -g daemon on; master_process on;", ports); u.inst = { model: m }; logSys(b, name, `Started ${DESC.nginx}.`); return true;
    }
    if (u.kind === "apache2") { if (procOnPort(b, 80)) return bad("apachectl", ["(98)Address already in use: AH00072: make_sock: could not bind to address [::]:80", "no listening sockets available, shutting down", "AH00015: Unable to open logs"], "Control process exited, code=exited, status=1/FAILURE"); bind(b, name, "root", "/usr/sbin/apache2 -k start", [80]); logSys(b, name, `Started ${DESC.apache2}.`); return true; }
    if (u.kind === "ssh") {
      const cfg = sshConfig(b); if (cfg.errors.length) return bad("sshd", cfg.errors.concat([`/etc/ssh/sshd_config: terminating, ${cfg.errors.length} bad configuration options`]), "Control process exited, code=exited, status=255/EXCEPTION");
      if (procOnPort(b, cfg.Port)) return bad("sshd", [`error: Bind to port ${cfg.Port} on 0.0.0.0 failed: Address already in use.`, "fatal: Cannot bind any address."], "Main process exited, code=exited, status=255/EXCEPTION");
      bind(b, name, "root", `sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups`, [cfg.Port]); u.inst = { cfg }; log(b, name, `Server listening on 0.0.0.0 port ${cfg.Port}.`, "sshd"); logSys(b, name, `Started ${DESC.ssh}.`); return true;
    }
    if (u.kind === "app") {
      const ini = parseIni(u.loaded || ""), svc = ini.Service || {}, id = "app"; logSys(b, name, `Started ${DESC.app}.`);
      const sysFail = (code, extra) => { fail(b, name, "python", extra || [], [`app.service: ${code}`, "app.service: Failed with result 'exit-code'."]); return false; };
      const usr = svc.User || "root"; if (!b.users[usr]) return fail(b, name, "systemd", [], [`app.service: Failed to determine user credentials: No such process`, `app.service: Failed at step USER spawning ${(svc.ExecStart || "").split(/\s+/)[0]}: No such process`, "app.service: Main process exited, code=exited, status=217/USER", "app.service: Failed with result 'exit-code'."]);
      let env = {}; if (svc.EnvironmentFile) { const ef = svc.EnvironmentFile.replace(/^-/, ""), n = node(b, ef); if (!n && svc.EnvironmentFile[0] !== "-") return fail(b, name, "systemd", [], [`app.service: Failed to load environment files: No such file or directory`, "app.service: Failed to run 'start' task: No such file or directory", "app.service: Failed with result 'resources'."]); if (n) env = parseEnv(n.data); }
      const exe = (svc.ExecStart || "").split(/\s+/)[0], en = node(b, exe); if (!exe || !en || (en.mode & 0o111) === 0) return fail(b, name, "systemd", [], [`app.service: Failed at step EXEC spawning ${exe}: ${en ? "Permission denied" : "No such file or directory"}`, `app.service: Main process exited, code=exited, status=203/EXEC`, "app.service: Failed with result 'exit-code'."]);
      if (!env.DATABASE_URL) return sysFail("Main process exited, code=exited, status=1/FAILURE", ["Traceback (most recent call last):", '  File "/opt/app/app.py", line 7, in <module>', "    DB = os.environ['DATABASE_URL']", "KeyError: 'DATABASE_URL'"]);
      const ld = access(b, { user: usr, root: usr === "root" }, "/var/log/app", "w"); if (!ld.ok) return sysFail("Main process exited, code=exited, status=1/FAILURE", ["Traceback (most recent call last):", '  File "/opt/app/app.py", line 12, in <module>', "    handler = logging.FileHandler('/var/log/app/app.log')", "PermissionError: [Errno 13] Permission denied: '/var/log/app/app.log'"]);
      if (diskFull(b)) return sysFail("Main process exited, code=exited, status=1/FAILURE", ["Traceback (most recent call last):", '  File "/opt/app/app.py", line 12, in <module>', "    handler = logging.FileHandler('/var/log/app/app.log')", "OSError: [Errno 28] No space left on device: '/var/log/app/app.log'"]);
      const bm = /--bind\s+\S*?:(\d+)/.exec(svc.ExecStart || ""), port = bm ? parseInt(bm[1], 10) : parseInt(env.PORT || "8000", 10); if (procOnPort(b, port)) return sysFail("Main process exited, code=exited, status=1/FAILURE", ["OSError: [Errno 98] Address already in use"]);
      bind(b, name, usr, exe + " " + (svc.ExecStart || "").split(/\s+/).slice(1).join(" "), [port]); log(b, name, `Listening at: http://127.0.0.1:${port}`, "gunicorn"); return true;
    }
    return false;
  }
  function sshConfig(b) {
    const cfg = { errors: [], Port: 22, PermitRootLogin: "prohibit-password", PubkeyAuthentication: true, PasswordAuthentication: true, AllowUsers: [], StrictModes: true };
    const n = node(b, "/etc/ssh/sshd_config"); if (!n) { cfg.errors.push("sshd: no hostkeys available -- exiting."); return cfg; }
    const ok = new Set(["port", "permitrootlogin", "pubkeyauthentication", "passwordauthentication", "allowusers", "strictmodes", "authorizedkeysfile", "usepam", "x11forwarding", "printmotd", "acceptenv", "subsystem", "include", "challengeresponseauthentication", "kbdinteractiveauthentication", "loglevel", "maxauthtries", "permitemptypasswords", "listenaddress", "hostkey", "protocol"]);
    lines(n.data).forEach((l, i) => { const t = l.trim(); if (!t || t[0] === "#") return; const [k, ...v] = t.split(/\s+/), key = k.toLowerCase(); if (!ok.has(key)) { cfg.errors.push(`/etc/ssh/sshd_config line ${i + 1}: Bad configuration option: ${k}`); return; }
      const val = v.join(" "); if (key === "port") cfg.Port = parseInt(val, 10) || 22; else if (key === "permitrootlogin") cfg.PermitRootLogin = val; else if (key === "pubkeyauthentication") cfg.PubkeyAuthentication = /^yes$/i.test(val); else if (key === "passwordauthentication") cfg.PasswordAuthentication = /^yes$/i.test(val); else if (key === "allowusers") cfg.AllowUsers = cfg.AllowUsers.concat(v); else if (key === "strictmodes") cfg.StrictModes = !/^no$/i.test(val); });
    return cfg;
  }
  const vendorPreset = "enabled";
  function statusText(b, name) {
    const u = b.units[name]; if (!u) return `Unit ${name}.service could not be found.`;
    const f = unitPath(b, name), stale = u.kind === "app" && (node(b, f) || {}).data !== u.loaded;
    const head = `${u.active === "active" ? "●" : u.active === "failed" ? "×" : "○"} ${name}.service - ${DESC[u.kind] || name}`;
    const out = [head, `     Loaded: loaded (${f}; ${u.enabled ? "enabled" : "disabled"}; vendor preset: ${vendorPreset})`];
    if (u.active === "active") out.push(`     Active: active (running) since Tue 2026-11-24 09:12:01 UTC; 5min ago`, `   Main PID: ${u.pid} (${u.kind === "ssh" ? "sshd" : u.kind === "app" ? "gunicorn" : name})`);
    else if (u.active === "failed") out.push(`     Active: failed (Result: exit-code) since Tue 2026-11-24 09:10:42 UTC; 6min ago`, `    Process: ${b.nextPid - 1} ExecStart=${u.kind === "nginx" ? "/usr/sbin/nginx -g daemon on; master_process on;" : u.kind === "ssh" ? "/usr/sbin/sshd -D $SSHD_OPTS" : "(see unit)"} (code=exited, status=1/FAILURE)`);
    else out.push(`     Active: inactive (dead)`);
    if (stale) out.splice(1, 0, `Warning: The unit file, source configuration file or drop-ins of ${name}.service changed on disk. Run 'systemctl daemon-reload' to reload units.`);
    const jl = (b.journal[name] || []).slice(-8); if (jl.length) out.push("", ...jl);
    return out.join("\n");
  }
  function reqRoot(c, what) { return c.who.root ? null : { out: `Failed to ${what}: Interactive authentication required.`, code: 1 }; }
  def("systemctl", (b, a, c) => {
    const flags = a.filter((x) => x[0] === "-"), rest = a.filter((x) => x[0] !== "-"), sub = rest[0], names = rest.slice(1).map(unitName), now = flags.indexOf("--now") >= 0;
    if (flags.indexOf("--failed") >= 0 || (sub === "list-units" && flags.indexOf("--failed") >= 0)) { const f = Object.keys(b.units).filter((n) => b.units[n].active === "failed"); return { out: f.length ? f.map((n) => `● ${n}.service loaded failed failed ${DESC[b.units[n].kind]}`).join("\n") + `\n\n${f.length} loaded units listed.` : "0 loaded units listed." }; }
    if (!sub) return { out: "systemctl: missing command", code: 1 };
    if (sub === "daemon-reload") { const r = reqRoot(c, "reload daemon"); if (r) return r; for (const n of Object.keys(b.units)) if (b.units[n].kind === "app") b.units[n].loaded = (node(b, unitPath(b, n)) || {}).data || ""; return { out: "" }; }
    if (!names.length) return { out: `systemctl: ${sub} requires a unit name`, code: 1 };
    const out = []; let code = 0;
    for (const n of names) {
      const u = b.units[n];
      if (!u) { out.push(sub === "status" ? `Unit ${n}.service could not be found.` : `Failed to ${sub} ${n}.service: Unit ${n}.service not found.`); code = sub === "status" ? 4 : 5; continue; }
      if (sub === "status") { out.push(statusText(b, n)); if (u.active !== "active") code = 3; }
      else if (sub === "is-active") { out.push(u.active); if (u.active !== "active") code = 3; }
      else if (sub === "is-enabled") { out.push(u.enabled ? "enabled" : "disabled"); if (!u.enabled) code = 1; }
      else if (sub === "cat") { out.push("# " + unitPath(b, n) + "\n" + ((node(b, unitPath(b, n)) || {}).data || "").replace(/\n$/, "")); }
      else if (["start", "stop", "restart", "reload", "enable", "disable"].indexOf(sub) >= 0) {
        const r = reqRoot(c, sub + " " + n + ".service"); if (r) { out.push(r.out); code = 1; continue; }
        if (sub === "start") { if (!startUnit(b, n) && u.kind !== "app") { out.push(`Job for ${n}.service failed because the control process exited with error code.\nSee "systemctl status ${n}.service" and "journalctl -xeu ${n}.service" for details.`); code = 1; } }
        else if (sub === "stop") stopUnit(b, n);
        else if (sub === "restart") { stopUnit(b, n); if (!startUnit(b, n) && u.kind !== "app") { out.push(`Job for ${n}.service failed because the control process exited with error code.\nSee "systemctl status ${n}.service" and "journalctl -xeu ${n}.service" for details.`); code = 1; } }
        else if (sub === "reload") { if (u.active !== "active") { out.push(`Failed to reload ${n}.service: Job type reload is not applicable for unit ${n}.service.`); code = 1; } else reloadUnit(b, n, out); }
        else if (sub === "enable") { u.enabled = true; out.push(`Created symlink /etc/systemd/system/multi-user.target.wants/${n}.service → ${unitPath(b, n)}.`); if (now) startUnit(b, n); }
        else if (sub === "disable") { u.enabled = false; out.push(`Removed /etc/systemd/system/multi-user.target.wants/${n}.service.`); if (now) stopUnit(b, n); }
      } else { out.push(`Unknown command verb ${sub}.`); code = 1; }
    }
    return { out: out.join("\n"), code };
  }, {});
  function reloadUnit(b, n, out) {
    const u = b.units[n];
    if (u.kind === "nginx") { const m = nginxLoad(b); if (m.errors.length) { m.errors.forEach((e) => log(b, "nginx", "nginx: " + e, "nginx")); out.push(`Job for nginx.service failed because the control process exited with error code.\nSee "systemctl status nginx.service" and "journalctl -xeu nginx.service" for details.`); return; } u.inst.model = m; const ports = []; m.servers.forEach((s) => s.listens.forEach((l) => { if (ports.indexOf(l.port) < 0) ports.push(l.port); })); b.procs.filter((p) => p.unit === "nginx" && p.ports.length).forEach((p) => { p.ports = ports; }); }
    else if (u.kind === "ssh") { const cfg = sshConfig(b); if (cfg.errors.length) { out.push(`Job for ssh.service failed because the control process exited with error code.`); return; } u.inst.cfg = cfg; b.procs.filter((p) => p.unit === "ssh").forEach((p) => { p.ports = [cfg.Port]; }); }
  }
  def("journalctl", (b, a, c) => { let unit = null, n = 100; for (let i = 0; i < a.length; i++) { if (a[i] === "-u" || a[i] === "--unit") unit = unitName(a[++i]); else if (a[i].startsWith("-u")) unit = unitName(a[i].slice(2)); else if (a[i] === "-n") n = parseInt(a[++i], 10); else if (/^-xe?u$|^-eu$|^-xeu$/.test(a[i])) unit = unitName(a[++i]); } const l = unit ? (b.journal[unit] || []) : [].concat(...Object.values(b.journal)); if (unit && !b.units[unit]) return { out: `-- No entries --` }; return { out: l.length ? "-- Journal begins at Tue 2026-11-24 08:55:10 UTC --\n" + l.slice(-n).join("\n") : "-- No entries --" }; });
  def("nginx", (b, a, c) => {
    if (a.indexOf("-v") >= 0 || a.indexOf("-V") >= 0) return { out: "nginx version: " + NGX };
    if (a.indexOf("-t") >= 0 || a.indexOf("-T") >= 0) { if (!c.who.root) return { out: `nginx: [warn] the "user" directive makes sense only if the master process runs with super-user privileges, ignored in /etc/nginx/nginx.conf:1\nnginx: [emerg] open() "/var/log/nginx/error.log" failed (13: Permission denied)\nnginx: configuration file /etc/nginx/nginx.conf test failed`, code: 1 }; const m = nginxLoad(b); if (m.errors.length) return { out: m.errors.map((e) => "nginx: " + e).join("\n") + "\nnginx: configuration file /etc/nginx/nginx.conf test failed", code: 1 }; return { out: "nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful" }; }
    const si = a.indexOf("-s"); if (si >= 0) { if (!c.who.root) return { out: `nginx: [alert] could not open error log file: open() "/var/log/nginx/error.log" failed (13: Permission denied)\nnginx: [emerg] open() "/run/nginx.pid" failed (13: Permission denied)`, code: 1 }; const u = b.units.nginx; if (!u || u.active !== "active") return { out: `nginx: [error] open() "/run/nginx.pid" failed (2: No such file or directory)`, code: 1 }; if (a[si + 1] === "reload") { const out = []; reloadUnit(b, "nginx", out); return { out: out.join("\n"), code: out.length ? 1 : 0 }; } if (a[si + 1] === "stop" || a[si + 1] === "quit") { stopUnit(b, "nginx"); return { out: "" }; } }
    return { out: "nginx: use -t to test the configuration or systemctl to start it", code: 1 };
  });
  def("sshd", (b, a, c) => { if (a.indexOf("-t") >= 0) { if (!c.who.root) return { out: "sshd: no hostkeys available -- exiting.", code: 1 }; const cfg = sshConfig(b); return cfg.errors.length ? { out: cfg.errors.join("\n") + `\n/etc/ssh/sshd_config: terminating, ${cfg.errors.length} bad configuration options`.replace(/^/, ""), code: 255 } : { out: "" }; } return { out: "sshd: use systemctl to manage the service", code: 1 }; });

  // ---------------------------------------------------------------- firewall commands
  const SERVICES = { ssh: 22, http: 80, https: 443 };
  function fwSpec(s) { const m = /^(\d+)(?:\/(tcp|udp))?$/.exec(s); if (m) return { port: m[1], proto: m[2] || "any" }; if (SERVICES[s]) return { port: String(SERVICES[s]), proto: "tcp" }; if (s === "Nginx Full") return { port: "80", proto: "tcp" }; return null; }
  def("ufw", (b, a, c) => {
    if (!c.who.root) return { out: "ERROR: You need to be root to run this script", code: 1 };
    const sub = a[0];
    if (sub === "status") { if (!b.fw.enabled) return { out: "Status: inactive" }; const rows = b.fw.rules.map((r) => `${(r.port + (r.proto === "any" ? "" : "/" + r.proto)).padEnd(26)} ${r.action.toUpperCase().padEnd(11)} Anywhere`); return { out: ["Status: active", "", "To                         Action      From", "--                         ------      ----"].concat(rows).join("\n") }; }
    if (sub === "enable") { b.fw.enabled = true; return { out: "Firewall is active and enabled on system startup" }; }
    if (sub === "disable") { b.fw.enabled = false; return { out: "Firewall stopped and disabled on system startup" }; }
    if (sub === "allow" || sub === "deny" || sub === "reject" || sub === "limit") { const sp = fwSpec(a[1] === "from" ? "" : a[1]); if (!sp) return { out: "ERROR: Bad port '" + a[1] + "'", code: 1 }; const ex = b.fw.rules.findIndex((r) => r.port === sp.port && r.proto === sp.proto); const rule = { port: sp.port, proto: sp.proto, action: sub === "allow" || sub === "limit" ? "allow" : "deny" }; if (ex >= 0) { if (b.fw.rules[ex].action === rule.action) return { out: "Skipping adding existing rule" }; b.fw.rules[ex] = rule; return { out: "Rule updated" }; } b.fw.rules.push(rule); return { out: "Rule added" }; }
    if (sub === "delete") { const sp = fwSpec(a[2] || a[1]); if (!sp) return { out: "ERROR: Could not find rule", code: 1 }; const act = a[2] ? a[1] : null; const i = b.fw.rules.findIndex((r) => r.port === sp.port && r.proto === sp.proto && (!act || r.action === (act === "allow" ? "allow" : "deny"))); if (i < 0) return { out: "Could not delete non-existent rule", code: 1 }; b.fw.rules.splice(i, 1); return { out: "Rule deleted" }; }
    return { out: "ERROR: Invalid syntax", code: 1 };
  });
  def("iptables", (b, a, c) => {
    if (!c.who.root) return { out: "iptables v1.8.7 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)", code: 4 };
    const val = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : null; };
    if (a.indexOf("-L") >= 0 || a.indexOf("-S") >= 0) { const rows = b.fw.rules.map((r, i) => `${r.action === "allow" ? "ACCEPT" : "DROP  "}     ${r.proto === "any" ? "all" : r.proto}  --  0.0.0.0/0            0.0.0.0/0            ${r.proto === "any" ? "" : r.proto + " "}dpt:${r.port}`); return { out: [`Chain INPUT (policy ${b.fw.enabled ? "DROP" : "ACCEPT"})`, "target     prot opt source               destination"].concat(b.fw.enabled ? rows : []).join("\n") }; }
    const op = a.indexOf("-I") >= 0 ? "I" : a.indexOf("-A") >= 0 ? "A" : a.indexOf("-D") >= 0 ? "D" : null; if (!op) return { out: "iptables: use -L to list, -I/-A/-D to change", code: 2 };
    const port = val("--dport"), tgt = val("-j"), proto = val("-p") || "tcp"; if (!port || !tgt) return { out: "iptables: need -p, --dport and -j", code: 2 };
    const rule = { port: String(port), proto, action: tgt === "ACCEPT" ? "allow" : "deny" };
    if (op === "D") { const i = b.fw.rules.findIndex((r) => r.port === rule.port && r.action === rule.action); if (i < 0) return { out: "iptables: Bad rule (does a matching rule exist in that chain?).", code: 1 }; b.fw.rules.splice(i, 1); } else if (op === "I") b.fw.rules.unshift(rule); else b.fw.rules.push(rule);
    return { out: "" };
  });

  // ---------------------------------------------------------------- processes and sockets
  def("ps", (b, a) => { const rows = [{ pid: 1, user: "root", cmd: "/sbin/init" }].concat(b.procs.map((p) => ({ pid: p.pid, user: p.user, cmd: p.cmd }))).concat([{ pid: b.nextPid + 500, user: b.user, cmd: "-bash" }]); const w = a.join(" "); if (/-ef/.test(w)) return { out: "UID          PID  PPID  C STIME TTY          TIME CMD\n" + rows.map((r) => `${r.user.padEnd(8)} ${String(r.pid).padStart(7)}     1  0 09:00 ?        00:00:00 ${r.cmd}`).join("\n") }; return { out: "USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n" + rows.map((r) => `${r.user.padEnd(8)} ${String(r.pid).padStart(7)}  0.0  0.4  12345  6789 ?        Ss   09:00   0:00 ${r.cmd}`).join("\n") }; });
  function sockets(b, a, c) { const rows = []; for (const p of b.procs) for (const port of p.ports || []) rows.push({ port, p }); rows.sort((x, y) => x.port - y.port); const show = c.who.root; return { out: ["State   Recv-Q  Send-Q   Local Address:Port    Peer Address:Port  Process"].concat(rows.map((r) => `LISTEN  0       511      ${("0.0.0.0:" + r.port).padEnd(20)} ${"0.0.0.0:*".padEnd(18)} ${show ? `users:(("${r.p.cmd.split(/[ :]/)[0] === "nginx" ? "nginx" : r.p.cmd.split(/[ /]/).filter(Boolean).pop().split(":")[0]}",pid=${r.p.pid},fd=6))` : ""}`.trimEnd())).join("\n") }; }
  def("ss", sockets); def("netstat", sockets);
  def("lsof", (b, a, c) => { const m = /:(\d+)/.exec(a.join(" ")); if (!m) return { out: "" }; const p = procOnPort(b, parseInt(m[1], 10)); return { out: p && c.who.root ? `COMMAND   PID     USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n${p.cmd.split(/[ :]/)[0]} ${String(p.pid).padEnd(7)} ${p.user.padEnd(8)} 6u  IPv4  12345      0t0  TCP *:${m[1]} (LISTEN)` : "" }; });
  def("kill", (b, a, c) => { if (!c.who.root) return { out: `bash: kill: (${a[a.length - 1]}) - Operation not permitted`, code: 1 }; const pid = parseInt(a.filter((x) => x[0] !== "-").pop(), 10), p = b.procs.find((q) => q.pid === pid); if (!p) return { out: `bash: kill: (${pid}) - No such process`, code: 1 }; if (p.unit && b.units[p.unit]) stopUnit(b, p.unit); else b.procs = b.procs.filter((q) => q !== p); return { out: "" }; });
  def("pkill", (b, a, c) => { if (!c.who.root) return { out: "pkill: killing pid failed: Operation not permitted", code: 1 }; const n = a.filter((x) => x[0] !== "-").pop(), ps = b.procs.filter((p) => p.cmd.indexOf(n) >= 0); if (!ps.length) return { out: "", code: 1 }; ps.forEach((p) => { if (p.unit && b.units[p.unit]) stopUnit(b, p.unit); else b.procs = b.procs.filter((q) => q !== p); }); return { out: "" }; });

  // ---------------------------------------------------------------- network requests
  const isLocal = (src, host) => host === "localhost" || host === "127.0.0.1" || host === src.name || host === src.ip;
  function resolveTarget(src, host) { if (isLocal(src, host)) return { box: src, local: true }; const peer = src.peer; if (peer && (host === peer.ip || host === peer.name)) return { box: peer, local: false }; return null; }
  function request(src, host, port, uri, scheme) {
    const t = resolveTarget(src, host); if (!t) return { err: 6, msg: `Could not resolve host: ${host}` };
    const b = t.box; if (!t.local && !fwAllows(b, port, "tcp")) return { err: 28, msg: `Connection timed out after 5001 milliseconds` };
    const p = procOnPort(b, port); if (!p) return { err: 7, msg: `Failed to connect to ${host} port ${port} after 0 ms: Connection refused` };
    if (p.unit === "nginx") { const u = b.units.nginx, r = serveNginx(b, u.inst.model, port, uri); return r || { err: 52, msg: "Empty reply from server" }; }
    if (p.unit === "apache2") return { status: 200, body: "<html><body><h1>Apache2 Ubuntu Default Page</h1><p>It works!</p></body></html>", server: "Apache/2.4.52 (Ubuntu)" };
    if (p.unit === "app") return { status: 200, body: b.appBody || "ok", server: "gunicorn" };
    return { err: 52, msg: "Empty reply from server" };
  }
  def("curl", (b, a, c) => {
    let head = false, silent = false, verbose = false, outFile = null, fmt = null, url = null, incl = false;
    for (let i = 0; i < a.length; i++) { const x = a[i]; if (x === "-I" || x === "--head") head = true; else if (x === "-i") incl = true; else if (/^-[sS]+$|^--silent$/.test(x)) silent = true; else if (x === "-v") verbose = true; else if (x === "-o") outFile = a[++i]; else if (x === "-w") fmt = a[++i]; else if (x === "--max-time" || x === "-m") i++; else if (x === "-k" || x === "-L" || x === "-sS" || x === "-sk") { /* ok */ } else if (x[0] !== "-") url = x; }
    if (!url) return { out: "curl: try 'curl --help' for more information", code: 2 };
    const m = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/.exec(url.indexOf("://") < 0 ? "http://" + url : url); if (!m) return { out: `curl: (3) URL using bad/illegal format or missing URL`, code: 3 };
    const scheme = m[1], port = m[3] ? parseInt(m[3], 10) : scheme === "https" ? 443 : 80, uri = m[4] || "/", r = request(b, m[2], port, uri, scheme), o = [];
    if (verbose) o.push(`*   Trying ${m[2] === "localhost" ? "127.0.0.1" : m[2]}:${port}...`);
    if (r.err) { if (verbose) o.push(r.err === 7 ? `* connect to ${m[2]} port ${port} failed: Connection refused` : `* ${r.msg}`); if (fmt) o.push(fmt.replace(/%\{http_code\}/g, "000")); if (!silent || verbose) o.push(`curl: (${r.err}) ${r.msg}`); return { out: o.join("\n"), code: r.err }; }
    if (verbose) { o.push(`* Connected to ${m[2]} (${m[2]}) port ${port} (#0)`, `> GET ${uri} HTTP/1.1`, `> Host: ${m[2]}`, "> User-Agent: curl/7.81.0", "> Accept: */*", ">", `< HTTP/1.1 ${r.status} ${STATUS[r.status] || ""}`, `< Server: ${r.server}`, "<"); }
    const hdr = [`HTTP/1.1 ${r.status} ${STATUS[r.status] || ""}`, `Server: ${r.server}`, "Content-Type: text/html", `Content-Length: ${r.body.length}`];
    if (head) o.push(hdr.join("\n")); else if (incl) o.push(hdr.join("\n") + "\n\n" + r.body); else if (!outFile) o.push(r.body.replace(/\n$/, ""));
    if (fmt) o.push(fmt.replace(/%\{http_code\}/g, String(r.status)).replace(/\\n/g, "\n"));
    return { out: o.join("\n"), code: 0 };
  }, { client: true });
  def("ping", (b, a) => { const host = a.filter((x) => x[0] !== "-" && !/^\d+$/.test(x)).pop(), t = resolveTarget(b, host); if (!t) return { out: `ping: ${host}: Name or service not known`, code: 2 }; return { out: `PING ${host} (${t.box.ip}) 56(84) bytes of data.\n64 bytes from ${t.box.ip}: icmp_seq=1 ttl=64 time=0.4 ms\n\n--- ${host} ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss` }; }, { client: true });

  // ---------------------------------------------------------------- ssh client
  const blobOf = (text) => { const m = /(AAAA[A-Za-z0-9+/=]*)/.exec(text || ""); return m ? m[1] : ""; };
  const privId = (text) => { const m = /b3BlbnNzaC1rZXktdjEAAAAA([A-Za-z0-9]+)/.exec(text || ""); return m ? m[1] : ""; };
  function modeBad(n, strict) { return n && ((n.mode & 0o022) !== 0); }
  function sshLogin(client, server, user, port, idFile) {
    const fwOk = fwAllows(server, port, "tcp"); if (!fwOk) return { err: `ssh: connect to host ${server.ip} port ${port}: Connection timed out` };
    const p = procOnPort(server, port); if (!p || p.unit !== "ssh") return { err: `ssh: connect to host ${server.ip} port ${port}: Connection refused` };
    const cfg = server.units.ssh.inst.cfg, L = (m) => log(server, "ssh", m, "sshd");
    const denied = (why) => { if (why) L(why); return { err: `${user}@${server.ip}: Permission denied (publickey${cfg.PasswordAuthentication ? ",password" : ""}).` }; };
    if (user === "root" && /^no$/i.test(cfg.PermitRootLogin)) return denied(`ROOT LOGIN REFUSED FROM ${client.ip}`);
    if (cfg.AllowUsers.length && cfg.AllowUsers.indexOf(user) < 0) return denied(`User ${user} from ${client.ip} not allowed because not listed in AllowUsers`);
    const u = server.users[user]; if (!u) return denied(`Invalid user ${user} from ${client.ip} port 51234`);
    if (u.locked) return denied(`User ${user} not allowed because account is locked`);
    // client key
    const idPath = Sh.norm(client, idFile || "~/.ssh/id_ed25519"), idn = node(client, idPath); let warn = "";
    if (!idn) warn = `Warning: Identity file ${idFile || "~/.ssh/id_ed25519"} not accessible: No such file or directory.\n`;
    else if ((idn.mode & 0o077) !== 0) return { err: `@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nPermissions ${(idn.mode & 0o777).toString(8).padStart(4, "0")} for '${idFile || "~/.ssh/id_ed25519"}' are too open.\nThis private key will be ignored.\n${user}@${server.ip}: Permission denied (publickey).` };
    if (!cfg.PubkeyAuthentication) return Object.assign(denied(`Failed publickey for ${user} from ${client.ip} port 51234 ssh2: public key authentication is disabled`), { warn });
    if (!idn) return Object.assign(denied(`Connection closed by authenticating user ${user} ${client.ip} port 51234 [preauth]`), { warn });
    const home = u.home, ssh = home + "/.ssh", ak = ssh + "/authorized_keys";
    if (cfg.StrictModes) {
      const homeN = node(server, home), sshN = node(server, ssh), akN = node(server, ak);
      const own = (n) => n && (n.owner === user || n.owner === "root");
      if (homeN && (modeBad(homeN) || !own(homeN))) return Object.assign(denied(`Authentication refused: bad ownership or modes for directory ${home}`), { warn });
      if (sshN && (modeBad(sshN) || !own(sshN))) return Object.assign(denied(`Authentication refused: bad ownership or modes for directory ${ssh}`), { warn });
      if (akN && (modeBad(akN) || !own(akN))) return Object.assign(denied(`Authentication refused: bad ownership or modes for file ${ak}`), { warn });
    }
    const akN = node(server, ak); if (!akN) return Object.assign(denied(`Failed publickey for ${user} from ${client.ip} port 51234 ssh2: no authorized_keys file`), { warn });
    const pubN = node(client, idPath + ".pub"), blob = pubN ? blobOf(pubN.data) : "AAAAC3NzaC1lZDI1NTE5AAAAI" + privId(idn.data);
    const keys = lines(akN.data).filter((l) => l.trim() && l.trim()[0] !== "#").map((l) => blobOf(l));
    if (keys.indexOf(blob) < 0) return Object.assign(denied(`Failed publickey for ${user} from ${client.ip} port 51234 ssh2: ED25519 SHA256:${blob.slice(-12)}`), { warn });
    L(`Accepted publickey for ${user} from ${client.ip} port 51234 ssh2`);
    return { ok: true, warn };
  }
  def("ssh", (b, a) => {
    if (!b.peer) return { out: "ssh: no route to host", code: 255 };
    let port = 22, id = null, target = null; for (let i = 0; i < a.length; i++) { if (a[i] === "-p") port = parseInt(a[++i], 10); else if (a[i].startsWith("-p") && /^\d+$/.test(a[i].slice(2))) port = parseInt(a[i].slice(2), 10); else if (a[i] === "-i") id = a[++i]; else if (a[i] === "-o") i++; else if (a[i][0] !== "-" && !target) target = a[i]; }
    if (!target) return { out: "usage: ssh [-p port] [-i identity_file] [user@]hostname", code: 255 };
    const at = target.indexOf("@"), user = at >= 0 ? target.slice(0, at) : b.user, host = at >= 0 ? target.slice(at + 1) : target, t = resolveTarget(b, host);
    if (!t || t.local) return { out: `ssh: Could not resolve hostname ${host}: Name or service not known`, code: 255 };
    const r = sshLogin(b, t.box, user, port, id); if (r.err) return { out: (r.warn || "") + r.err, code: 255 };
    return { out: (r.warn || "") + `Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-91-generic x86_64)\n\nLast login: Tue Nov 24 08:58:12 2026 from ${b.ip}\n${user}@${t.box.name}:~$ exit\n(Login worked; the lab closes the session here.)\nConnection to ${host} closed.` };
  }, { client: true });
  def("ssh-keygen", (b, a) => { const i = a.indexOf("-lf"); if (i < 0) return { out: "ssh-keygen: only -lf FILE is available in this lab", code: 1 }; const n = node(b, norm(b, a[i + 1] || "")); if (!n) return { out: `${a[i + 1]}: No such file or directory`, code: 1 }; return { out: `256 SHA256:${blobOf(n.data).slice(-20)} ${(/ (\S+@\S+)\s*$/m.exec(n.data) || [0, "no comment"])[1]} (ED25519)` }; }, { client: true });

  // ---------------------------------------------------------------- the lab-facing helpers
  const Svc = { link, addUnit, startUnit, stopUnit, nginxLoad, sshConfig, request, sshLogin, fwAllows, procOnPort, parseIni, parseEnv, statusText, unitPath, page };
  root.Linuxsvc = Svc; if (typeof module !== "undefined" && module.exports) module.exports = Svc;
})(typeof self !== "undefined" ? self : globalThis);
