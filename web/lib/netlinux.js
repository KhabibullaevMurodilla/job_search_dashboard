/* Netlinux: a Linux host or router shell (iproute2 and a few friends). */
(function (root) {
  "use strict";
  const C = root.Netcli || require("./netcli.js");
  const IOS = root.Netios || require("./netios.js");
  const { N, pad, Session } = C;
  const { n2ip, ip2n, netOf, lenMask } = N;

  const flagsOf = (R, d, i) => (i.loopback ? "LOOPBACK," : "BROADCAST,MULTICAST,") + (i.shutdown ? "" : "UP,LOWER_UP").replace(/,$/, "");
  const state = (R, d, i) => (i.shutdown ? "DOWN" : R.line[d][i.name] || i.loopback ? "UP" : "DOWN");
  const mac = (d, n) => IOS.mac(d + n).replace(/\./g, ":").slice(0, 17);
  function addrShow(c, only, brief) {
    const { D, R, d } = c, L = []; let k = 1;
    const names = D.order.filter((n) => !only || n === only);
    if (only && !names.length) return `Device "${only}" does not exist.`;
    for (const nm of names) { const i = D.ifs[nm], st = state(R, d, i);
      if (brief) { L.push(`${pad(nm, 16)} ${pad(st, 14)} ${i.ip ? i.ip.addr + "/" + i.ip.len : ""}`.trimEnd()); continue; }
      L.push(`${k++}: ${nm}: <${flagsOf(R, d, i)}> mtu ${i.loopback ? 65536 : i.mtu} qdisc ${i.loopback ? "noqueue" : "fq_codel"} state ${st === "UP" ? (i.loopback ? "UNKNOWN" : "UP") : "DOWN"} group default qlen 1000`);
      L.push(`    link/${i.loopback ? "loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00" : "ether " + mac(d, nm) + " brd ff:ff:ff:ff:ff:ff"}`);
      if (i.ip) L.push(`    inet ${i.ip.addr}/${i.ip.len} ${i.loopback ? "scope host" : "brd " + n2ip((ip2n(i.ip.addr) | ~lenMask(i.ip.len)) >>> 0) + " scope global"} ${nm}`, "       valid_lft forever preferred_lft forever"); }
    return L.join("\n");
  }
  function routes(c) {
    const { D, R, d } = c, L = [];
    for (const s of D.statics) { const via = R.rib[d].find((r) => r.proto === "S" && r.pfx === ip2n(s.pfx) && r.len === s.len); if (!via) continue; const out = via.ifc; L.push(`${s.len === 0 ? "default" : s.pfx + "/" + s.len} via ${s.nh} dev ${out}${s.ad && s.ad !== 1 ? " metric " + s.ad : ""}`); }
    for (const nm of D.order) { const i = D.ifs[nm]; if (i.ip && state(R, d, i) === "UP" && !i.loopback) L.push(`${n2ip(netOf(i.ip.addr, i.ip.len))}/${i.ip.len} dev ${nm} proto kernel scope link src ${i.ip.addr}`); }
    return L.sort((a, b) => (a.startsWith("default") ? -1 : b.startsWith("default") ? 1 : 0)).join("\n");
  }
  const parseDst = (x) => x === "default" ? { ip: "0.0.0.0", len: 0 } : (N.cidr(x) || (ip2n(x) !== null ? { ip: x, len: 32 } : null));
  Session.prototype.runLinux = function (line) {
    const s = this, D = s.d(), prompt = `${D.hostname}:~$ `; s.cmds++; s.history.push(line);
    const text = line.trim(); if (!text) return { out: "", prompt };
    let w = text.split(/\s+/), sudo = false; if (w[0] === "sudo") { sudo = true; w = w.slice(1); }
    const cmd = w[0], R = () => s.R(), c = { s, D, d: s.dev, net: s.net, get R() { return R(); } };
    const priv = (f) => (sudo || s.root ? f() : "RTNETLINK answers: Operation not permitted");
    const o = (out) => ({ out, prompt });
    if (cmd === "exit" || cmd === "logout") return { out: "logout", prompt, exit: true };
    if (cmd === "hostname") return o(D.hostname);
    if (cmd === "whoami") return o(sudo ? "root" : "admin");
    if (cmd === "uname") return o(w[1] === "-a" ? `Linux ${D.hostname} 6.1.0-18-amd64 #1 SMP PREEMPT_DYNAMIC Debian x86_64 GNU/Linux` : "Linux");
    if (cmd === "clear") return o("");
    if (cmd === "ip") {
      let a = w.slice(1), brief = false; if (a[0] === "-br" || a[0] === "-brief") { brief = true; a = a.slice(1); } if (a[0] === "-4") a = a.slice(1);
      const obj = a[0] || "", verb = a[1] || "show", has = (x) => ("address".startsWith(obj) && obj) && x;
      if (/^a(ddr(ess)?)?$/.test(obj)) {
        if (verb === "show" || verb === "list" || verb === "ls" || !a[1]) { const dev = a[a.indexOf("dev") + 1] || (a[2] && a[2] !== "dev" ? a[2] : null); return o(addrShow(c, a.includes("dev") ? a[a.indexOf("dev") + 1] : (a[2] || null), brief)); }
        if (verb === "add" || verb === "del") return o(priv(() => { const cd = N.cidr(a[2]), dv = a[a.indexOf("dev") + 1], I = D.ifs[dv]; if (!cd) return "Error: any valid prefix is expected rather than \"" + a[2] + "\"."; if (!I) return `Cannot find device "${dv}"`; if (verb === "add") { if (I.ip && !I.loopback) return "RTNETLINK answers: File exists"; I.ip = { addr: cd.ip, len: cd.len }; } else { if (!I.ip || I.ip.addr !== cd.ip) return "RTNETLINK answers: Cannot assign requested address"; I.ip = null; } s.touch(); return ""; }));
        return o("Command \"" + a[1] + "\" is unknown, try \"ip address help\".");
      }
      if (/^l(ink)?$/.test(obj)) {
        if (verb === "show" || !a[1]) return o(addrShow(c, a[2] || null, brief).split("\n").filter((l) => !/^\s+inet|valid_lft/.test(l)).join("\n"));
        if (verb === "set") return o(priv(() => { const dv = a[2], I = D.ifs[dv]; if (!I) return `Cannot find device "${dv}"`; const k = a.indexOf("up") >= 0 ? "up" : a.indexOf("down") >= 0 ? "down" : null; if (k) I.shutdown = k === "down"; const m = a.indexOf("mtu"); if (m >= 0) I.mtu = +a[m + 1]; s.touch(); return ""; }));
      }
      if (/^r(oute)?$/.test(obj)) {
        if (verb === "show" || verb === "list" || !a[1]) return o(routes(c));
        if (verb === "get") { const r = N.ping(R(), s.dev, a[2], {}); return o(r.ok || (r.hops && r.hops.length) ? `${a[2]} via ... dev ...` : "RTNETLINK answers: Network is unreachable"); }
        if (verb === "add" || verb === "del" || verb === "replace") return o(priv(() => { const dst = parseDst(a[2]); if (!dst) return "Error: inet prefix is expected rather than \"" + a[2] + "\"."; const vi = a.indexOf("via"); const key = (x) => x.pfx === n2ip(netOf(dst.ip, dst.len)) && x.len === dst.len; if (verb === "del") { const n = D.statics.length; D.statics = D.statics.filter((x) => !key(x)); if (D.statics.length === n) return "RTNETLINK answers: No such process"; s.touch(); return ""; } if (vi < 0) return "Error: either \"to\" is duplicate, or \"" + (a[3] || "") + "\" is a garbage."; const nh = a[vi + 1]; if (ip2n(nh) === null) return "Error: inet address is expected rather than \"" + nh + "\"."; const reach = D.order.some((nm) => D.ifs[nm].ip && !D.ifs[nm].shutdown && N.inNet(nh, D.ifs[nm].ip.addr, D.ifs[nm].ip.len)); if (!reach) return "Error: Nexthop has invalid gateway."; if (D.statics.some(key)) { if (verb === "add") return "RTNETLINK answers: File exists"; D.statics = D.statics.filter((x) => !key(x)); } const mt = a.indexOf("metric"); D.statics.push({ pfx: n2ip(netOf(dst.ip, dst.len)), len: dst.len, nh, ad: mt >= 0 ? +a[mt + 1] : 1 }); s.touch(); return ""; }));
      }
      if (/^n(eigh(bou?r)?)?$/.test(obj)) { const L = []; const Rr = R(); for (const x of Rr.att) { if (x.dev !== s.dev) continue; for (const y of Rr.att) if (y.dev !== s.dev && y.seg === x.seg && N.inNet(y.ip, x.ip, x.len)) L.push(`${y.ip} dev ${x.ifc} lladdr ${mac(y.dev, y.ifc)} REACHABLE`); } return o(L.join("\n")); }
      return o(`Object "${obj}" is unknown, try "ip help".`);
    }
    if (cmd === "ifconfig") return o(D.order.map((nm) => { const i = D.ifs[nm]; return `${nm}: flags=${i.shutdown ? 4098 : 4163}<${flagsOf(R(), s.dev, i)}>  mtu ${i.mtu}\n        ${i.ip ? `inet ${i.ip.addr}  netmask ${C.maskOf(i.ip.len)}` : ""}`; }).join("\n\n"));
    if (cmd === "route" || cmd === "netstat" && w[1] === "-rn") return o(routes(c));
    if (cmd === "arp") return o(runIp("neigh"));
    if (cmd === "ping") { let t = null, src = null, cnt = 4; for (let k = 1; k < w.length; k++) { if (w[k] === "-c") cnt = +w[++k] || 4; else if (w[k] === "-I") src = w[++k]; else if (!w[k].startsWith("-")) t = w[k]; } if (!t) return o("ping: usage error: Destination address required"); return o(IOS.reachText("linux", R(), s.dev, t, src, cnt)); }
    if (cmd === "traceroute" || cmd === "tracepath") { const t = w.find((x, k) => k > 0 && !x.startsWith("-")); if (!t) return o("Specify \"host\" missing argument."); return o(IOS.traceText("linux", R(), s.dev, t)); }
    if (cmd === "ss" || cmd === "netstat") return o("State   Recv-Q  Send-Q   Local Address:Port    Peer Address:Port\nLISTEN  0       128            0.0.0.0:22           0.0.0.0:*");
    if (cmd === "sysctl") { const k = w[1]; if (k === "net.ipv4.ip_forward") return o("net.ipv4.ip_forward = " + (D.forwarding === false ? 0 : 1)); return o(`sysctl: cannot stat /proc/sys/${(k || "").replace(/\./g, "/")}: No such file or directory`); }
    if (cmd === "cat" && w[1] === "/etc/hostname") return o(D.hostname);
    return o(`bash: ${cmd}: command not found`);
    function runIp(x) { return s.runLinux("ip " + x).out; }
  };
  const api = {};
  root.Netlinux = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
