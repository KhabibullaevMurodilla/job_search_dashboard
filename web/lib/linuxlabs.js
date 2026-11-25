/* Linuxlabs: Linux service troubleshooting labs (web server, application service, SSH access).
   Same shape as Netlabs: create(scenario, seed, opts) builds a healthy and a faulty machine pair, verify()
   runs the same user-facing checks on the faulty one, reference() swaps in the healthy one for tests. */
(function (root) {
  "use strict";
  const Sh = root.Linuxsh || (typeof require !== "undefined" ? require("./linuxsh.js") : null);
  const Svc = root.Linuxsvc || (typeof require !== "undefined" ? require("./linuxsvc.js") : null);
  const { addFile, newBox, node } = Sh;

  function rngOf(seed) { let a = (seed >>> 0) || 1; return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const pick = (rnd, l) => l[Math.floor(rnd() * l.length)];
  const TIERS = {
    web: { "not-enabled": 1, "fw-80": 1, "conf-semicolon": 2, "port-conflict": 2, "perm-root": 2, "root-typo": 2, "ssl-cert-path": 3, "disk-full": 3, "wrong-listen": 3 },
    app: { "proxy-port": 1, "execstart-typo": 2, "envfile-path": 2, "app-user": 2, "env-missing": 3, "log-perm": 3, "unit-reload": 3, "disk-full": 3 },
    ssh: { "sshd-down": 1, "fw-ssh": 1, "port-changed": 2, "allowusers": 2, "config-typo": 2, "id-perm": 2, "pubkey-off": 3, "authkeys-perm": 3, "home-perm": 3, "wrong-key": 3 },
  };
  const NAMES = { web: "Linux web server (nginx)", app: "Linux application service (systemd)", ssh: "Linux SSH access" };

  // ---------------------------------------------------------------- the healthy machines
  function world(rnd) {
    const site = pick(rnd, ["shop", "portal", "wiki", "docs", "billing", "intranet"]), n = 1 + Math.floor(rnd() * 4), sub = 20 + Math.floor(rnd() * 30), host = 10 + Math.floor(rnd() * 80);
    const server = newBox({ name: "web" + n, ip: `10.${sub}.${n}.${host}`, user: "admin" }), client = newBox({ name: "client", ip: `10.${sub}.${n}.9`, user: "admin", client: true });
    Svc.link(server, client);
    server.users["www-data"] = { uid: 33, groups: ["www-data"], home: "/var/www", sudo: false, locked: false };
    server.users.deploy = { uid: 1001, groups: ["deploy"], home: "/home/deploy", sudo: false, locked: false };
    server.users.appuser = { uid: 1002, groups: ["appuser"], home: "/opt/app", sudo: false, locked: false };
    server.fw.rules = [{ port: "22", proto: "tcp", action: "allow" }, { port: "80", proto: "tcp", action: "allow" }, { port: "443", proto: "tcp", action: "allow" }];
    return { site, server, client, domain: site + ".example.com" };
  }
  function nginxFiles(w, proxyPort) {
    const b = w.server, root = "/var/www/" + w.site;
    addFile(b, "/etc/nginx/nginx.conf", "user www-data;\nworker_processes auto;\npid /run/nginx.pid;\n\nevents {\n    worker_connections 768;\n}\n\nhttp {\n    sendfile on;\n    access_log /var/log/nginx/access.log;\n    error_log /var/log/nginx/error.log;\n    include /etc/nginx/conf.d/*.conf;\n}\n");
    const loc = proxyPort ? `    location / {\n        proxy_pass http://127.0.0.1:${proxyPort};\n        proxy_set_header Host $host;\n    }\n` : `    location / {\n        try_files $uri $uri/ =404;\n    }\n`;
    const body = proxyPort ? "" : `    root ${root};\n    index index.html;\n`;
    addFile(b, "/etc/nginx/conf.d/site.conf", `server {\n    listen 80;\n    server_name ${w.domain};\n${body}${loc}}\n\nserver {\n    listen 443 ssl;\n    server_name ${w.domain};\n    ssl_certificate /etc/ssl/${w.site}/site.crt;\n    ssl_certificate_key /etc/ssl/${w.site}/site.key;\n${body}${loc}}\n`);
    addFile(b, `/etc/ssl/${w.site}/site.crt`, "-----BEGIN CERTIFICATE-----\nMIIB...lab certificate...\n-----END CERTIFICATE-----\n", { mode: 0o644 });
    addFile(b, `/etc/ssl/${w.site}/site.key`, "-----BEGIN PRIVATE KEY-----\nMIIE...lab key...\n-----END PRIVATE KEY-----\n", { mode: 0o600 });
    for (const d of ["/var/log/nginx", "/etc/nginx/conf.d"]) Sh.mkdirs(b, d, {});
    addFile(b, "/var/log/nginx/access.log", "", { owner: "www-data", group: "adm", mode: 0o640 }); addFile(b, "/var/log/nginx/error.log", "", { owner: "www-data", group: "adm", mode: 0o640 });
    Svc.addUnit(b, "nginx", "nginx", { enabled: true });
  }
  function webWorld(rnd) {
    const w = world(rnd), b = w.server, root = "/var/www/" + w.site;
    nginxFiles(w, 0);
    addFile(b, root + "/index.html", `<html><body><h1>Welcome to ${w.site}</h1></body></html>\n`, { owner: "www-data", group: "www-data", mode: 0o644, downer: "www-data", dmode: 0o755 });
    Svc.addUnit(b, "apache2", "apache2", { enabled: false });
    Svc.startUnit(b, "nginx"); w.marker = "Welcome to " + w.site; w.root = root;
    w.checks = [
      { id: "run", label: "nginx is running", ok: () => b.units.nginx.active === "active" },
      { id: "boot", label: "nginx starts at boot", ok: () => b.units.nginx.enabled },
      { id: "http", label: `http://${b.ip}/ shows the site from the client`, ok: () => { const r = Svc.request(w.client, b.ip, 80, "/"); return !r.err && r.status === 200 && r.body.indexOf(w.marker) >= 0; } },
      { id: "https", label: `https://${b.ip}/ shows the site from the client`, ok: () => { const r = Svc.request(w.client, b.ip, 443, "/"); return !r.err && r.status === 200 && r.body.indexOf(w.marker) >= 0; } },
    ];
    return w;
  }
  function appWorld(rnd) {
    const w = world(rnd), b = w.server, port = pick(rnd, [8000, 8080, 5000, 9000]); w.port = port;
    nginxFiles(w, port);
    b.appBody = `${w.site} api: ok`; w.marker = b.appBody;
    Sh.mkdirs(b, "/opt/app/venv/bin", { downer: "appuser" }); Sh.mkdirs(b, "/etc/app", {}); Sh.mkdirs(b, "/var/log/app", { downer: "appuser" });
    addFile(b, "/opt/app/venv/bin/gunicorn", "#!/opt/app/venv/bin/python\n", { owner: "appuser", mode: 0o755 }); addFile(b, "/opt/app/app.py", "import os\nDB = os.environ['DATABASE_URL']\n", { owner: "appuser" });
    addFile(b, "/etc/app/app.env", `DATABASE_URL=postgresql://${w.site}:secret@10.0.0.50/${w.site}\nLOG_LEVEL=info\n`, { owner: "root", group: "appuser", mode: 0o640 });
    addFile(b, "/var/log/app/app.log", "", { owner: "appuser", mode: 0o644 });
    w.unitText = `[Unit]\nDescription=${w.site} API\nAfter=network.target\n\n[Service]\nUser=appuser\nWorkingDirectory=/opt/app\nEnvironmentFile=/etc/app/app.env\nExecStart=/opt/app/venv/bin/gunicorn --bind 127.0.0.1:${port} app:app\nRestart=on-failure\n\n[Install]\nWantedBy=multi-user.target\n`;
    addFile(b, "/etc/systemd/system/app.service", w.unitText, { mode: 0o644 });
    Svc.addUnit(b, "app", "app", { enabled: true }); b.units.app.loaded = w.unitText;
    Svc.addUnit(b, "apache2", "apache2", { enabled: false });
    Svc.startUnit(b, "nginx"); Svc.startUnit(b, "app");
    w.checks = [
      { id: "nginx", label: "nginx is running", ok: () => b.units.nginx.active === "active" },
      { id: "app", label: "the app service is running", ok: () => b.units.app.active === "active" },
      { id: "boot", label: "the app starts at boot", ok: () => b.units.app.enabled },
      { id: "http", label: `http://${b.ip}/ returns the app's page from the client`, ok: () => { const r = Svc.request(w.client, b.ip, 80, "/"); return !r.err && r.status === 200 && r.body.indexOf(w.marker) >= 0; } },
    ];
    return w;
  }
  function sshWorld(rnd) {
    const w = world(rnd), b = w.server, c = w.client, id = Math.floor(rnd() * 1e9).toString(36) + "Qx7", other = Math.floor(rnd() * 1e9).toString(36) + "Zk2";
    addFile(b, "/etc/ssh/sshd_config", "Include /etc/ssh/sshd_config.d/*.conf\nPort 22\nPermitRootLogin no\nPubkeyAuthentication yes\nPasswordAuthentication no\nStrictModes yes\nUsePAM yes\nAllowUsers deploy admin\nSubsystem sftp /usr/lib/openssh/sftp-server\n");
    Svc.addUnit(b, "ssh", "ssh", { enabled: true });
    const pub = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${id} admin@client`;
    w.pub = pub; w.otherPub = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${other} old@laptop`;
    Sh.mkdirs(c, "/home/admin/.ssh", { downer: "admin", dmode: 0o700 });
    addFile(c, "/home/admin/.ssh/id_ed25519", `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA${id}\n-----END OPENSSH PRIVATE KEY-----\n`, { owner: "admin", mode: 0o600 });
    addFile(c, "/home/admin/.ssh/id_ed25519.pub", pub + "\n", { owner: "admin", mode: 0o644 });
    Sh.mkdirs(b, "/home/deploy/.ssh", { downer: "deploy", dmode: 0o700 }); b.fs["/home/deploy"] = { t: "d", mode: 0o755, owner: "deploy", group: "deploy" };
    addFile(b, "/home/deploy/.ssh/authorized_keys", pub + "\n", { owner: "deploy", mode: 0o600 });
    Svc.startUnit(b, "ssh");
    w.checks = [
      { id: "run", label: "sshd is running", ok: () => b.units.ssh.active === "active" },
      { id: "boot", label: "sshd starts at boot", ok: () => b.units.ssh.enabled },
      { id: "login", label: `ssh deploy@${b.ip} works from the client with its key`, ok: () => { const r = Svc.sshLogin(w.client, b, "deploy", 22, null); return !!r.ok; } },
      { id: "hard", label: "hardening is kept (no root login, no password login)", ok: () => { const u = b.units.ssh, cfg = Svc.sshConfig(b); return !(u.inst && u.inst.cfg && (!/^no$/i.test(u.inst.cfg.PermitRootLogin) || u.inst.cfg.PasswordAuthentication)) && /^no$/i.test(cfg.PermitRootLogin) && !cfg.PasswordAuthentication; } },
    ];
    return w;
  }

  // ---------------------------------------------------------------- faults (each: apply on the built world, fix commands for tests)
  const sed = (file, from, to) => `sudo sed -i 's#${from}#${to}#' ${file}`;
  function webFaults(w) {
    const b = w.server, site = w.site, conf = "/etc/nginx/conf.d/site.conf", F = [];
    const edit = (fn) => { const n = node(b, conf); n.data = fn(n.data); };
    const down = () => { Svc.stopUnit(b, "nginx"); };
    F.push({ id: "not-enabled", title: "nginx stopped and not enabled", ok: true,
      ticket: `After last night's reboot the ${site} site has been unreachable. Nothing was changed on the server.`,
      hints: ["Ask systemd: systemctl status nginx.", "Look at the Loaded line: is the service enabled to start at boot?", "One command can enable it and start it now (systemctl enable --now)."],
      why: "nginx was installed but never enabled, so after the reboot it stayed stopped. Fix: sudo systemctl enable --now nginx.",
      fix: [{ on: "server", cmd: "sudo systemctl enable --now nginx" }], apply() { down(); b.units.nginx.enabled = false; Sh.logSys(b, "nginx", "Stopped A high performance web server and a reverse proxy server."); } });
    F.push({ id: "fw-80", title: "firewall blocks port 80", ok: true,
      ticket: `Customers say http://${b.ip}/ hangs and times out. From the server itself the site loads.`,
      hints: ["Test from both machines: curl from the server works, curl from the client does not. Which layer sits between them?", "Run sudo ufw status and read the Action column.", "Port 80 is set to DENY. Allow it again with ufw."],
      why: "A ufw rule denies tcp/80, so requests from other hosts are dropped (the client sees a timeout) while local requests through the loopback still work. Fix: sudo ufw allow 80/tcp.",
      fix: [{ on: "server", cmd: "sudo ufw allow 80/tcp" }], apply() { const r = b.fw.rules.find((x) => x.port === "80"); r.action = "deny"; } });
    F.push({ id: "conf-semicolon", title: "nginx config syntax error", ok: true,
      ticket: `Someone edited the ${site} nginx config and restarted nginx. Now the site is down and nginx will not start.`,
      hints: ["systemctl status nginx shows the unit failed. Read the log lines at the bottom.", "Test the config without starting: sudo nginx -t. It names the file and line.", "A directive is missing its closing semicolon."],
      why: "The root directive lost its trailing semicolon, so nginx parses the next line as part of it and refuses to start. Fix the line, check with nginx -t, then start nginx.",
      fix: [{ on: "server", cmd: sed(conf, `root ${w.root}$`, `root ${w.root};`) }, { on: "server", cmd: "sudo nginx -t" }, { on: "server", cmd: "sudo systemctl start nginx" }], apply() { edit((t) => t.replace(`root ${w.root};`, `root ${w.root}`)); down(); Svc.startUnit(b, "nginx"); } });
    F.push({ id: "port-conflict", title: "another web server holds port 80", ok: true,
      ticket: `nginx will not start after an update. The status shows it failed. Customers see a default page instead of the ${site} site.`,
      hints: ["journalctl -u nginx shows why the start failed: look for 'Address already in use'.", "Find what listens on port 80: sudo ss -tlnp.", "Apache is running on port 80 and is enabled. Stop and disable it, then start nginx."],
      why: "apache2 was started by the update and took port 80, so nginx could not bind. Fix: sudo systemctl disable --now apache2, then sudo systemctl start nginx.",
      fix: [{ on: "server", cmd: "sudo systemctl disable --now apache2" }, { on: "server", cmd: "sudo systemctl start nginx" }], apply() { down(); b.units.apache2.enabled = true; Svc.startUnit(b, "apache2"); Svc.startUnit(b, "nginx"); } });
    F.push({ id: "perm-root", title: "web root not readable by nginx", ok: true,
      ticket: `The ${site} site answers with "403 Forbidden" for everybody since a permissions clean-up yesterday. nginx is running.`,
      hints: ["Confirm with curl -I http://localhost/ and read the status code.", "See the whole path's permissions: namei -l " + w.root + "/index.html. nginx runs as www-data.", "Test as that user: sudo -u www-data cat " + w.root + "/index.html. The directory has no access for others."],
      why: `The directory ${w.root} was changed to mode 700 owned by root, so the nginx worker (user www-data) cannot enter it. Fix: sudo chmod 755 ${w.root} (and make sure the owner is sensible).`,
      fix: [{ on: "server", cmd: `sudo chmod 755 ${w.root}` }], apply() { const d = b.fs[w.root]; d.mode = 0o700; d.owner = "root"; d.group = "root"; } });
    F.push({ id: "root-typo", title: "wrong document root in the config", ok: true,
      ticket: `After a config change the ${site} site shows "404 Not Found" on every page, but the files are there and nginx is running.`,
      hints: ["Does the directory named in the config exist? Compare grep root " + conf + " with ls /var/www.", "The path has a typo.", "After fixing the file, test and reload: sudo nginx -t, then sudo systemctl reload nginx."],
      why: `The root directive points to ${w.root}e (extra letter), which does not exist, so every request is a 404. Fix the path and reload nginx.`,
      fix: [{ on: "server", cmd: sed(conf, `root ${w.root}e;`, `root ${w.root};`) }, { on: "server", cmd: "sudo nginx -t" }, { on: "server", cmd: "sudo systemctl reload nginx" }], apply() { edit((t) => t.split(`root ${w.root};`).join(`root ${w.root}e;`)); if (b.units.nginx.inst) b.units.nginx.inst.model = Svc.nginxLoad(b); } });
    F.push({ id: "ssl-cert-path", title: "wrong certificate path", ok: true,
      ticket: `We renewed the certificate for ${site} and reloaded nginx. Now the whole site, http and https, is down.`,
      hints: ["systemctl status nginx and journalctl -u nginx --no-pager -n 20 show the failure.", "The error names a certificate file that cannot be opened. List the real files: ls /etc/ssl/" + site + ".", "The config says site.cert but the file is site.crt."],
      why: "ssl_certificate points to a file name with the wrong extension, so nginx cannot load it and fails to start. Fix the path, check with nginx -t and start nginx.",
      fix: [{ on: "server", cmd: sed(conf, "site.cert;", "site.crt;") }, { on: "server", cmd: "sudo nginx -t" }, { on: "server", cmd: "sudo systemctl start nginx" }], apply() { edit((t) => t.replace("site.crt;", "site.cert;")); down(); Svc.startUnit(b, "nginx"); } });
    F.push({ id: "disk-full", title: "disk full", ok: true,
      ticket: `The ${site} site went down overnight and nginx will not start again. The server was fine until the weekend.`,
      hints: ["The nginx log says 'No space left on device'. Check the disk: df -h.", "Find what is large: sudo du -h --max-depth=1 /var/log, then ls -lhS /var/log/nginx.", "An old rotated log fills the disk. Empty it with truncate (or delete it), then start nginx."],
      why: "A huge rotated log (/var/log/nginx/access.log.1) filled the disk, so nginx could not open its log files. Free the space (sudo truncate -s 0 or rm the file) and start nginx.",
      fix: [{ on: "server", cmd: "sudo truncate -s 0 /var/log/nginx/access.log.1" }, { on: "server", cmd: "sudo systemctl start nginx" }], apply() { addFile(b, "/var/log/nginx/access.log.1", "", { owner: "www-data", group: "adm", mode: 0o640, mb: b.disk.size - b.disk.base + 200 }); down(); Svc.startUnit(b, "nginx"); } });
    F.push({ id: "wrong-listen", title: "nginx listens on the wrong port", ok: true,
      ticket: `After a config change http://${b.ip}/ says "connection refused", yet systemctl says nginx is active.`,
      hints: ["What does nginx listen on? sudo ss -tlnp, compare with the config.", "grep listen " + conf, "The first server block listens on 8080. Set it back to 80 and reload."],
      why: "The http server block was changed to listen 8080, so nothing listens on port 80 any more. Fix the listen line and reload nginx.",
      fix: [{ on: "server", cmd: sed(conf, "listen 8080;", "listen 80;") }, { on: "server", cmd: "sudo nginx -t" }, { on: "server", cmd: "sudo systemctl reload nginx" }], apply() { edit((t) => t.replace("listen 80;", "listen 8080;")); if (b.units.nginx.inst) b.units.nginx.inst.model = Svc.nginxLoad(b); b.procs.filter((p) => p.unit === "nginx" && p.ports.length).forEach((p) => { p.ports = [8080, 443]; }); } });
    return F;
  }
  function appFaults(w) {
    const b = w.server, conf = "/etc/nginx/conf.d/site.conf", F = [], unit = "/etc/systemd/system/app.service", port = w.port;
    const setUnit = (fn) => { const n = node(b, unit); n.data = fn(n.data); };
    const restartApp = () => { Svc.stopUnit(b, "app"); Svc.startUnit(b, "app"); };
    F.push({ id: "proxy-port", title: "nginx proxies to the wrong port", ok: true,
      ticket: `The ${w.site} app page shows "502 Bad Gateway". The team says the app is running.`,
      hints: ["502 means nginx could not reach the app. Is the app up? systemctl status app.", "Which port does the app listen on (sudo ss -tlnp) and which one does nginx proxy to (grep proxy_pass " + conf + ")?", `They differ. Make proxy_pass use the app's port (${port}) and reload nginx.`],
      why: `nginx proxies to a different port from the one the app listens on (${port}). Fix proxy_pass and reload nginx.`,
      fix: [{ on: "server", cmd: sed(conf, `127.0.0.1:${port + 1}`, `127.0.0.1:${port}`) }, { on: "server", cmd: "sudo systemctl reload nginx" }], apply() { const n = node(b, conf); n.data = n.data.split(`127.0.0.1:${port}`).join(`127.0.0.1:${port + 1}`); if (b.units.nginx.inst) b.units.nginx.inst.model = Svc.nginxLoad(b); } });
    F.push({ id: "execstart-typo", title: "typo in ExecStart", ok: true,
      ticket: `The ${w.site} app is down after the last deploy. nginx returns 502.`,
      hints: ["systemctl status app: read the Active and log lines.", "status=203/EXEC means systemd could not run the ExecStart program. Print the unit: systemctl cat app, then list the real file with ls /opt/app/venv/bin.", "The program name is misspelled. After editing a unit run systemctl daemon-reload, then restart."],
      why: "ExecStart names /opt/app/venv/bin/gunicron (typo), so systemd fails with 203/EXEC. Fix the unit, run systemctl daemon-reload and restart the service.",
      fix: [{ on: "server", cmd: sed(unit, "gunicron", "gunicorn") }, { on: "server", cmd: "sudo systemctl daemon-reload" }, { on: "server", cmd: "sudo systemctl restart app" }], apply() { setUnit((t) => t.replace("bin/gunicorn", "bin/gunicron")); b.units.app.loaded = node(b, unit).data; restartApp(); } });
    F.push({ id: "envfile-path", title: "wrong EnvironmentFile path", ok: true,
      ticket: `After moving the app config, the ${w.site} app does not start (502 from nginx).`,
      hints: ["systemctl status app and journalctl -u app show 'Failed to load environment files'.", "Compare the path in systemctl cat app with ls /etc/app.", "The unit says app.envv. Fix it, daemon-reload and restart."],
      why: "EnvironmentFile points to /etc/app/app.envv, which does not exist. Fix the path, run systemctl daemon-reload and restart.",
      fix: [{ on: "server", cmd: sed(unit, "app.envv", "app.env") }, { on: "server", cmd: "sudo systemctl daemon-reload" }, { on: "server", cmd: "sudo systemctl restart app" }], apply() { setUnit((t) => t.replace("app.env", "app.envv")); b.units.app.loaded = node(b, unit).data; restartApp(); } });
    F.push({ id: "app-user", title: "unit runs as a user that does not exist", ok: true,
      ticket: `The ${w.site} app stopped after a unit file change. nginx shows 502.`,
      hints: ["systemctl status app shows status=217/USER.", "Check the unit: systemctl cat app. Which User= does it name? Does it exist? id appuser, id <name>.", "The User line has a typo (appusr). Fix it, daemon-reload and restart."],
      why: "The unit says User=appusr, which does not exist (217/USER). Fix the user name, daemon-reload and restart.",
      fix: [{ on: "server", cmd: sed(unit, "User=appusr", "User=appuser") }, { on: "server", cmd: "sudo systemctl daemon-reload" }, { on: "server", cmd: "sudo systemctl restart app" }], apply() { setUnit((t) => t.replace("User=appuser", "User=appusr")); b.units.app.loaded = node(b, unit).data; restartApp(); } });
    F.push({ id: "env-missing", title: "required setting missing from the env file", ok: true,
      ticket: `The ${w.site} app keeps failing right after start since the config was regenerated. nginx shows 502.`,
      hints: ["journalctl -u app shows a Python traceback. Read the last line.", "KeyError means the app expects a variable. Compare with the file: sudo cat /etc/app/app.env.", "DATABASE_URL is missing. Add it back (for example with tee -a) and restart. The value was postgresql://" + w.site + ":secret@10.0.0.50/" + w.site + "."],
      why: "The regenerated /etc/app/app.env lost DATABASE_URL, which the app requires at start-up (KeyError). Add the line and restart the service.",
      fix: [{ on: "server", cmd: `echo 'DATABASE_URL=postgresql://${w.site}:secret@10.0.0.50/${w.site}' | sudo tee -a /etc/app/app.env` }, { on: "server", cmd: "sudo systemctl restart app" }], apply() { node(b, "/etc/app/app.env").data = "LOG_LEVEL=info\n"; restartApp(); } });
    F.push({ id: "log-perm", title: "app cannot write its log directory", ok: true,
      ticket: `The ${w.site} app crashes at start-up after the log directory was recreated by a script. nginx shows 502.`,
      hints: ["journalctl -u app: the traceback ends with PermissionError.", "Who owns the log directory and what is the app's user? ls -ld /var/log/app and systemctl cat app.", "Give the app user ownership: sudo chown appuser:appuser /var/log/app, then restart."],
      why: "/var/log/app is owned by root with mode 755, so the app (appuser) cannot create its log file. Fix: sudo chown appuser /var/log/app and restart.",
      fix: [{ on: "server", cmd: "sudo chown appuser:appuser /var/log/app" }, { on: "server", cmd: "sudo systemctl restart app" }], apply() { const d = b.fs["/var/log/app"]; d.owner = "root"; d.group = "root"; d.mode = 0o755; restartApp(); } });
    F.push({ id: "unit-reload", title: "unit file fixed but not reloaded", ok: true,
      ticket: `A colleague says they fixed the ${w.site} app's service file, but the app is still down and nginx shows 502.`,
      hints: ["systemctl status app: read the top lines, there is a warning about the unit file.", "systemd keeps the old unit in memory until you tell it to re-read the files.", "Run sudo systemctl daemon-reload, then restart the app."],
      why: "The file on disk is correct, but systemd still runs the old (broken) definition it loaded earlier. Fix: sudo systemctl daemon-reload and sudo systemctl restart app.",
      fix: [{ on: "server", cmd: "sudo systemctl daemon-reload" }, { on: "server", cmd: "sudo systemctl restart app" }], apply() { const good = node(b, unit).data; b.units.app.loaded = good.replace("bin/gunicorn", "bin/gunicron"); restartApp(); } });
    F.push({ id: "disk-full", title: "disk full", ok: true,
      ticket: `The ${w.site} app crashed overnight and will not start again. nginx shows 502.`,
      hints: ["journalctl -u app: the last line says 'No space left on device'. Check df -h.", "Find the big file: sudo du -h --max-depth=1 /var/log, then ls -lhS /var/log/app.", "Empty the huge debug log with truncate (or delete it) and restart the app."],
      why: "An enormous debug log (/var/log/app/debug.log) filled the disk, so the app cannot open its log file. Free the space and restart the app.",
      fix: [{ on: "server", cmd: "sudo truncate -s 0 /var/log/app/debug.log" }, { on: "server", cmd: "sudo systemctl restart app" }], apply() { addFile(b, "/var/log/app/debug.log", "", { owner: "appuser", mode: 0o644, mb: b.disk.size - b.disk.base + 200 }); restartApp(); } });
    return F;
  }
  function sshFaults(w) {
    const b = w.server, c = w.client, cfgf = "/etc/ssh/sshd_config", F = [];
    const edit = (fn) => { const n = node(b, cfgf); n.data = fn(n.data); };
    const reread = () => { const u = b.units.ssh; if (u.active === "active") { const cfg = Svc.sshConfig(b); u.inst.cfg = cfg; b.procs.filter((p) => p.unit === "ssh").forEach((p) => { p.ports = [cfg.Port]; }); } };
    F.push({ id: "sshd-down", title: "sshd stopped", ok: true,
      ticket: `Nobody can log in to ${b.name} over SSH since this morning. The error from the client is "connection refused".`,
      hints: ["Connection refused means nothing is listening. Check the service: systemctl status ssh.", "Is it enabled as well as running?", "sudo systemctl enable --now ssh."],
      why: "sshd was stopped and disabled, so nothing listens on port 22 (connection refused). Fix: sudo systemctl enable --now ssh.",
      fix: [{ on: "server", cmd: "sudo systemctl enable --now ssh" }], apply() { Svc.stopUnit(b, "ssh"); b.units.ssh.enabled = false; } });
    F.push({ id: "fw-ssh", title: "firewall blocks port 22", ok: true,
      ticket: `SSH to ${b.name} from the client hangs and then says "Connection timed out". Other services on the server work.`,
      hints: ["A timeout (not 'refused') usually means a firewall drops the packets.", "sudo ufw status: is 22/tcp listed?", "Allow it: sudo ufw allow 22/tcp."],
      why: "The ufw rule for tcp/22 is gone, so SSH packets are dropped and the client times out. Fix: sudo ufw allow 22/tcp.",
      fix: [{ on: "server", cmd: "sudo ufw allow 22/tcp" }], apply() { b.fw.rules = b.fw.rules.filter((r) => r.port !== "22"); } });
    F.push({ id: "port-changed", title: "sshd moved to another port", ok: true,
      ticket: `SSH to ${b.name} says "Connection refused" since a hardening script ran. The service is running.`,
      hints: ["The service is active but refuses port 22. Which port does it listen on? sudo ss -tlnp.", "grep -i ^Port /etc/ssh/sshd_config.", "The team's documented port is 22. Set it back and restart ssh (the firewall only allows 22)."],
      why: "The hardening script changed Port to 2222. The firewall and the documentation use 22. Fix: set Port 22 in sshd_config and restart ssh.",
      fix: [{ on: "server", cmd: sed(cfgf, "^Port 2222", "Port 22") }, { on: "server", cmd: "sudo sshd -t" }, { on: "server", cmd: "sudo systemctl restart ssh" }], apply() { edit((t) => t.replace("Port 22", "Port 2222")); Svc.stopUnit(b, "ssh"); Svc.startUnit(b, "ssh"); } });
    F.push({ id: "allowusers", title: "deploy not in AllowUsers", ok: true,
      ticket: `The deploy user cannot log in to ${b.name} any more ("Permission denied (publickey)"), although nothing changed on its key.`,
      hints: ["Read the server's SSH log: journalctl -u ssh -n 20.", "The log names the reason: the user is not allowed.", "AllowUsers must list deploy. Edit sshd_config and reload ssh."],
      why: "AllowUsers was reduced to admin only, so sshd rejects deploy before looking at keys. Fix: AllowUsers deploy admin, then reload ssh.",
      fix: [{ on: "server", cmd: sed(cfgf, "^AllowUsers.*", "AllowUsers deploy admin") }, { on: "server", cmd: "sudo systemctl reload ssh" }], apply() { edit((t) => t.replace("AllowUsers deploy admin", "AllowUsers admin")); reread(); } });
    F.push({ id: "config-typo", title: "typo in sshd_config", ok: true,
      ticket: `After editing sshd_config and restarting, ${b.name} no longer accepts SSH connections.`,
      hints: ["systemctl status ssh shows the unit failed.", "Test the config: sudo sshd -t. It prints the line number.", "A keyword is misspelled (PasswordAuthenticaton). Fix it and start ssh."],
      why: "PasswordAuthentication was misspelled, so sshd rejects the config and refuses to start. Fix the keyword, check with sshd -t and start ssh.",
      fix: [{ on: "server", cmd: sed(cfgf, "PasswordAuthenticaton", "PasswordAuthentication") }, { on: "server", cmd: "sudo sshd -t" }, { on: "server", cmd: "sudo systemctl start ssh" }], apply() { edit((t) => t.replace("PasswordAuthentication", "PasswordAuthenticaton")); Svc.stopUnit(b, "ssh"); Svc.startUnit(b, "ssh"); } });
    F.push({ id: "id-perm", title: "private key permissions too open (client)", ok: true,
      ticket: `From the client, SSH to ${b.name} suddenly complains about the private key and refuses to use it.`,
      hints: ["Read the whole message printed by ssh on the client.", "ls -l ~/.ssh on the client: compare the key's mode with what ssh asks for.", "A private key must be readable by its owner only: chmod 600 ~/.ssh/id_ed25519 (on the client)."],
      why: "The client's private key was made group/world readable (mode 644), so ssh ignores it. Fix on the client: chmod 600 ~/.ssh/id_ed25519.",
      fix: [{ on: "client", cmd: "chmod 600 ~/.ssh/id_ed25519" }], apply() { node(c, "/home/admin/.ssh/id_ed25519").mode = 0o644; } });
    F.push({ id: "pubkey-off", title: "public key login disabled", ok: true,
      ticket: `The deploy user gets "Permission denied (publickey)" on ${b.name}. The key and the file permissions were checked and are fine.`,
      hints: ["Read the server log: journalctl -u ssh -n 20.", "The log says public key authentication is disabled. Look at the settings: grep -i pubkey /etc/ssh/sshd_config.", "Set PubkeyAuthentication yes and reload ssh."],
      why: "PubkeyAuthentication was set to no, so sshd ignores keys. Fix: set it to yes and reload ssh.",
      fix: [{ on: "server", cmd: sed(cfgf, "PubkeyAuthentication no", "PubkeyAuthentication yes") }, { on: "server", cmd: "sudo systemctl reload ssh" }], apply() { edit((t) => t.replace("PubkeyAuthentication yes", "PubkeyAuthentication no")); reread(); } });
    F.push({ id: "authkeys-perm", title: "authorized_keys permissions", ok: true,
      ticket: `Key login for deploy on ${b.name} fails with "Permission denied (publickey)" after someone ran a recursive chmod.`,
      hints: ["journalctl -u ssh -n 20 on the server: read the 'Authentication refused' line.", "sshd (StrictModes) refuses key files others can write. ls -l /home/deploy/.ssh.", "authorized_keys should be 600 (or 644) and owned by deploy: sudo chmod 600 /home/deploy/.ssh/authorized_keys."],
      why: "authorized_keys became writable by everyone (mode 666), and StrictModes makes sshd refuse it. Fix: sudo chmod 600 /home/deploy/.ssh/authorized_keys.",
      fix: [{ on: "server", cmd: "sudo chmod 600 /home/deploy/.ssh/authorized_keys" }], apply() { node(b, "/home/deploy/.ssh/authorized_keys").mode = 0o666; } });
    F.push({ id: "home-perm", title: "home directory too open", ok: true,
      ticket: `deploy cannot log in with its key on ${b.name} since a permissions "fix" on /home. The key itself is correct.`,
      hints: ["journalctl -u ssh -n 20: which path does the 'Authentication refused' line name?", "ls -ld /home/deploy: others can write to the home directory.", "Remove group and other write: sudo chmod 755 /home/deploy."],
      why: "/home/deploy was set to 777, and StrictModes refuses keys when the home directory is writable by others. Fix: sudo chmod 755 /home/deploy.",
      fix: [{ on: "server", cmd: "sudo chmod 755 /home/deploy" }], apply() { b.fs["/home/deploy"].mode = 0o777; } });
    F.push({ id: "wrong-key", title: "wrong key in authorized_keys", ok: true,
      ticket: `The client was rebuilt and got a new key. Logging in as deploy on ${b.name} now fails with "Permission denied (publickey)".`,
      hints: ["The server log shows 'Failed publickey' and the key fingerprint.", "Compare keys: on the client cat ~/.ssh/id_ed25519.pub, on the server sudo cat /home/deploy/.ssh/authorized_keys.", "The server has the old key. Put the client's public key into authorized_keys (echo '<key>' | sudo tee /home/deploy/.ssh/authorized_keys)."],
      why: "authorized_keys still holds the old key of the rebuilt client. Replace it with the client's new public key (keep the file mode 600).",
      fix: [{ on: "server", cmd: "echo '{PUB}' | sudo tee /home/deploy/.ssh/authorized_keys" }], apply() { node(b, "/home/deploy/.ssh/authorized_keys").data = w.otherPub + "\n"; } });
    return F;
  }
  const SC = {
    web: { title: "Web server down or wrong", area: "Linux services", build: webWorld, faults: webFaults },
    app: { title: "Application behind nginx", area: "Linux services", build: appWorld, faults: appFaults },
    ssh: { title: "SSH access problem", area: "Linux access", build: sshWorld, faults: sshFaults },
  };
  const CATALOG = Object.keys(SC).map((id) => ({ id, title: SC[id].title, area: SC[id].area, faults: Object.keys(TIERS[id]) }));

  // fixes for two faults: edits first, then config checks, then start/restart, then reloads
  function orderFix(steps) {
    const rank = (c) => (/systemctl reload/.test(c) ? 5 : /systemctl (start|restart|enable)/.test(c) ? 4 : /daemon-reload/.test(c) ? 3 : /(nginx|sshd) -t/.test(c) ? 2 : 1), seen = {}, out = [];
    steps.forEach((x, i) => { const k = x.on + "|" + x.cmd; if (!seen[k]) { seen[k] = 1; out.push({ x, i }); } });
    return out.sort((p, q) => rank(p.x.cmd) - rank(q.x.cmd) || p.i - q.i).map((o) => o.x);
  }
  function pickFault(rnd, list, o) { const ok = list.filter((f) => !o || !o.fault || f.id === o.fault); const f = ok[Math.floor(rnd() * ok.length)] || list[0]; f.all = list; return f; }
  function make(scenario, seed, opts, broken) {
    const sc = SC[scenario], rnd = rngOf(seed), w = sc.build(rnd), list = sc.faults(w), f = pickFault(rnd, list, opts || {});
    let fault = f;
    if (opts && opts.double) {
      const pool = list.filter((x) => x.id !== f.id), r2 = rngOf(seed * 31 + 17); for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r2() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      const g = (opts.fault2 && pool.find((x) => x.id === opts.fault2)) || pool[0], hs = []; for (let i = 0; i < 3; i++) { if (f.hints[i]) hs.push(f.hints[i]); if (g.hints[i]) hs.push(g.hints[i]); }
      fault = { id: f.id + "+" + g.id, title: f.title + " and " + g.title, ticket: "Two separate problems were reported. (1) " + f.ticket + " (2) " + g.ticket, hints: hs, why: f.why + " Second fault: " + g.why, fix: orderFix(f.fix.concat(g.fix)), apply() { f.apply(); g.apply(); } };
    }
    if (broken) fault.apply();
    return { w, fault };
  }
  function create(scenario, seed, opts) {
    if (!SC[scenario]) throw new Error("unknown scenario " + scenario);
    const h = make(scenario, seed, opts, false), f = make(scenario, seed, opts, true), w = f.w;
    const lab = { scenario, seed, opts: opts || {}, title: SC[scenario].title, area: SC[scenario].area, kind: "linux", vendors: ["linux"], server: w.server, client: w.client, ctx: w, faultId: f.fault.id, faultTitle: f.fault.title, ticket: f.fault.ticket, hints: f.fault.hints, why: f.fault.why, fix: f.fault.fix, pub: w.pub, used: 0, cmds: 0, solved: false, healthy: h.w, checks: w.checks,
      intro: `The server is ${w.server.name} (${w.server.ip}). The Server terminal is logged in as ${w.server.user} with sudo. The Client terminal is another machine on the same network: use it to test the way users do.` };
    lab.broken = verify(lab).problems; return lab;
  }
  function verify(lab) { const problems = lab.checks.filter((c) => { try { return !c.ok(); } catch (e) { return true; } }).map((c) => c.label); return { solved: problems.length === 0, problems, total: lab.checks.length }; }
  function reference(lab) { const h = lab.healthy; lab.server = h.server; lab.client = h.client; lab.ctx = h; lab.checks = h.checks; return lab; }
  const score = (lab) => Math.max(0, 100 - 15 * (lab.used || 0) - Math.min(30, Math.max(0, (lab.cmds || 0) - 30)));
  function serialise(lab) { return { scenario: lab.scenario, seed: lab.seed, opts: lab.opts, server: lab.server, client: lab.client, used: lab.used, cmds: lab.cmds, solved: lab.solved }; }
  function restore(s) { const lab = create(s.scenario, s.seed, s.opts); lab.server = s.server; lab.client = s.client; Svc.link(lab.server, lab.client); lab.used = s.used || 0; lab.cmds = s.cmds || 0; lab.solved = !!s.solved; const w = lab.ctx; w.server = lab.server; w.client = lab.client; lab.checks = rebind(lab); return lab; }
  // checks close over the original boxes; rebuild them against the restored ones
  function rebind(lab) { const w = { site: lab.ctx.site, domain: lab.ctx.domain, marker: lab.ctx.marker, root: lab.ctx.root, port: lab.ctx.port, server: lab.server, client: lab.client, pub: lab.ctx.pub, otherPub: lab.ctx.otherPub }; return SC_CHECKS[lab.scenario](w); }
  const SC_CHECKS = {
    web: (w) => { const b = w.server; return [{ id: "run", label: "nginx is running", ok: () => b.units.nginx.active === "active" }, { id: "boot", label: "nginx starts at boot", ok: () => b.units.nginx.enabled }, { id: "http", label: `http://${b.ip}/ shows the site from the client`, ok: () => { const r = Svc.request(w.client, b.ip, 80, "/"); return !r.err && r.status === 200 && r.body.indexOf(w.marker) >= 0; } }, { id: "https", label: `https://${b.ip}/ shows the site from the client`, ok: () => { const r = Svc.request(w.client, b.ip, 443, "/"); return !r.err && r.status === 200 && r.body.indexOf(w.marker) >= 0; } }]; },
    app: (w) => { const b = w.server; return [{ id: "nginx", label: "nginx is running", ok: () => b.units.nginx.active === "active" }, { id: "app", label: "the app service is running", ok: () => b.units.app.active === "active" }, { id: "boot", label: "the app starts at boot", ok: () => b.units.app.enabled }, { id: "http", label: `http://${b.ip}/ returns the app's page from the client`, ok: () => { const r = Svc.request(w.client, b.ip, 80, "/"); return !r.err && r.status === 200 && r.body.indexOf(w.marker) >= 0; } }]; },
    ssh: (w) => { const b = w.server; return [{ id: "run", label: "sshd is running", ok: () => b.units.ssh.active === "active" }, { id: "boot", label: "sshd starts at boot", ok: () => b.units.ssh.enabled }, { id: "login", label: `ssh deploy@${b.ip} works from the client with its key`, ok: () => !!Svc.sshLogin(w.client, b, "deploy", 22, null).ok }, { id: "hard", label: "hardening is kept (no root login, no password login)", ok: () => { const u = b.units.ssh, cfg = Svc.sshConfig(b); return !(u.inst && u.inst.cfg && (!/^no$/i.test(u.inst.cfg.PermitRootLogin) || u.inst.cfg.PasswordAuthentication)) && /^no$/i.test(cfg.PermitRootLogin) && !cfg.PasswordAuthentication; } }]; },
  };
  function describe(lab) { return { title: lab.title, intro: lab.intro, ticket: lab.ticket }; }

  const api = { TIERS, NAMES, CATALOG, create, verify, reference, score, serialise, restore, describe, rngOf, SC };
  root.Linuxlabs = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
