/* Netcli: command lines over the Netsim model. Cisco IOS-XE, Cisco NX-OS and
   Arista EOS share one engine with per-vendor differences in names, show
   output and a few commands. Linux has its own small shell. Junos lives in
   netjunos.js. Every command reads or changes the same model, so a fix made
   on one device really changes what every other device sees. */
(function (root) {
  "use strict";
  const N = root.Netsim || (typeof require !== "undefined" ? require("./netsim.js") : null);
  const { ip2n, n2ip, lenMask, maskLen, wildLen, netOf, inNet } = N;
  const pad = (s, n) => { s = String(s); return s.length >= n ? s + " " : s + " ".repeat(n - s.length); };
  const padL = (s, n) => { s = String(s); return s.length >= n ? s : " ".repeat(n - s.length) + s; };
  const hash = (s) => { let h = 5381; s = String(s); for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h; };
  const upt = (k) => { const h = hash(k); return "00:" + String(5 + (h % 50)).padStart(2, "0") + ":" + String(h % 60).padStart(2, "0"); };
  const maskOf = (l) => n2ip(lenMask(l));

  // ------------------------------------------------------------ interface names
  const IFPREFIX = { gi: "GigabitEthernet", gig: "GigabitEthernet", te: "TenGigabitEthernet", eth: "Ethernet", et: "Ethernet", lo: "Loopback", vl: "Vlan", po: "Port-Channel", fa: "FastEthernet", mgmt: "Management" };
  function resolveIf(dev, tok) {
    const t = String(tok || "").toLowerCase().replace(/\s+/g, ""); if (!t) return null;
    for (const nm of dev.order) if (nm.toLowerCase() === t) return nm;
    const m = t.match(/^([a-z-]+)(.*)$/); if (!m) return null;
    for (const nm of dev.order) { const q = nm.toLowerCase().match(/^([a-z-]+)(.*)$/); if (q && q[2] === m[2] && q[1].startsWith(m[1]) && m[1].length >= 2) return nm; }
    return null;
  }
  const short = (nm) => nm.replace("GigabitEthernet", "Gi").replace("TenGigabitEthernet", "Te").replace("Ethernet", "Eth").replace("Loopback", "Lo").replace("FastEthernet", "Fa");

  // ------------------------------------------------------------ command engine
  // A table entry: {p: "show ip route <prefix?>", modes:[...], run(ctx, a)}
  // <x> takes one word, <x...> the rest, <x?> an optional word.
  function compile(table) { return table.map((e) => Object.assign({ toks: e.p.split(/\s+/) }, e)); }
  function matchEntry(e, words) {
    let i = 0, exact = 0; const a = {};
    for (let k = 0; k < e.toks.length; k++) {
      const t = e.toks[k], m = t.match(/^<(\w+)(\.\.\.|\?)?>$/);
      if (m) { if (m[2] === "...") { if (i >= words.length) return { fail: i, incomplete: true }; a[m[1]] = words.slice(i).join(" "); i = words.length; continue; } if (m[2] === "?") { if (i < words.length) a[m[1]] = words[i++]; continue; } if (i >= words.length) return { fail: i, incomplete: true }; a[m[1]] = words[i++]; continue; }
      if (i >= words.length) return { fail: i, incomplete: true };
      const w = words[i].toLowerCase(), alts = t.split("|");
      if (alts.indexOf(w) >= 0) exact++; else if (!alts.some((x) => x.startsWith(w))) return { fail: i };
      i++;
    }
    if (i < words.length) return { fail: i };
    return { ok: true, a, exact, lits: e.toks.filter((x) => !/^<.*>$/.test(x)).length };
  }
  function dispatch(tbl, modes, words, promptLen, style) {
    const cand = tbl.filter((e) => !e.modes || e.modes.some((m) => modes.indexOf(m) >= 0));
    let hits = [], deepest = 0, incomplete = false;
    for (const e of cand) { const r = matchEntry(e, words); if (r.ok) hits.push({ e, r }); else { if (r.fail > deepest || (r.fail === deepest && r.incomplete)) { deepest = r.fail; incomplete = !!r.incomplete && r.fail >= words.length; } if (r.incomplete && r.fail >= words.length) incomplete = true; } }
    if (hits.length) {
      hits.sort((x, y) => y.r.exact - x.r.exact || y.r.lits - x.r.lits);
      if (hits.length > 1 && hits[0].r.exact === hits[1].r.exact && hits[0].r.lits === hits[1].r.lits && hits[0].e.p !== hits[1].e.p && !hits.every((h) => h.e.run === hits[0].e.run)) { const t = hits[0].e.toks; const w = words.join(" "); return { ambiguous: w }; }
      return { hit: hits[0] };
    }
    return { fail: deepest, incomplete: incomplete && deepest >= words.length };
  }
  function caretErr(style, prompt, line, words, idx) {
    let col = 0; const parts = line.trim().split(/\s+/); let pos = 0; const raw = line.replace(/^\s+/, "");
    let at = 0; for (let k = 0; k < idx; k++) { at = raw.indexOf(parts[k], at) + parts[k].length; }
    const start = raw.indexOf(parts[idx], at); col = prompt.length + (start < 0 ? 0 : start);
    const marker = " ".repeat(col) + "^";
    if (style === "eos") return "% Invalid input";
    if (style === "nxos") return marker + "\n% Invalid command at '^' marker.";
    return marker + "\n% Invalid input detected at '^' marker.";
  }

  // ------------------------------------------------------------ rendering helpers (shared)
  const lineState = (R, d, nm) => R.line[d][nm];
  function ifStatus(net, R, d, nm) { const i = net.devices[d].ifs[nm]; if (i.shutdown) return { status: "administratively down", proto: "down" }; const up = R.line[d][nm]; return { status: up ? "up" : "down", proto: up ? "up" : "down" }; }

  function ribRows(R, d) {
    const best = {}; for (const r of R.rib[d]) { const k = r.pfx + "/" + r.len; const b = best[k]; if (!b || r.ad < b.ad || (r.ad === b.ad && r.metric < b.metric)) best[k] = r; }
    const out = Object.values(best); out.sort((a, b) => a.pfx - b.pfx || a.len - b.len); return out;
  }
  function classful(pfx) { const f = pfx >>> 24; const len = f < 128 ? 8 : f < 192 ? 16 : 24; return { net: netOf(n2ip(pfx), len), len }; }
  const CODE = { C: "C", L: "L", S: "S", O: "O", E2: "O E2", B: "B" };

  function showRouteIos(R, d, style, only) {
    const net = R.net; const rows = ribRows(R, d).filter((r) => !only || only(r));
    const out = [];
    if (style === "ios") out.push("Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP\n       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area \n       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2\n       E1 - OSPF external type 1, E2 - OSPF external type 2\n       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2\n       ia - IS-IS inter area, * - candidate default, U - per-user static route\n       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP\n       a - application route\n       + - replicated route, % - next hop override, p - overrides from PfR\n");
    else if (style === "eos") out.push("Codes: C - connected, S - static, K - kernel, \n       O - OSPF, IA - OSPF inter area, E1 - OSPF external type 1,\n       E2 - OSPF external type 2, N1 - OSPF NSSA external type 1,\n       N2 - OSPF NSSA external type2, B - Other BGP Routes,\n       B I - iBGP, B E - eBGP, R - RIP, I L1 - IS-IS level 1,\n       I L2 - IS-IS level 2, O3 - OSPFv3, A B - BGP Aggregate,\n       A O - OSPF Summary, NG - Nexthop Group Static Route,\n       V - VM, M - Martian, DH - DHCP client installed default route,\n       DP - Dynamic Policy Route, L - VRF Leaked\n");
    const dflt = rows.find((r) => r.len === 0 && r.proto !== "C");
    if (style !== "nxos") out.push(dflt ? `Gateway of last resort is ${n2ip(dflt.nh)} to network 0.0.0.0\n` : "Gateway of last resort is not set\n");
    if (style === "nxos") {
      out.push(`IP Route Table for VRF "default"\n'*' denotes best ucast next-hop\n'**' denotes best mcast next-hop\n'[x/y]' denotes [preference/metric]\n'%<string>' in via output denotes VRF <string>\n`);
      for (const r of rows) { const nm = r.ifc; const via = r.proto === "C" || r.proto === "L" ? `    *via ${n2ip(r.pfx)}, ${nm}, [0/0], ${upt(d + r.pfx)}, ${r.proto === "C" ? "direct" : "local"}` : `    *via ${n2ip(r.nh)}${r.proto === "S" ? "" : ", " + nm}, [${r.ad}/${r.metric}], ${upt(d + r.pfx)}, ${({ O: "ospf-1, intra", E2: "ospf-1, type-2", S: "static", B: r.ebgp ? "bgp-" + net.devices[d].bgp.asn + ", external" : "bgp-" + net.devices[d].bgp.asn + ", internal" })[r.proto]}`; out.push(`${n2ip(r.pfx)}/${r.len}, ubest/mbest: 1/0${r.proto === "L" ? ", attached" : ""}\n${via}`); }
      return out.join("\n");
    }
    // grouped by classful network
    const groups = {}; for (const r of rows) { const c = classful(r.pfx); (groups[c.net + "/" + c.len] = groups[c.net + "/" + c.len] || { c, rows: [] }).rows.push(r); }
    for (const g of Object.values(groups)) {
      const masks = new Set(g.rows.map((r) => r.len));
      if (style === "ios") out.push(masks.size > 1 ? `      ${n2ip(g.c.net)}/${g.c.len} is variably subnetted, ${g.rows.length} subnets, ${masks.size} masks` : `      ${n2ip(g.c.net)}/${g.c.len} is subnetted, ${g.rows.length} subnets`);
      for (const r of g.rows) {
        const dest = `${n2ip(r.pfx)}/${r.len}`;
        if (r.proto === "C") out.push(style === "ios" ? `C        ${dest} is directly connected, ${r.ifc}` : ` C        ${dest} is directly connected, ${r.ifc}`);
        else if (r.proto === "L") { if (style === "ios") out.push(`L        ${dest} is directly connected, ${r.ifc}`); }
        else { const code = r.proto === "S" ? (r.len === 0 ? "S*" : "S ") : r.proto === "O" ? "O " : r.proto === "E2" ? "O E2" : style === "eos" ? (r.ebgp ? " B E" : " B I") : "B "; out.push(`${pad(code, 9)}${dest} [${r.ad}/${r.metric}] via ${n2ip(r.nh)}${style === "eos" ? ", " + r.ifc : r.proto === "S" ? "" : `, ${upt(d + r.pfx)}, ${r.ifc}`}`); }
      }
    }
    return out.join("\n");
  }

  const ospfStateStr = (R, d, nb, style) => { if (nb.state !== "FULL") return nb.state + "/  -"; const me = R.ospf[d].rid, other = nb.id; const dr = ip2n(me) > ip2n(other) ? "BDR" : "DR"; const i = R.net.devices[d].ifs[nb.iface]; if (i.ospf.type === "p2p") return "FULL/  -"; return "FULL/" + dr; };

  // ------------------------------------------------------------ running config rendering
  const cfgx = {};
  function runConfig(net, d, style) {
    const D = net.devices[d], L = [];
    L.push(style === "eos" ? "! Command: show running-config" : "Building configuration...\n\nCurrent configuration : 1024 bytes\n!");
    L.push("!"); L.push(`hostname ${D.hostname}`); L.push("!");
    if (style === "nxos") { const f = []; if (D.ospf) f.push("feature ospf"); if (D.bgp) f.push("feature bgp"); if (Object.values(D.ifs).some((i) => i.svi)) f.push("feature interface-vlan"); f.forEach((x) => L.push(x)); L.push("!"); }
    for (const v of Object.keys(D.vlans).map(Number).sort((a, b) => a - b)) if (v !== 1) { L.push(`vlan ${v}`); L.push(` name ${D.vlans[v]}`); if (cfgx.vlan) cfgx.vlan(D, v, style, L); L.push("!"); }
    if (cfgx.top) cfgx.top(D, style, L);
    for (const [nm, ac] of Object.entries(D.acls)) { L.push(`ip access-list extended ${nm}`); ac.forEach((e, k) => { const sp = (s) => (s === "any" ? "any" : s.host ? "host " + s.host : n2ip(s.ip) === undefined ? "" : s.ip + " " + n2ip((~lenMask(s.len)) >>> 0)); L.push(` ${style === "ios" ? "" : (k + 1) * 10 + " "}${e.action} ${e.proto} ${sp(e.src)} ${sp(e.dst)}${e.port ? " eq " + e.port : ""}`); }); L.push("!"); }
    for (const nm of D.order) {
      const i = D.ifs[nm]; L.push(`interface ${nm}`);
      if (i.virtual) { if (cfgx.iface) cfgx.iface(D, i, style, L); L.push(i.shutdown ? " shutdown" : style === "nxos" ? " no shutdown" : null); L.push("!"); continue; }
      if (i.desc) L.push(` description ${i.desc}`);
      if (i.sub) L.push(` encapsulation dot1Q ${i.sub}`);
      if (style !== "ios" && !N.isSwitchport(i) && !i.loopback && !i.svi && !i.sub && D.role === "switch") L.push(" no switchport");
      if (i.mode === "access") { L.push(" switchport mode access"); if (i.accessVlan !== 1) L.push(` switchport access vlan ${i.accessVlan}`); }
      if (i.mode === "trunk") { L.push(style === "ios" ? " switchport trunk encapsulation dot1q" : null); L.push(" switchport mode trunk"); if (i.allowed) L.push(` switchport trunk allowed vlan ${i.allowed.join(",")}`); if (i.native !== 1) L.push(` switchport trunk native vlan ${i.native}`); }
      if (i.mtu !== 1500) L.push(` mtu ${i.mtu}`);
      L.push(i.ip ? ` ip address ${i.ip.addr} ${maskOf(i.ip.len)}` : (N.isSwitchport(i) ? null : " no ip address"));
      if (i.acl.in) L.push(` ip access-group ${i.acl.in} in`); if (i.acl.out) L.push(` ip access-group ${i.acl.out} out`);
      if (D.ospf && i.ospf.area !== null) L.push(style === "nxos" ? ` ip router ospf ${D.ospf.pid} area ${i.ospf.area}` : ` ip ospf ${D.ospf.pid} area ${i.ospf.area}`);
      if (i.ospf.cost) L.push(` ip ospf cost ${i.ospf.cost}`); if (i.ospf.hello !== 10) L.push(` ip ospf hello-interval ${i.ospf.hello}`); if (i.ospf.dead !== 40) L.push(` ip ospf dead-interval ${i.ospf.dead}`);
      if (i.ospf.type === "p2p") L.push(" ip ospf network point-to-point"); if (i.ospf.auth) L.push(` ip ospf authentication-key ${i.ospf.auth}`); if (i.ospf.mtuIgnore) L.push(" ip ospf mtu-ignore");
      if (cfgx.iface) cfgx.iface(D, i, style, L);
      L.push(i.shutdown ? " shutdown" : (style === "ios" || style === "nxos") && !i.loopback ? " no shutdown" : null); L.push("!");
    }
    if (D.ospf) { L.push(`router ospf ${D.ospf.pid}`); if (D.ospf.rid) L.push(` router-id ${D.ospf.rid}`); for (const w of D.ospf.networks) L.push(` network ${w.ip} ${w.wild} area ${w.area}`); if (D.ospf.defaultPassive) L.push(" passive-interface default"); (D.ospf.nonPassive || []).forEach((x) => L.push(` no passive-interface ${x}`)); (D.ospf.passive || []).forEach((x) => L.push(` passive-interface ${x}`)); const rd = D.ospf.redist || {}; if (rd.static) L.push(" redistribute static subnets"); if (rd.connected) L.push(" redistribute connected subnets"); if (rd.bgp) L.push(" redistribute bgp " + (D.bgp ? D.bgp.asn : "") + " subnets"); L.push("!"); }
    if (D.bgp) { const B = D.bgp; L.push(`router bgp ${B.asn}`); if (B.rid) L.push(` bgp router-id ${B.rid}`);
      for (const [ip, nb] of Object.entries(B.neighbors)) { L.push(` neighbor ${ip} remote-as ${nb.remoteAs}`); if (nb.desc) L.push(` neighbor ${ip} description ${nb.desc}`); if (nb.updateSource) L.push(` neighbor ${ip} update-source ${nb.updateSource}`); if (nb.multihop) L.push(` neighbor ${ip} ebgp-multihop ${nb.multihop}`); if (nb.password) L.push(` neighbor ${ip} password ${nb.password}`); if (nb.shutdown) L.push(` neighbor ${ip} shutdown`); }
      L.push(" !"); L.push(" address-family ipv4"); for (const nw of B.networks || []) L.push(`  network ${nw.ip} mask ${maskOf(nw.len)}`); const rd = B.redist || {}; for (const k of ["connected", "static", "ospf"]) if (rd[k]) L.push(`  redistribute ${k}${k === "ospf" ? " 1" : ""}`);
      for (const [ip, nb] of Object.entries(B.neighbors)) { L.push(`  neighbor ${ip} activate`); if (nb.nhs) L.push(`  neighbor ${ip} next-hop-self`); if (nb.rrClient) L.push(`  neighbor ${ip} route-reflector-client`); if (nb.rmIn) L.push(`  neighbor ${ip} route-map ${nb.rmIn} in`); if (nb.rmOut) L.push(`  neighbor ${ip} route-map ${nb.rmOut} out`); if (nb.prefixIn) L.push(`  neighbor ${ip} prefix-list ${nb.prefixIn} in`); if (nb.prefixOut) L.push(`  neighbor ${ip} prefix-list ${nb.prefixOut} out`); }
      L.push(" exit-address-family"); if (cfgx.bgp) cfgx.bgp(D, style, L); L.push("!"); }
    for (const s of D.statics) L.push(`ip route ${s.pfx} ${maskOf(s.len)} ${s.nh}${s.ad && s.ad !== 1 ? " " + s.ad : ""}`);
    if (D.statics.length) L.push("!");
    for (const [nm, list] of Object.entries(D.prefixLists)) for (const e of list) L.push(`ip prefix-list ${nm} seq ${e.seq} ${e.action} ${e.pfx}/${e.len}${e.ge ? " ge " + e.ge : ""}${e.le ? " le " + e.le : ""}`);
    for (const [nm, cl] of Object.entries(D.routeMaps)) for (const c of cl) { L.push(`route-map ${nm} ${c.action} ${c.seq}`); if (c.match && c.match.prefixList) L.push(` match ip address prefix-list ${c.match.prefixList}`); if (c.set && c.set.lp !== undefined) L.push(` set local-preference ${c.set.lp}`); if (c.set && c.set.med !== undefined) L.push(` set metric ${c.set.med}`); if (c.set && c.set.prepend) L.push(` set as-path prepend ${c.set.prepend.join(" ")}`); L.push("!"); }
    L.push("end");
    return L.filter((x) => x !== null && x !== undefined).join("\n");
  }

  // ------------------------------------------------------------ logs
  function logLines(net, R, d, style) {
    const D = net.devices[d], out = [], ts = (k) => (style === "ios" ? "*Nov 22 10:" : "Nov 22 10:") + String(2 + (k % 50)).padStart(2, "0") + ":" + String((k * 7) % 60).padStart(2, "0") + ".123" + (style === "ios" ? ": " : " ");
    let k = 0; const add = (t) => out.push(ts(k++ * 3) + t);
    for (const nm of D.order) { const i = D.ifs[nm]; if (i.loopback || i.sub) continue; const st = ifStatus(net, R, d, nm); if (st.status === "administratively down") { add(`%LINK-5-CHANGED: Interface ${nm}, changed state to administratively down`); add(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${nm}, changed state to down`); } else if (!R.line[d][nm] && !i.svi) { add(`%LINK-3-UPDOWN: Interface ${nm}, changed state to down`); add(`%LINEPROTO-5-UPDOWN: Line protocol on Interface ${nm}, changed state to down`); } }
    const peerParams = (e) => { const a = R.att.find((x) => x.dev === d && x.ifc === e.ifc); const b = a && R.att.find((x) => x.ip === e.peer); return a && b ? { mine: D.ifs[e.ifc], theirs: net.devices[b.dev].ifs[b.ifc], a, b } : null; };
    for (const e of R.events[d]) {
      if (e.kind === "ospf-timers") { const pp = peerParams(e); add(`%OSPF-4-ERRRCV: Received invalid packet: mismatched Hello parameters from ${e.peer}`); if (pp) add(`%OSPF-4-ERRRCV: Dead R ${pp.theirs.ospf.dead} C ${pp.mine.ospf.dead}, Hello R ${pp.theirs.ospf.hello} C ${pp.mine.ospf.hello}, Mask R ${maskOf(pp.b.len)} C ${maskOf(pp.a.len)}`); }
      else if (e.kind === "ospf-mask") add(`%OSPF-4-ERRRCV: Received invalid packet: mismatched Hello parameters from ${e.peer}`);
      else if (e.kind === "ospf-area") add(`%OSPF-4-ERRRCV: Received invalid packet: mismatch area ID, from backbone area must be virtual-link but not found from ${e.peer}, ${e.ifc}`);
      else if (e.kind === "ospf-auth") add(`%OSPF-4-ERRRCV: Received invalid packet: Mismatch Authentication type. Input packet specified type 0, we use type 1`);
      else if (e.kind === "ospf-rid") add(`%OSPF-4-DUP_RTRID_NBR: OSPF detected duplicate router-id ${R.ospf[d].rid} from ${e.peer} on interface ${e.ifc}`);
      else if (e.kind === "ospf-mtu") add(`%OSPF-5-ADJCHG: Process ${D.ospf.pid}, Nbr ${e.peerRid} on ${e.ifc} from EXSTART to DOWN, Neighbor Down: Too many retransmissions`);
      else if (e.kind === "bgp-badas") { add(`%BGP-3-NOTIFICATION: received from neighbor ${e.peer} active 2/2 (peer in wrong AS) 2 bytes ${(e.theirs || 0).toString(16).toUpperCase()}`); add(`%BGP-5-ADJCHANGE: neighbor ${e.peer} Down BGP Notification received`); }
      else if (e.kind === "bgp-auth") add(`%TCP-6-BADAUTH: No MD5 digest from ${e.peer}(179) to local(51234) tableid - 0`);
      else if (e.kind === "bgp-badid") add(`%BGP-3-NOTIFICATION: received from neighbor ${e.peer} 2/3 (bad BGP identifier) 4 bytes`);
    }
    return out;
  }

  // ------------------------------------------------------------ session
  function Session(net, dev, o) {
    this.net = net; this.dev = dev; this.mode = (net.devices[dev].os === "nxos") ? "priv" : "user"; this.ctx = {}; this.o = o || {};
    this.style = this.d().os === "nxos" ? "nxos" : this.d().os === "eos" ? "eos" : this.d().os === "ios" ? "ios" : this.d().os;
    this.history = []; this.cmds = 0;
  }
  Session.prototype.d = function () { return this.net.devices[this.dev]; };
  Session.prototype.R = function () { const net = this.net; if (!net._R || net._rev !== net._Rrev) { net._R = N.compute(net); net._Rrev = net._rev; } return net._R; };
  Session.prototype.touch = function () { this.net._rev = (this.net._rev || 0) + 1; };

  const api = { N, pad, padL, hash, upt, maskOf, resolveIf, short, compile, dispatch, matchEntry, caretErr, ribRows, showRouteIos, ospfStateStr, runConfig, logLines, ifStatus, Session, CODE, cfgx };
  root.Netcli = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
