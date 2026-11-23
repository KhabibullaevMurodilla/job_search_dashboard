/* Netjunos: Juniper Junos. The configuration of a Junos device is the list of
   "set" statements (dev.jset). commit rebuilds the vendor-neutral model from
   them, so a Junos device behaves exactly like the others and its candidate
   configuration really is separate from what is running. */
(function (root) {
  "use strict";
  const C = root.Netcli || (typeof require !== "undefined" ? require("./netcli.js") : null);
  const IOS = root.Netios || (typeof require !== "undefined" ? require("./netios.js") : null);
  const { N, pad, padL, hash, upt, Session } = C;
  const { ip2n, n2ip, lenMask, inNet, netOf } = N;

  // ------------------------------------------------------------ tokens
  function tokenize(line) {
    const out = []; const re = /"([^"]*)"|\[([^\]]*)\]|(\S+)/g; let m;
    while ((m = re.exec(line))) { if (m[1] !== undefined) out.push(m[1]); else if (m[2] !== undefined) out.push(m[2].trim().split(/\s+/).filter(Boolean)); else out.push(m[3]); }
    return out;
  }
  const flat = (t) => [].concat(...t.map((x) => (Array.isArray(x) ? x : [x])));
  const dotted = (a) => N.normArea(a);
  const protoName = { direct: "connected", static: "static", ospf: "ospf", bgp: "bgp" };

  // ------------------------------------------------------------ rebuild model from set lines
  function rebuild(dev) {
    for (const nm of dev.order.slice()) if (dev.ifs[nm].derived) { delete dev.ifs[nm]; dev.order.splice(dev.order.indexOf(nm), 1); }
    for (const nm of dev.order) { const i = dev.ifs[nm]; Object.assign(i, { ip: null, shutdown: false, desc: "", mtu: 1500, mode: "routed", accessVlan: 1, allowed: null, native: 1, sub: null, svi: null, acl: { in: null, out: null } }); i.ospf = { area: null, cost: null, hello: 10, dead: 40, type: "broadcast", auth: null, mtuIgnore: false }; i.jmembers = null; }
    dev.vlans = { 1: "default" }; dev.statics = []; dev.prefixLists = {}; dev.routeMaps = {}; dev.acls = {}; dev.ospf = null; dev.bgp = null; dev.jerrors = [];
    const vlanIds = {}, l3 = {}; let asn = 0, rid = null; const groups = {}, policies = {}, ospfIfs = []; let ospfExport = null; let bgpSeen = false;
    const ensureIf = (name, o) => { if (!dev.ifs[name]) { N.addIf(dev, name, Object.assign({ derived: true }, o || {})); } return dev.ifs[name]; };
    const lines = dev.jset.map((l) => tokenize(l.replace(/^set\s+/, "")));
    for (const t of lines) {
      const top = t[0];
      if (top === "system" && t[1] === "host-name") dev.hostname = t[2];
      else if (top === "interfaces") {
        const name = t[1], rest = t.slice(2); const phys = dev.ifs[name] || (name === "lo0" ? ensureIf("lo0", { loopback: true, mode: "routed" }) : name === "irb" ? null : null);
        if (rest[0] === "disable" && phys) phys.shutdown = true;
        else if (rest[0] === "description" && phys) phys.desc = rest[1];
        else if (rest[0] === "mtu" && phys) phys.mtu = +rest[1];
        else if (rest[0] === "unit") {
          const u = +rest[1], a = rest.slice(2); let target = phys;
          if (name === "irb") target = ensureIf("irb." + u, { mode: "routed", irbUnit: u });
          else if (u !== 0 && phys) { const subName = name + "." + u; target = dev.ifs[subName] || ensureIf(subName, { parent: name, mode: "routed" }); if (a[0] === "vlan-id") target.sub = +a[1]; }
          if (!target) { dev.jerrors.push("interface " + name + " does not exist"); continue; }
          if (a[0] === "disable") target.shutdown = true;
          else if (a[0] === "description") target.desc = a[1];
          else if (a[0] === "family" && a[1] === "inet" && a[2] === "address") { const c = N.cidr(a[3]); if (c && !target.ip) target.ip = { addr: c.ip, len: c.len }; }
          else if (a[0] === "family" && a[1] === "inet" && a[2] === "filter") { target.acl[a[3] === "input" ? "in" : "out"] = a[4]; }
          else if (a[0] === "family" && a[1] === "ethernet-switching") {
            if (a[2] === "interface-mode") target.mode = a[3] === "trunk" ? "trunk" : "access";
            else if (a[2] === "vlan" && a[3] === "members") { target.jmembers = flat([a.slice(4)]); if (target.mode === "routed") target.mode = "access"; }
            else if (a[2] === "native-vlan-id") target.native = +a[3];
            if (target.mode === "routed") target.mode = "access";
          }
        }
      }
      else if (top === "vlans") { const nm = t[1]; if (t[2] === "vlan-id") vlanIds[nm] = { id: +t[3], l3: (vlanIds[nm] || {}).l3 }; else if (t[2] === "l3-interface") { vlanIds[nm] = Object.assign(vlanIds[nm] || {}, { l3: t[3] }); } }
      else if (top === "routing-options") {
        if (t[1] === "autonomous-system") asn = +t[2]; else if (t[1] === "router-id") rid = t[2];
        else if (t[1] === "static" && t[2] === "route") { const c = N.cidr(t[3]); if (!c) continue; let nh = null, pref = null; for (let k = 4; k < t.length; k++) { if (t[k] === "next-hop") nh = t[++k]; else if (t[k] === "preference") pref = +t[++k]; else if (t[k] === "discard" || t[k] === "reject") nh = null; } if (nh) dev.statics.push({ pfx: n2ip(netOf(c.ip, c.len)), len: c.len, nh, ad: pref || 5 }); }
      }
      else if (top === "protocols" && t[1] === "ospf") {
        dev.ospf = dev.ospf || { pid: 1, rid: null, networks: [], passive: [], redist: {} };
        if (t[2] === "area") { const area = dotted(t[3]); if (t[4] === "interface") { const ifn = t[5].replace(/\.0$/, ""); const target = dev.ifs[ifn] || dev.ifs[t[5]]; if (!target) { dev.jerrors.push("ospf interface " + t[5] + " not found"); continue; } if (!ospfIfs.includes(target)) ospfIfs.push(target); target.ospf.area = area; const k = t[6]; if (k === "passive") dev.ospf.passive.push(target.name); else if (k === "hello-interval") target.ospf.hello = +t[7]; else if (k === "dead-interval") target.ospf.dead = +t[7]; else if (k === "metric") target.ospf.cost = +t[7]; else if (k === "interface-type" && t[7] === "p2p") target.ospf.type = "p2p"; else if (k === "authentication") { target.ospf.auth = t[7] === "md5" ? "md5:" + (t[9] || t[8]) : (t[8] || t[7]); } else if (k === "ignore-mtu" || k === "mtu-ignore") target.ospf.mtuIgnore = true; } }
        else if (t[2] === "export") ospfExport = t[3];
        else if (t[2] === "router-id") dev.ospf.rid = t[3];
      }
      else if (top === "protocols" && t[1] === "bgp") {
        bgpSeen = true;
        if (t[2] === "group") { const g = (groups[t[3]] = groups[t[3]] || { name: t[3], neighbors: {} }); let k = 4; const key = t[k]; if (key === "type") g.type = t[k + 1]; else if (key === "peer-as") g.peerAs = +t[k + 1]; else if (key === "local-address") g.localAddress = t[k + 1]; else if (key === "multihop") { g.multihop = t[k + 1] === "ttl" ? +t[k + 2] : 64; } else if (key === "authentication-key") g.password = t[k + 1]; else if (key === "import") g.import = [].concat(t[k + 1])[0]; else if (key === "export") g.export = [].concat(t[k + 1])[0]; else if (key === "cluster") g.cluster = t[k + 1]; else if (key === "neighbor") { const n = (g.neighbors[t[k + 1]] = g.neighbors[t[k + 1]] || {}); const sk = t[k + 2]; if (sk === "peer-as") n.peerAs = +t[k + 3]; else if (sk === "local-address") n.localAddress = t[k + 3]; else if (sk === "description") n.desc = t[k + 3]; else if (sk === "authentication-key") n.password = t[k + 3]; else if (sk === "import") n.import = [].concat(t[k + 3])[0]; else if (sk === "export") n.export = [].concat(t[k + 3])[0]; else if (sk === "multihop") n.multihop = t[k + 3] === "ttl" ? +t[k + 4] : 64; else if (sk === "disable") n.disable = true; } }
      }
      else if (top === "policy-options") {
        if (t[1] === "prefix-list") { const c = N.cidr(t[3]); if (c) (dev.prefixLists[t[2]] = dev.prefixLists[t[2]] || []).push({ seq: ((dev.prefixLists[t[2]] || []).length + 1) * 5, action: "permit", pfx: c.ip, len: c.len }); }
        else if (t[1] === "policy-statement") { const p = (policies[t[2]] = policies[t[2]] || { terms: [], order: [] }); if (t[3] === "term") { let tm = p.terms.find((x) => x.name === t[4]); if (!tm) { tm = { name: t[4], from: {}, then: {} }; p.terms.push(tm); } const sec = t[5]; if (sec === "from") { if (t[6] === "protocol") tm.from.protocol = protoName[t[7]] || t[7]; else if (t[6] === "prefix-list") tm.from.prefixList = t[7]; else if (t[6] === "route-filter") { tm.from.filters = tm.from.filters || []; tm.from.filters.push({ p: t[7], kind: t[8] || "exact", upto: t[9] }); } } else if (sec === "then") { const k = t[6]; if (k === "accept" || k === "reject") tm.then.action = k; else if (k === "local-preference") tm.then.lp = +t[7]; else if (k === "metric") tm.then.med = +t[7]; else if (k === "as-path-prepend") tm.then.prepend = String(t[7]).split(/\s+/).map(Number); else if (k === "next-hop" && t[7] === "self") tm.then.nhs = true; } } }
      }
      else if (top === "firewall" && t[1] === "family" && t[2] === "inet" && t[3] === "filter") {
        const f = (dev.acls[t[4]] = dev.acls[t[4]] || []); f._terms = f._terms || {}; if (t[5] === "term") { let tm = f._terms[t[6]]; if (!tm) { tm = f._terms[t[6]] = { src: "any", dst: "any", proto: "ip", port: null, action: "permit" }; f.push(tm); } if (t[7] === "from") { const spec = (x) => { const c = N.cidr(x); return c ? (c.len === 32 ? { host: c.ip } : { ip: c.ip, len: c.len }) : "any"; }; if (t[8] === "source-address") tm.src = spec(t[9]); else if (t[8] === "destination-address") tm.dst = spec(t[9]); else if (t[8] === "protocol") tm.proto = t[9]; else if (t[8] === "destination-port") tm.port = /^\d+$/.test(t[9]) ? +t[9] : ({ ssh: 22, telnet: 23, http: 80, https: 443, bgp: 179 })[t[9]] || null; } else if (t[7] === "then") { tm.action = t[8] === "accept" ? "permit" : "deny"; } }
      }
    }
    // vlans
    for (const [nm, v] of Object.entries(vlanIds)) if (v.id) dev.vlans[v.id] = nm;
    const vidOf = (x) => { if (/^\d+$/.test(String(x))) return +x; const v = vlanIds[x]; return v && v.id ? v.id : null; };
    for (const nm of dev.order) { const i = dev.ifs[nm]; if (i.jmembers) { const ids = []; let all = false; for (const m of i.jmembers) { if (m === "all") all = true; else { const id = vidOf(m); if (id) ids.push(id); else if (/^\d+-\d+$/.test(m)) { const [a, b] = m.split("-").map(Number); for (let q = a; q <= b; q++) ids.push(q); } else dev.jerrors.push("vlan " + m + " not found"); } } if (i.mode === "access") i.accessVlan = ids[0] || 1; else i.allowed = all ? null : ids; } }
    for (const [nm, v] of Object.entries(vlanIds)) if (v.l3) { const i = dev.ifs[v.l3]; if (i) i.svi = v.id; }
    // policies -> route-maps
    for (const [pn, p] of Object.entries(policies)) { const rm = []; p.terms.forEach((tm, k) => { const match = {}; if (tm.from.protocol) match.protocol = tm.from.protocol; if (tm.from.prefixList) match.prefixList = tm.from.prefixList; if (tm.from.filters) { const nm = `__rf_${pn}_${tm.name}`; dev.prefixLists[nm] = tm.from.filters.map((f, q) => { const c = N.cidr(f.p); const e = { seq: (q + 1) * 5, action: "permit", pfx: c ? c.ip : "0.0.0.0", len: c ? c.len : 0 }; if (f.kind === "orlonger") e.le = 32; else if (f.kind === "longer") { e.ge = e.len + 1; e.le = 32; } else if (f.kind === "upto") e.le = +String(f.upto || "32").replace("/", ""); return e; }); match.prefixList = nm; } const set = {}; if (tm.then.lp !== undefined) set.lp = tm.then.lp; if (tm.then.med !== undefined) set.med = tm.then.med; if (tm.then.prepend) set.prepend = tm.then.prepend; if (tm.then.nhs) set.nhs = true; rm.push({ seq: (k + 1) * 10, action: tm.then.action === "reject" ? "deny" : "permit", match, set, junosNoAction: !tm.then.action }); }); dev.routeMaps[pn] = rm; }
    if (dev.ospf && !dev.ospf.rid && rid) dev.ospf.rid = rid;
    // ospf export (redistribution)
    if (dev.ospf && ospfExport && policies[ospfExport]) for (const tm of policies[ospfExport].terms) if (tm.then.action === "accept" && tm.from.protocol) { const k = tm.from.protocol; if (k === "static" || k === "connected" || k === "bgp") dev.ospf.redist[k] = true; }
    // bgp
    if (bgpSeen) {
      dev.bgp = { asn, rid, neighbors: {}, networks: [], redist: {} };
      for (const g of Object.values(groups)) for (const [ip, n] of Object.entries(g.neighbors)) {
        const peerAs = n.peerAs || g.peerAs || (g.type === "internal" ? asn : 0), la = n.localAddress || g.localAddress;
        let src; if (la) for (const nm of dev.order) { const i = dev.ifs[nm]; if (i.ip && i.ip.addr === la) src = nm; }
        const nb = { remoteAs: peerAs, group: g.name }; if (src) nb.updateSource = src; const mh = n.multihop || g.multihop; if (mh) nb.multihop = mh; const pw = n.password || g.password; if (pw) nb.password = pw; if (n.disable) nb.shutdown = true; if (n.desc) nb.desc = n.desc; const imp = n.import || g.import, exp = n.export || g.export; if (imp) nb.rmIn = imp; if (exp) nb.rmOut = exp; if (g.cluster) nb.rrClient = true; nb.type = g.type;
        dev.bgp.neighbors[ip] = nb; if (!peerAs) dev.jerrors.push(`bgp neighbor ${ip}: missing peer-as`);
      }
      dev.jgroups = groups;
    }
    // firewall filters: drop helper props
    for (const f of Object.values(dev.acls)) delete f._terms;
    dev.jpolicies = policies;
  }
  function load(dev, text) { dev.jset = text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => (l.startsWith("set ") ? l : "set " + l)); rebuild(dev); return dev; }

  // ------------------------------------------------------------ rendering the configuration
  const KEYED = { unit: 1, area: 1, interface: 1, group: 1, neighbor: 1, term: 1, "policy-statement": 1, "prefix-list": 1, route: 1, filter: 1 };
  function tree(lines) {
    const root = { c: [], leaf: [] };
    for (const l of lines) {
      const t = tokenize(l.replace(/^set\s+/, "")).map((x) => (Array.isArray(x) ? "[ " + x.join(" ") + " ]" : /\s/.test(x) ? `"${x}"` : x)); let node = root, i = 0;
      while (t.length - i > 2) { let name = t[i], n = 1; if (KEYED[t[i]]) n = 2; else if (node === root || (i === 1 && t[0] === "interfaces") || (i === 1 && (t[0] === "vlans" || t[0] === "policy-options" && false))) n = node === root ? 1 : 1; if (t[0] === "interfaces" && i === 1 && !KEYED[t[i]]) n = 1; name = t.slice(i, i + n).join(" "); let ch = node.c.find((x) => x.name === name); if (!ch) { ch = { name, c: [], leaf: [] }; node.c.push(ch); } node = ch; i += n; if (t.length - i <= 2) break; }
      const leaf = t.slice(i).join(" "); if (leaf && node.leaf.indexOf(leaf) < 0) node.leaf.push(leaf);
    }
    return root;
  }
  function printTree(node, ind, out) { for (const l of node.leaf.filter((x) => !node.c.some((ch) => ch.name === x))) out.push(`${ind}${l};`); for (const ch of node.c) { out.push(`${ind}${ch.name} {`); printTree(ch, ind + "    ", out); out.push(`${ind}}`); } }
  function showConfig(lines, path) {
    let L = lines;
    if (path && path.length) { const pre = "set " + path.join(" ") + " "; L = lines.filter((l) => l.startsWith(pre)).map((l) => "set " + l.slice(pre.length)); }
    const out = []; printTree(tree(L), "", out); return out.join("\n");
  }

  // ------------------------------------------------------------ show handlers
  const dotted0 = (a) => N.normArea(a);
  const unitName = (nm) => (/\.\d+$/.test(nm) || nm === "irb" ? nm : nm + ".0");
  function terse(c, only) {
    const { net, R, d, D } = c, L = ["Interface               Admin Link Proto    Local                 Remote"];
    const physical = D.order.filter((n) => !D.ifs[n].derived && !D.ifs[n].parent && !D.ifs[n].loopback);
    const row = (nm, admin, link, proto, local) => `${pad(nm, 23)} ${pad(admin, 5)} ${pad(link, 4)} ${pad(proto || "", 8)} ${local || ""}`.replace(/\s+$/, "");
    for (const nm of physical) { const i = D.ifs[nm]; if (only && only !== nm && only.replace(/\.\d+$/, "") !== nm) continue; L.push(row(nm, i.shutdown ? "down" : "up", R.line[d][nm] ? "up" : "down")); const sw = N.isSwitchport(i); if (i.ip || sw) L.push(row(nm + ".0", i.shutdown ? "down" : "up", R.line[d][nm] ? "up" : "down", sw ? "eth-switch" : "inet", i.ip ? i.ip.addr + "/" + i.ip.len : "")); for (const sn of D.order) { const s = D.ifs[sn]; if (s.parent === nm) L.push(row(sn, s.shutdown ? "down" : "up", R.line[d][sn] ? "up" : "down", "inet", s.ip ? s.ip.addr + "/" + s.ip.len : "")); } }
    for (const nm of D.order) { const i = D.ifs[nm]; if (i.loopback) L.push(row(nm, "up", "up")), L.push(row(nm + ".0", "up", "up", "inet", i.ip ? i.ip.addr + "/" + i.ip.len : "")); if (i.irbUnit !== undefined) L.push(row(nm, i.shutdown ? "down" : "up", R.line[d][nm] ? "up" : "down", "inet", i.ip ? i.ip.addr + "/" + i.ip.len : "")); }
    return L.join("\n");
  }
  const jname = (D, nm) => { const i = D.ifs[nm]; return i.loopback ? nm + ".0" : i.parent || i.irbUnit !== undefined ? nm : nm + ".0"; };
  function route(c, filter, detail) {
    const { R, d, D } = c; const rows = C.ribRows(R, d).filter((r) => (filter ? filter(r) : true));
    const act = rows.length;
    const L = [`inet.0: ${act} destinations, ${act} routes (${act} active, 0 holddown, 0 hidden)`, "+ = Active Route, - = Last Active, * = Both", ""];
    for (const r of rows) {
      const dest = `${n2ip(r.pfx)}/${r.len}`, ifn = jname(D, r.ifc);
      if (r.proto === "C") L.push(`${pad(dest, 18)} *[Direct/0] ${upt(d + dest)}`, `                    >  via ${ifn}`);
      else if (r.proto === "L") L.push(`${pad(dest, 18)} *[Local/0] ${upt(d + dest)}`, `                       Local via ${ifn}`);
      else if (r.proto === "S") L.push(`${pad(dest, 18)} *[Static/${r.ad}] ${upt(d + dest)}`, `                    >  to ${n2ip(r.nh)} via ${ifn}`);
      else if (r.proto === "O" || r.proto === "E2") L.push(`${pad(dest, 18)} *[OSPF/${r.ad}] ${upt(d + dest)}, metric ${r.metric}`, `                    >  to ${n2ip(r.nh)} via ${ifn}`);
      else { const p = (R.bgpTable[d][dest] || []).find((x) => x.best) || {}; L.push(`${pad(dest, 18)} *[BGP/${r.ad}] ${upt(d + dest)}, localpref ${p.lp || 100}`, `                      AS path: ${(p.asPath || []).join(" ")}${(p.asPath || []).length ? " " : ""}${p.origin === "?" ? "?" : "I"}, validation-state: unverified`, `                    >  to ${n2ip(r.nh)} via ${ifn}`); }
    }
    return L.join("\n");
  }
  function ospfNbr(c) {
    const { R, d, D } = c, L = ["Address          Interface              State     ID               Pri  Dead"];
    for (const x of R.ospf[d].nbrs) L.push(`${pad(x.addr, 16)} ${pad(jname(D, x.iface), 22)} ${pad(x.state === "FULL" ? "Full" : x.state === "EXSTART" ? "ExStart" : x.state, 9)} ${pad(x.id, 16)} ${pad(128, 4)} ${padL(30 + (hash(d + x.id) % 8), 3)}`);
    return L.length === 1 ? "" : L.join("\n");
  }
  function ospfIface(c) {
    const { R, d, D } = c, L = ["Interface           State   Area            DR ID           BDR ID          Nbrs"];
    for (const nm of D.order) { const o = R.ospf[d].ifs[nm]; if (!o) continue; const nb = R.ospf[d].nbrs.filter((x) => x.iface === nm), full = nb.filter((x) => x.state === "FULL").length; L.push(`${pad(jname(D, nm), 19)} ${pad(D.ifs[nm].loopback || o.passive ? "DR" : full ? (ip2n(R.ospf[d].rid) > ip2n(nb[0].id) ? "DR" : "BDR") : "Waiting", 7)} ${pad(o.area, 15)} ${pad(full ? (ip2n(R.ospf[d].rid) > ip2n(nb[0].id) ? R.ospf[d].rid : nb[0].id) : "0.0.0.0", 15)} ${pad(full ? (ip2n(R.ospf[d].rid) > ip2n(nb[0].id) ? nb[0].id : R.ospf[d].rid) : "0.0.0.0", 15)} ${nb.length}`); }
    return L.join("\n");
  }
  function bgpSummary(c) {
    const { R, d, D } = c, B = D.bgp; if (!B) return "BGP is not running";
    const ips = Object.keys(B.neighbors), ext = ips.filter((i) => B.neighbors[i].remoteAs !== B.asn).length, down = ips.filter((i) => R.bgp[d][i].state !== "Established").length;
    const tot = Object.values(R.bgpTable[d]).reduce((n, l) => n + l.length, 0), act = Object.values(R.bgpTable[d]).reduce((n, l) => n + l.filter((p) => p.best).length, 0);
    const L = [`Threading mode: BGP I/O\nDefault eBGP mode: advertise - accept, receive - accept\nGroups: ${new Set(ips.map((i) => B.neighbors[i].group)).size} Peers: ${ips.length} External: ${ext} Internal: ${ips.length - ext} Down peers: ${down}`, "Table          Tot Paths  Act Paths Suppressed    History Damp State    Pending", `inet.0 ${padL(tot, 15)} ${padL(act, 10)} ${padL(0, 10)} ${padL(0, 10)} ${padL(0, 10)} ${padL(0, 10)}`, "Peer                     AS      InPkt     OutPkt    OutQ   Flaps Last Up/Dwn State|#Active/Received/Accepted/Damped..."];
    for (const ip of ips) { const s = R.bgp[d][ip], nb = B.neighbors[ip], est = s.state === "Established"; L.push(`${pad(ip, 24)} ${padL(nb.remoteAs, 5)} ${padL(est ? 10 + (hash(d + ip) % 20) : 0, 10)} ${padL(est ? 12 : 3, 10)} ${padL(0, 6)} ${padL(est ? 0 : 1, 7)} ${padL(est ? "5:07" : "23", 12)} ${est ? "Establ" : s.reason === "Admin down" ? "Idle" : s.state}`); if (est) L.push(`  inet.0: ${s.pfxRcvd}/${s.pfxRcvd}/${s.pfxRcvd}/0`); }
    return L.join("\n");
  }
  function bgpNeighbor(c, ip) {
    const { R, d, D } = c, B = D.bgp; if (!B) return "BGP is not running"; const L = [];
    for (const x of Object.keys(B.neighbors)) { if (ip && x !== ip) continue; const nb = B.neighbors[x], s = R.bgp[d][x], ext = nb.remoteAs !== B.asn, est = s.state === "Established"; const lastErr = { badas: "Open Message Error", "badas-peer": "Open Message Error", badid: "Open Message Error" }[s.reason] || "None";
      L.push(`Peer: ${x}+${est ? 179 : 0} AS ${nb.remoteAs}  Local: ${s.src || "Unspecified"}+${est ? 54321 : 0} AS ${B.asn}`, `  Group: ${nb.group}               Routing-Instance: master`, `  Forwarding routing-instance: master`, `  Type: ${ext ? "External" : "Internal"}    State: ${s.state === "Established" ? "Established" : s.state}   Flags: <${est ? "Sync" : ""}>`, `  Last State: ${est ? "OpenConfirm" : "Idle"}       Last Event: ${est ? "RecvKeepAlive" : s.reason === "badas" ? "RecvNotify" : "Start"}`, `  Last Error: ${lastErr}`, `  Options: <Preference PeerAS Refresh>`, nb.updateSource ? `  Local Address: ${D.ifs[nb.updateSource].ip.addr} Holdtime: 90 Preference: 170` : `  Holdtime: 90 Preference: 170`, est ? `  Number of flaps: 0\n  Active prefixes:              ${s.pfxRcvd}\n  Received prefixes:            ${s.pfxRcvd}\n  Accepted prefixes:            ${s.pfxRcvd}` : `  Number of flaps: 1`, ""); }
    return L.length ? L.join("\n") : "error: BGP neighbor not found";
  }
  function logs(c) {
    const { net, R, d, D } = c, out = []; let k = 0; const ts = () => `Nov 22 10:${String(2 + (k++ * 3) % 50).padStart(2, "0")}:${String((k * 7) % 60).padStart(2, "0")} ${D.hostname}`;
    for (const nm of D.order) { const i = D.ifs[nm]; if (i.loopback || i.derived || i.parent) continue; if (!R.line[d][nm] && !i.shutdown) out.push(`${ts()} mib2d[1020]: SNMP_TRAP_LINK_DOWN: ifIndex ${520 + k}, ifAdminStatus up(1), ifOperStatus down(2), ifName ${nm}`); else if (i.shutdown) out.push(`${ts()} mib2d[1020]: SNMP_TRAP_LINK_DOWN: ifIndex ${520 + k}, ifAdminStatus down(2), ifOperStatus down(2), ifName ${nm}`); }
    for (const e of R.events[d]) {
      const ifn = e.ifc ? jname(D, e.ifc) : "";
      if (e.kind === "ospf-area") out.push(`${ts()} rpd[1456]: OSPF packet ignored: area mismatch (${e.area}) from ${e.peer} on intf ${ifn} area ${e.mine}`);
      else if (e.kind === "ospf-timers" || e.kind === "ospf-mask" || e.kind === "ospf-auth") out.push(`${ts()} rpd[1456]: OSPF packet ignored: configuration mismatch from ${e.peer} on intf ${ifn} area ${(R.ospf[d].ifs[e.ifc] || {}).area}`);
      else if (e.kind === "ospf-rid") out.push(`${ts()} rpd[1456]: RPD_OSPF_NBRDOWN: OSPF neighbor ${e.peer} (realm ospf-v2 ${ifn}) duplicate router-id`);
      else if (e.kind === "ospf-mtu") out.push(`${ts()} rpd[1456]: RPD_OSPF_NBRDOWN: OSPF neighbor ${e.peer} (realm ospf-v2 ${ifn} area ${(R.ospf[d].ifs[e.ifc] || {}).area}) state changed from ExStart to Down due to InActiveTimer (event reason: DBD retransmission limit exceeded; MTU mismatch)`);
      else if (e.kind === "bgp-badas") out.push(`${ts()} rpd[1456]: bgp_process_open: peer ${e.peer} (External AS ${e.asn}): received bad peer AS ${e.theirs}`, `${ts()} rpd[1456]: RPD_BGP_NEIGHBOR_STATE_CHANGED: BGP peer ${e.peer} (External AS ${e.asn}) changed state from OpenSent to Idle (event RecvNotify)`);
      else if (e.kind === "bgp-auth") out.push(`${ts()} kernel: tcp_auth_ok: Packet from ${e.peer}:179 missing MD5 digest`);
    }
    return out.join("\n");
  }
  function arp(c) { const { R, d } = c, L = ["MAC Address       Address         Name                      Interface               Flags"]; for (const a of R.att) { if (a.dev !== d) continue; for (const b of R.att) if (b.dev !== d && b.seg === a.seg && inNet(b.ip, a.ip, a.len)) L.push(`${pad(IOS.mac(b.dev + b.ifc).replace(/\./g, ":").slice(0, 17), 17)} ${pad(b.ip, 15)} ${pad(b.ip, 25)} ${pad(jname(c.D, a.ifc), 23)} none`); } return L.join("\n"); }
  function lldp(c) { const L = ["Local Interface    Parent Interface    Chassis Id          Port info          System Name"]; for (const x of N.neighbors(c.net, c.d)) L.push(`${pad(x.ifc, 18)} -                   ${pad(IOS.mac(x.peerDev), 19)} ${pad(x.peerIf, 18)} ${c.net.devices[x.peerDev].hostname}`); return L.join("\n"); }
  function vlans(c) { const { D } = c, L = ["Routing instance        VLAN name             Tag          Interfaces", "default-switch          default               1"]; for (const v of Object.keys(D.vlans).map(Number).sort((a, b) => a - b)) { if (v === 1) continue; const ports = D.order.filter((nm) => (D.ifs[nm].mode === "access" && D.ifs[nm].accessVlan === v) || (D.ifs[nm].mode === "trunk" && (D.ifs[nm].allowed === null || D.ifs[nm].allowed.indexOf(v) >= 0))); L.push(`default-switch          ${pad(D.vlans[v], 21)} ${pad(v, 12)} ${ports.map((p) => p + ".0").join(",")}`); } return L.join("\n"); }

  // ------------------------------------------------------------ table
  const OP = ["op"], CF = ["cfg"], BOTH = ["op", "cfg"];
  function build() {
    const T = [], E = (p, modes, run) => T.push({ p, modes, run });
    E("show interfaces terse <i?>", BOTH, (c, a) => terse(c, a.i));
    E("show interfaces <i> terse", BOTH, (c, a) => terse(c, a.i));
    E("show interfaces <i?> <m?>", BOTH, (c, a) => { if (!a.i) return terse(c); const i = c.D.ifs[a.i.replace(/\.0$/, "")]; if (!i) return "error: device " + a.i + " not found"; return `Physical interface: ${a.i}, ${i.shutdown ? "Administratively down" : "Enabled"}, Physical link is ${c.R.line[c.d][i.name] ? "Up" : "Down"}\n  Link-level type: Ethernet, MTU: ${i.mtu + 14}, Speed: 1000mbps, Duplex: Full-duplex\n  ${i.desc ? "Description: " + i.desc + "\n  " : ""}Logical interface ${a.i}.0\n    Protocol inet, MTU: ${i.mtu}\n${i.ip ? `      Local: ${i.ip.addr}/${i.ip.len}` : ""}`; });
    E("show route", BOTH, (c) => route(c));
    E("show route protocol <p>", BOTH, (c, a) => { const map = { ospf: ["O", "E2"], bgp: ["B"], static: ["S"], direct: ["C"], local: ["L"] }; const k = Object.keys(map).find((x) => x.startsWith(a.p)); return route(c, (r) => k && map[k].indexOf(r.proto) >= 0); });
    E("show route table <t>", BOTH, (c) => route(c));
    E("show route <x> <o1?> <o2?>", BOTH, (c, a) => { const x = N.cidr(a.x) || (ip2n(a.x) !== null ? { ip: a.x, len: 32 } : null); if (!x) return "error: invalid prefix"; const exact = a.o1 === "exact"; const rows = C.ribRows(c.R, c.d).filter((r) => (exact ? (r.pfx === netOf(x.ip, x.len) && r.len === x.len) : N.inNet(x.ip, n2ip(r.pfx), r.len) || (x.len < 32 && N.inNet(n2ip(r.pfx), x.ip, x.len)))); if (!rows.length) return ""; const best = new Set(rows.map((r) => r.pfx + "/" + r.len)); return route(c, (r) => best.has(r.pfx + "/" + r.len) && (exact || x.len === 32 ? (r.len === Math.max(...rows.map((q) => q.len))) : true)); });
    E("show route receive-protocol bgp <ip>", BOTH, (c, a) => { const s = c.R.bgp[c.d][a.ip]; if (!s || s.state !== "Established") return ""; const L = [`inet.0: ${s.pfxRcvd} destinations, ${s.pfxRcvd} routes (${s.pfxRcvd} active, 0 holddown, 0 hidden)`, "  Prefix                  Nexthop              MED     Lclpref    AS path"]; for (const [k, l] of Object.entries(c.R.bgpTable[c.d])) for (const p of l) if (p.from === s.peerSrc) L.push(`* ${pad(k, 23)} ${pad(n2ip(p.nh), 20)} ${pad(p.med || "", 7)} ${pad(p.ebgp ? "" : p.lp, 10)} ${p.asPath.join(" ")}`); return L.join("\n"); });
    E("show route advertising-protocol bgp <ip>", BOTH, (c, a) => { const s = c.R.bgp[c.d][a.ip]; if (!s || s.state !== "Established") return ""; const L = [`inet.0: ${s.pfxSent} destinations, ${s.pfxSent} routes (${s.pfxSent} active, 0 holddown, 0 hidden)`, "  Prefix                  Nexthop              MED     Lclpref    AS path"]; const other = c.R.bgpTable[s.peerDev]; for (const [k, l] of Object.entries(other)) for (const p of l) if (p.from === s.src) L.push(`* ${pad(k, 23)} ${pad(n2ip(p.nh), 20)} ${pad("", 7)} ${pad("", 10)} ${p.asPath.join(" ")}`); return L.join("\n"); });
    E("show ospf neighbor <x?>", BOTH, ospfNbr);
    E("show ospf interface <x?>", BOTH, ospfIface);
    E("show ospf database <x?>", BOTH, (c) => `    OSPF database, Area 0.0.0.0\n Type       ID               Adv Rtr           Seq      Age  Opt  Cksum  Len \nRouter  *${pad(c.R.ospf[c.d].rid, 16)} ${pad(c.R.ospf[c.d].rid, 15)} 0x80000004   120  0x22 0x4f1d  48`);
    E("show ospf overview", BOTH, (c) => `Instance: master\n  Router ID: ${c.R.ospf[c.d].rid}\n  Route table index: 0\n  Area: 0.0.0.0`);
    E("show bgp summary", BOTH, bgpSummary);
    E("show bgp neighbor <ip?>", BOTH, (c, a) => bgpNeighbor(c, a.ip));
    E("show bgp group <x?>", BOTH, (c) => `Group Type: ${Object.values(c.D.bgp ? c.D.bgp.neighbors : {})[0] ? Object.values(c.D.bgp.neighbors)[0].type : ""}`);
    E("show vlans", BOTH, vlans);
    E("show ethernet-switching interface <x?>", BOTH, () => "");
    E("show lldp neighbors", BOTH, lldp);
    E("show arp <x?>", BOTH, arp);
    E("show log messages", BOTH, logs);
    E("show log <x>", BOTH, logs);
    E("show system uptime", BOTH, (c) => `Current time: 2026-11-22 10:42:17 UTC\nSystem booted: 2026-11-20 07:31:02 UTC (2d 03:11 ago)`);
    E("show version", BOTH, (c) => `Hostname: ${c.D.hostname}\nModel: vMX\nJunos: 23.4R1.10`);
    E("show system <x...>", BOTH, () => "");
    E("show chassis <x...>", BOTH, () => "");
    E("show configuration <x...>", OP, (c, a) => showConfig(c.D.jset, a.x.replace(/\|.*$/, "").trim().split(/\s+/).filter(Boolean)));
    E("show configuration", OP, (c) => showConfig(c.D.jset, []));
    E("ping <t> <rest...>", BOTH, (c, a) => { const w = a.rest.split(/\s+/); let src = null, cnt = 5; for (let k = 0; k < w.length; k++) { if (w[k] === "source") src = w[++k]; else if (w[k] === "count") cnt = Math.min(20, +w[++k] || 5); } return IOS.reachText("junos", c.R, c.d, a.t, src, cnt); });
    E("ping <t>", BOTH, (c, a) => IOS.reachText("junos", c.R, c.d, a.t, null, 5));
    E("traceroute <t> <x...>", BOTH, (c, a) => IOS.traceText("junos", c.R, c.d, a.t));
    E("traceroute <t>", BOTH, (c, a) => IOS.traceText("junos", c.R, c.d, a.t));
    E("clear bgp neighbor <x?>", BOTH, (c) => { c.s.touch(); return "Cleared 1 connections"; });
    E("clear ospf neighbor <x?>", BOTH, (c) => { c.s.touch(); return ""; });
    E("configure <x?>", OP, (c) => { c.s.mode = "cfg"; c.s.cand = c.D.jset.slice(); c.s.path = []; return "Entering configuration mode"; });
    E("exit", OP, (c) => { c.s.exited = true; return ""; });
    E("quit", OP, (c) => { c.s.exited = true; return ""; });
    // configuration mode
    E("set <x...>", CF, (c, a, line) => { const full = ["set"].concat(c.s.path, line.split(/\s+/).slice(1)).join(" "); const err = validate(full); if (err) return err; if (c.s.cand.indexOf(full) < 0) c.s.cand.push(full); return ""; });
    E("delete <x...>", CF, (c, a, line) => { const pre = "set " + c.s.path.concat(line.split(/\s+/).slice(1)).join(" "); const before = c.s.cand.length; c.s.cand = c.s.cand.filter((l) => !(l === pre || l.startsWith(pre + " "))); return c.s.cand.length === before ? "warning: statement not found" : ""; });
    E("edit <x...>", CF, (c, a, line) => { const p = line.split(/\s+/).slice(1); const pre = "set " + c.s.path.concat(p).join(" ") + " "; if (!c.s.cand.some((l) => l.startsWith(pre))) return "error: statement not found"; c.s.path = c.s.path.concat(p); return `[edit ${c.s.path.join(" ")}]`; });
    E("top", CF, (c) => { c.s.path = []; return ""; });
    E("up", CF, (c) => { c.s.path.pop(); return ""; });
    E("exit", CF, (c) => { if (c.s.path.length) { c.s.path = []; return ""; } c.s.mode = "op"; return "Exiting configuration mode"; });
    E("quit", CF, (c) => { c.s.mode = "op"; return "Exiting configuration mode"; });
    E("show", CF, (c) => showConfig(c.s.cand, c.s.path));
    E("show <x...>", CF, (c, a) => { if (/^\|\s*compare/.test(a.x)) return compare(c.D.jset, c.s.cand); if (/^\|\s*display set/.test(a.x)) return c.s.cand.filter((l) => !c.s.path.length || l.startsWith("set " + c.s.path.join(" "))).join("\n"); return showConfig(c.s.cand, c.s.path.concat(a.x.replace(/\|.*$/, "").trim().split(/\s+/).filter(Boolean))); });
    E("commit <x?> <y?>", CF, (c, a) => { const probe = { name: c.D.name, os: "junos", ifs: N.clone(c.D.ifs), order: c.D.order.slice(), jset: c.s.cand }; rebuild(probe); const errs = checkErrors(probe); if (errs) return errs; if (a.x === "check") return "configuration check succeeds"; c.D.jset = c.s.cand.slice(); rebuild(c.D); c.s.touch(); return "commit complete"; });
    E("rollback <n?>", CF, (c) => { c.s.cand = c.D.jset.slice(); return "load complete"; });
    E("run <x...>", CF, () => "");
    E("status", CF, () => "");
    return C.compile(T);
    function validate(full) { return ""; }
  }
  function compare(a, b) { const A = new Set(a), B = new Set(b), out = ["[edit]"]; for (const l of a) if (!B.has(l)) out.push("-  " + l.replace(/^set /, "delete ")); for (const l of b) if (!A.has(l)) out.push("+  " + l); return out.length === 1 ? "" : out.join("\n"); }
  function checkErrors(d) {
    const errs = [];
    if (d.bgp && !d.bgp.asn) errs.push("[edit routing-options]\n  'autonomous-system'\n    Missing mandatory statement: 'autonomous-system'");
    for (const e of d.jerrors || []) if (/peer-as/.test(e)) { const ip = e.match(/neighbor ([\d.]+)/); errs.push(`[edit protocols bgp group]\n  'neighbor ${ip ? ip[1] : ""}'\n    Missing mandatory statement: 'peer-as'`); }
    return errs.length ? errs.join("\n") + "\nerror: configuration check-out failed" : "";
  }
  const TABLE = build();
  Session.prototype.promptJunos = function () { return this.mode === "cfg" ? `${"admin"}@${this.d().hostname}# ` : `admin@${this.d().hostname}> `; };
  Session.prototype.runJunos = function (line) {
    const s = this, D = s.d(); if (!s.mode || s.mode === "user" || s.mode === "priv") s.mode = "op";
    s.cmds++; s.history.push(line); const prompt = s.promptJunos(); let text = line.trim(); if (!text) return { out: "", prompt };
    // pipes
    let pipes = []; if (/\|/.test(text) && !(s.mode === "cfg" && /^(show|set|delete)/.test(text) && /\|\s*(compare|display)/.test(text) && !/\|.*\|/.test(text))) { const parts = text.split("|").map((x) => x.trim()); text = parts[0]; pipes = parts.slice(1); }
    else if (s.mode === "op" && /\|/.test(text)) { const parts = text.split("|").map((x) => x.trim()); text = parts[0]; pipes = parts.slice(1); }
    let words = text.split(/\s+/), modes = [s.mode];
    if (s.mode === "cfg" && words[0] === "run") { words = words.slice(1); modes = ["op"]; text = words.join(" "); }
    const lazy = { s, D, d: s.dev, net: s.net, style: "junos", prompt, line: text, get R() { return s.R(); } };
    const dd = dispatch2(modes, words);
    if (!dd.hit) { if (dd.incomplete) return { out: "syntax error, expecting <command>.", prompt }; const col = prompt.length + words.slice(0, Math.min(dd.fail || 0, words.length - 1)).join(" ").length + (dd.fail ? 1 : 0); return { out: " ".repeat(col) + "^\n" + (s.mode === "cfg" ? "syntax error." : "unknown command."), prompt }; }
    let out = dd.hit.e.run(lazy, dd.hit.r.a, text) || "";
    if (s.exited) { s.exited = false; return { out: "", prompt, exit: true }; }
    let displaySet = pipes.some((p) => /^display\s+set/.test(p));
    if (displaySet && /^show configuration/.test(text)) { const path = words.slice(2); const pre = path.length ? "set " + path.join(" ") + " " : "set "; out = D.jset.filter((l) => l.startsWith(pre)).join("\n"); }
    for (const p of pipes) { const m = p.match(/^(match|except|find|count|last|display|no-more|trim|resolve)\s*(.*)$/); if (!m) continue; if (m[1] === "match") out = out.split("\n").filter((l) => new RegExp(m[2].replace(/\|/g, "|"), "i").test(l)).join("\n"); else if (m[1] === "except") out = out.split("\n").filter((l) => !new RegExp(m[2], "i").test(l)).join("\n"); else if (m[1] === "count") out = "Count: " + out.split("\n").filter(Boolean).length + " lines"; else if (m[1] === "find") { const k = out.split("\n").findIndex((l) => new RegExp(m[2], "i").test(l)); out = k >= 0 ? out.split("\n").slice(k).join("\n") : ""; } }
    return { out, prompt: s.promptJunos() };
  };
  function dispatch2(modes, words) { return C.dispatch(TABLE, modes, words, 0, "junos"); }
  Session.prototype.prompt = (function (old) { return function () { if (this.style === "junos") return this.promptJunos(); return old.call(this); }; })(Session.prototype.prompt);

  const api = { rebuild, load, tokenize, showConfig, TABLE };
  root.Netjunos = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
