/* Netsim: a small network simulator whose behaviour comes from configuration.
   Devices, interfaces and links form a vendor-neutral model. compute() works
   out what a real network would do with it: which interfaces are up, which
   layer-2 segments exist (VLANs, trunks, native-VLAN leaks), which OSPF
   adjacencies form (and why not), which BGP sessions come up (and why not),
   which routes each device holds, and whether a packet gets through.
   Faults in the labs are real misconfigurations, so the symptoms are
   consistent from every device and every command. The vendor command lines
   (netcli.js) only read this model and change it. */
(function (root) {
  "use strict";

  // ------------------------------------------------------------ addresses
  const ip2n = (s) => { const p = String(s).split("."); if (p.length !== 4) return null; let n = 0; for (const x of p) { if (!/^\d{1,3}$/.test(x) || +x > 255) return null; n = n * 256 + +x; } return n; };
  const n2ip = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  const lenMask = (l) => (l <= 0 ? 0 : l >= 32 ? 0xFFFFFFFF : (0xFFFFFFFF << (32 - l)) >>> 0);
  const maskLen = (m) => { const n = ip2n(m); if (n === null) return null; for (let l = 0; l <= 32; l++) if (lenMask(l) === n) return l; return null; };
  const wildLen = (w) => { const n = ip2n(w); return n === null ? null : maskLen(n2ip((~n) >>> 0)); };
  const netOf = (ip, len) => ((ip2n(ip) & lenMask(len)) >>> 0);
  const inNet = (ip, pfx, len) => ip2n(ip) !== null && ((ip2n(ip) & lenMask(len)) >>> 0) === ((ip2n(pfx) & lenMask(len)) >>> 0);
  const cidr = (s) => { const m = String(s).match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/); return m && ip2n(m[1]) !== null && +m[2] <= 32 ? { ip: m[1], len: +m[2] } : null; };

  // ------------------------------------------------------------ model
  function newNet() { return { devices: {}, links: [] }; }
  function addDevice(net, o) {
    const d = { name: o.name, os: o.os, role: o.role || "router", hostname: o.hostname || o.name, ifs: {}, order: [], vlans: { 1: "default" }, ospf: null, bgp: null, statics: [], prefixLists: {}, routeMaps: {}, acls: {}, logs: [], services: o.services || null, notes: {} };
    net.devices[o.name] = d; return d;
  }
  function addIf(dev, name, o) {
    o = o || {};
    dev.ifs[name] = Object.assign({ name, ip: null, shutdown: false, desc: "", mtu: 1500, mode: "routed", accessVlan: 1, allowed: null, native: 1, ospf: { area: null, cost: null, hello: 10, dead: 40, type: "broadcast", auth: null, mtuIgnore: false }, sub: null, svi: null, loopback: false, acl: { in: null, out: null } }, o);
    dev.order.push(name); return dev.ifs[name];
  }
  function connect(net, aDev, aIf, bDev, bIf) { net.links.push({ a: { dev: aDev, ifc: aIf }, b: { dev: bDev, ifc: bIf }, up: true }); }
  function peerOf(net, dev, ifc) { for (const l of net.links) { if (l.a.dev === dev && l.a.ifc === ifc) return { link: l, dev: l.b.dev, ifc: l.b.ifc }; if (l.b.dev === dev && l.b.ifc === ifc) return { link: l, dev: l.a.dev, ifc: l.a.ifc }; } return null; }
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const isSwitchport = (i) => i.mode === "access" || i.mode === "trunk";

  // ------------------------------------------------------------ policy
  function prefixListMatch(pl, pfx, len) {
    if (!pl) return true;
    for (const e of pl.slice().sort((a, b) => a.seq - b.seq)) {
      if (!inNet(n2ip(pfx), e.pfx, e.len) || len < e.len) continue;
      const ge = e.ge || (e.le ? e.len : e.len), le = e.le || (e.ge ? 32 : e.len);
      if (len >= ge && len <= le) return e.action === "permit";
    }
    return false;
  }
  // Returns null (rejected) or the route with actions applied.
  function applyMap(dev, name, route, ctx) {
    if (!name) return route;
    const rm = dev.routeMaps[name];
    if (!rm) return route;                                        // an undefined map permits everything
    for (const c of rm.slice().sort((a, b) => a.seq - b.seq)) {
      const m = c.match || {};
      if (m.prefixList && !prefixListMatch(dev.prefixLists[m.prefixList], route.pfx, route.len)) continue;
      if (m.protocol && ctx && ctx.proto && m.protocol !== ctx.proto) continue;
      if (m.asPathLen !== undefined && route.asPath && route.asPath.length !== m.asPathLen) continue;
      if (c.action === "deny") return null;
      const r = Object.assign({}, route, { asPath: (route.asPath || []).slice() }), s = c.set || {};
      if (s.lp !== undefined) r.lp = s.lp; if (s.med !== undefined) r.med = s.med;
      if (s.prepend) r.asPath = s.prepend.concat(r.asPath);
      if (s.nhs) r.nhs = true;
      return r;
    }
    return ctx && ctx.junos ? "default" : null;                    // no clause matched
  }

  const normArea = (a) => { a = String(a); if (/^\d+$/.test(a)) { const n = +a; return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."); } return a; };
  const adFor = (d, p, ebgp) => (d.os === "junos" ? ({ S: 5, O: 10, E2: 150, B: 170 })[p] : ({ S: 1, O: 110, E2: 110, B: ebgp ? 20 : 200 })[p]);

  // ------------------------------------------------------------ compute
  function computeCore(net, opts) {
    const R = { net, line: {}, att: [], adj: [], ospf: {}, bgp: {}, bgpTable: {}, rib: {}, events: {}, seg: {} };
    const names = Object.keys(net.devices);
    for (const n of names) { R.line[n] = {}; R.events[n] = []; R.ospf[n] = { nbrs: [], ifs: {}, rid: null }; R.bgp[n] = {}; R.bgpTable[n] = {}; R.rib[n] = []; }
    const ev = (dev, o) => R.events[dev].push(o);

    // 1. interface state ----------------------------------------------------
    const vlanActive = (d, v) => d.vlans[v] !== undefined;
    const ovlUp = (d, v) => !!(d.vxlan && d.vxlan.nve && d.ifs[d.vxlan.nve.ifc] && !d.ifs[d.vxlan.nve.ifc].shutdown && d.vxlan.vlanVni && d.vxlan.vlanVni[v] && d.vlans[v] !== undefined);
    for (const n of names) {
      const d = net.devices[n];
      for (const nm of d.order) {
        const i = d.ifs[nm]; let line = false;
        if (i.loopback) line = !i.shutdown;
        else if (i.svi) line = !i.shutdown && vlanActive(d, i.svi) && (ovlUp(d, i.svi) || d.order.some((p) => { const q = d.ifs[p]; if (q.shutdown || !isSwitchport(q) || !R.line[n][p]) return false; const pe = peerOf(net, n, p); if (!pe) return false; return q.mode === "access" ? q.accessVlan === i.svi : (q.allowed === null || q.allowed.indexOf(i.svi) >= 0); }));
        else if (i.sub) { line = !i.shutdown && !!R.line[n][i.parent]; }
        else { const pe = peerOf(net, n, nm); line = !i.shutdown && !!pe && pe.link.up !== false && !net.devices[pe.dev].ifs[pe.ifc].shutdown; }
        R.line[n][nm] = line;
      }
      // svis depend on switch ports computed above; recompute once
      for (const nm of d.order) { const i = d.ifs[nm]; if (i.svi) R.line[n][nm] = !i.shutdown && vlanActive(d, i.svi) && (ovlUp(d, i.svi) || d.order.some((p) => { const q = d.ifs[p]; if (q.shutdown || !isSwitchport(q) || !R.line[n][p]) return false; return q.mode === "access" ? q.accessVlan === i.svi : (q.allowed === null || q.allowed.indexOf(i.svi) >= 0); })); if (i.sub) R.line[n][nm] = !i.shutdown && !!R.line[n][i.parent]; }
    }

    // 2. layer-2 segments -------------------------------------------------
    const uf = {}; const find = (x) => { if (uf[x] === undefined) uf[x] = x; while (uf[x] !== x) { uf[x] = uf[uf[x]]; x = uf[x]; } return x; }; const union = (a, b) => { uf[find(a)] = find(b); };
    const vn = (d, v) => `sw|${d}|${v}`, an = (d, i) => `att|${d}|${i}`;
    const dev = (n) => net.devices[n];
    net.links.forEach((l, k) => {
      const A = dev(l.a.dev).ifs[l.a.ifc], B = dev(l.b.dev).ifs[l.b.ifc];
      if (!A || !B || !R.line[l.a.dev][l.a.ifc] || !R.line[l.b.dev][l.b.ifc]) return;
      const ok = (d, v) => vlanActive(dev(d), v);
      const side = (e, I) => (I.mode === "access" ? { k: "access", v: I.accessVlan } : I.mode === "trunk" ? { k: "trunk" } : { k: "routed" });
      const sa = side(l.a, A), sb = side(l.b, B);
      const allowed = (d, I, v) => (I.allowed === null || I.allowed.indexOf(v) >= 0) && ok(d, v);
      const attOf = (d, i) => an(d, i);
      if (sa.k === "routed" && sb.k === "routed") { union(attOf(l.a.dev, l.a.ifc), `p2p|${k}`); union(attOf(l.b.dev, l.b.ifc), `p2p|${k}`); return; }
      const swSide = (e, I, other, otherI) => {
        // e is a switchport end; other is the far end
        if (I.mode === "access") { if (ok(e.dev, I.accessVlan)) return { untagged: vn(e.dev, I.accessVlan), tagged: {} }; return null; }
        const tagged = {}; for (const v of Object.keys(dev(e.dev).vlans).map(Number)) if (v !== I.native && allowed(e.dev, I, v)) tagged[v] = vn(e.dev, v);
        return { untagged: ok(e.dev, I.native) ? vn(e.dev, I.native) : null, tagged };
      };
      if (sa.k !== "routed" && sb.k !== "routed") {
        const x = swSide(l.a, A), y = swSide(l.b, B); if (!x || !y) return;
        if (x.untagged && y.untagged) union(x.untagged, y.untagged);
        for (const v of Object.keys(x.tagged)) if (y.tagged[v]) union(x.tagged[v], y.tagged[v]);
        return;
      }
      const sw = sa.k !== "routed" ? { e: l.a, I: A, other: l.b, O: B } : { e: l.b, I: B, other: l.a, O: A };
      const s = swSide(sw.e, sw.I); if (!s) return;
      const rd = sw.other.dev, rI = sw.O;
      if (s.untagged) union(s.untagged, attOf(rd, sw.other.ifc));
      for (const nm of dev(rd).order) { const q = dev(rd).ifs[nm]; if (q.sub && q.parent === sw.other.ifc && s.tagged[q.sub]) union(s.tagged[q.sub], attOf(rd, nm)); }
    });
    for (const n of names) { const d = dev(n); for (const nm of d.order) { const i = d.ifs[nm]; if (i.svi && R.line[n][nm]) union(an(n, nm), vn(n, i.svi)); } }
    for (const u of (opts && opts.unions) || []) union(vn(u[0].dev, u[0].vlan), vn(u[1].dev, u[1].vlan));
    // attachments
    for (const n of names) { const d = dev(n); for (const nm of d.order) { const i = d.ifs[nm]; if (!i.ip || !R.line[n][nm]) continue; if (isSwitchport(i)) continue; R.att.push({ dev: n, ifc: nm, ip: i.ip.addr, len: i.ip.len, node: i.loopback ? `lo|${n}|${nm}` : an(n, nm) }); } }
    for (const a of R.att) a.seg = find(a.node);
    for (let x = 0; x < R.att.length; x++) for (let y = x + 1; y < R.att.length; y++) { const a = R.att[x], b = R.att[y]; if (a.dev === b.dev || a.seg !== b.seg) continue; if (inNet(a.ip, b.ip, b.len) || inNet(b.ip, a.ip, a.len)) R.adj.push([a, b]); }
    const attOf = (d, i) => R.att.find((a) => a.dev === d && a.ifc === i);
    R.find = find;

    // 3. OSPF ---------------------------------------------------------------
    const ospfIf = (d, nm) => {
      const D = dev(d), i = D.ifs[nm]; if (!D.ospf || !i.ip) return null;
      let area = i.ospf.area;
      if (area === null || area === undefined) for (const w of D.ospf.networks || []) { if (inNet(i.ip.addr, w.ip, wildLen(w.wild))) { area = w.area; break; } }
      if (area === null || area === undefined) return null;
      const passive = D.ospf.defaultPassive ? !(D.ospf.nonPassive || []).includes(nm) : (D.ospf.passive || []).includes(nm);
      return { area: normArea(area), passive };
    };
    const ridOf = (d) => { const D = dev(d); if (D.ospf && D.ospf.rid) return D.ospf.rid; let best = null; for (const nm of D.order) { const i = D.ifs[nm]; if (i.loopback && i.ip && (best === null || ip2n(i.ip.addr) > ip2n(best))) best = i.ip.addr; } if (best) return best; for (const nm of D.order) { const i = D.ifs[nm]; if (i.ip && (best === null || ip2n(i.ip.addr) > ip2n(best))) best = i.ip.addr; } return best || "0.0.0.0"; };
    const ospfDevs = names.filter((n) => dev(n).ospf);
    for (const n of ospfDevs) R.ospf[n].rid = ridOf(n);
    const edges = []; // FULL adjacencies
    for (const [a, b] of R.adj) {
      if (!dev(a.dev).ospf || !dev(b.dev).ospf) continue;
      const oa = ospfIf(a.dev, a.ifc), ob = ospfIf(b.dev, b.ifc); if (!oa || !ob) continue;
      const ia = dev(a.dev).ifs[a.ifc], ib = dev(b.dev).ifs[b.ifc];
      const rec = (x, y, ix, iy, st, reason) => { R.ospf[x.dev].nbrs.push({ iface: x.ifc, id: R.ospf[y.dev].rid, addr: y.ip, state: st, reason, peerDev: y.dev, area: ospfIf(x.dev, x.ifc).area }); };
      const bad = (reason, kind) => { ev(a.dev, { kind: "ospf-" + kind, ifc: a.ifc, peer: b.ip, area: ob.area, mine: oa.area }); ev(b.dev, { kind: "ospf-" + kind, ifc: b.ifc, peer: a.ip, area: oa.area, mine: ob.area }); };
      if (oa.passive || ob.passive) { ev(oa.passive ? a.dev : b.dev, { kind: "ospf-passive", ifc: oa.passive ? a.ifc : b.ifc }); if (oa.passive !== ob.passive) ev(oa.passive ? b.dev : a.dev, { kind: "ospf-nohello", ifc: oa.passive ? b.ifc : a.ifc }); continue; }
      if (oa.area !== ob.area) { bad("area", "area"); continue; }
      if (a.len !== b.len && ia.ospf.type !== "p2p") { bad("mask", "mask"); continue; }
      if (ia.ospf.hello !== ib.ospf.hello || ia.ospf.dead !== ib.ospf.dead) { bad("timers", "timers"); continue; }
      if ((ia.ospf.auth || null) !== (ib.ospf.auth || null)) { bad("auth", "auth"); continue; }
      if (R.ospf[a.dev].rid === R.ospf[b.dev].rid) { bad("rid", "rid"); continue; }
      if (ia.mtu !== ib.mtu && !ia.ospf.mtuIgnore && !ib.ospf.mtuIgnore) { rec(a, b, ia, ib, "EXSTART", "mtu"); rec(b, a, ib, ia, "EXSTART", "mtu"); ev(a.dev, { kind: "ospf-mtu", ifc: a.ifc, peer: b.ip, peerRid: R.ospf[b.dev].rid }); ev(b.dev, { kind: "ospf-mtu", ifc: b.ifc, peer: a.ip, peerRid: R.ospf[a.dev].rid }); continue; }
      rec(a, b, ia, ib, "FULL", ""); rec(b, a, ib, ia, "FULL", "");
      edges.push({ a, b, ca: ia.ospf.cost || 1, cb: ib.ospf.cost || 1 });
    }
    for (const n of ospfDevs) for (const nm of dev(n).order) { const o = ospfIf(n, nm); if (o) R.ospf[n].ifs[nm] = o; }

    // routes: connected / local / static / ospf
    const addRoute = (d, r) => R.rib[d].push(r);
    for (const a of R.att) { const d = a.dev; const I = dev(d).ifs[a.ifc]; addRoute(d, { pfx: netOf(a.ip, a.len), len: a.len, proto: "C", ad: 0, metric: 0, nh: null, ifc: a.ifc }); addRoute(d, { pfx: ip2n(a.ip), len: 32, proto: "L", ad: 0, metric: 0, nh: null, ifc: a.ifc }); }
    const connectedNh = (d, nh) => { for (const a of R.att) if (a.dev === d && inNet(n2ip(nh), a.ip, a.len)) return a; return null; };
    const lookupRaw = (d, ipn, skipProto) => { let best = null; for (const r of R.rib[d]) { if (skipProto && skipProto.includes(r.proto)) continue; if (!inNet(n2ip(ipn), n2ip(r.pfx), r.len)) continue; if (!best || r.len > best.len || (r.len === best.len && (r.ad < best.ad || (r.ad === best.ad && r.metric < best.metric)))) best = r; } return best; };
    const resolve = (d, nh, depth) => { depth = depth || 0; if (depth > 4) return null; const c = connectedNh(d, nh); if (c) return { ifc: c.ifc, hop: nh, direct: true }; const r = lookupRaw(d, nh, ["L"]); if (!r || r.proto === "C" || !r.nh) return null; if (r.nh === nh) return null; return resolve(d, r.nh, depth + 1); };
    R.resolve = resolve;
    for (const n of names) for (const s of dev(n).statics) { const nh = ip2n(s.nh); if (nh === null || !resolve(n, nh)) continue; addRoute(n, { pfx: netOf(s.pfx, s.len), len: s.len, proto: "S", ad: s.ad || adFor(dev(n), "S"), metric: 0, nh, ifc: resolve(n, nh).ifc }); }
    // ospf SPF
    const spf = (extPrev) => {
      for (const n of ospfDevs) R.rib[n] = R.rib[n].filter((r) => r.proto !== "O" && r.proto !== "E2");
      const stubs = {}; for (const n of ospfDevs) { stubs[n] = []; for (const nm of dev(n).order) { const i = dev(n).ifs[nm]; if (!i.ip || !R.line[n][nm]) continue; const o = ospfIf(n, nm); if (!o) continue; const host = i.loopback; stubs[n].push({ pfx: netOf(i.ip.addr, host ? 32 : i.ip.len), len: host ? 32 : i.ip.len, cost: i.ospf.cost || 1 }); } }
      const ext = {}; for (const n of ospfDevs) { ext[n] = []; const rd = dev(n).ospf.redist || {}; if (rd.static) for (const s of dev(n).statics) { if (R.rib[n].some((r) => r.proto === "S" && r.pfx === netOf(s.pfx, s.len) && r.len === s.len)) ext[n].push({ pfx: netOf(s.pfx, s.len), len: s.len }); } if (rd.connected) for (const a of R.att) if (a.dev === n && !ospfIf(n, a.ifc) && !dev(n).ifs[a.ifc].loopback) ext[n].push({ pfx: netOf(a.ip, a.len), len: a.len }); if (rd.bgp && extPrev) for (const r of extPrev[n] || []) ext[n].push({ pfx: r.pfx, len: r.len }); }
      for (const src of ospfDevs) {
        const dist = { [src]: { d: 0, first: null } }, todo = [src], done = new Set();
        while (todo.length) { todo.sort((x, y) => dist[x].d - dist[y].d); const u = todo.shift(); if (done.has(u)) continue; done.add(u); for (const e of edges) { let v = null, cost = 0, out = null, nhAtt = null; if (e.a.dev === u) { v = e.b.dev; cost = e.ca; out = e.a; nhAtt = e.b; } else if (e.b.dev === u) { v = e.a.dev; cost = e.cb; out = e.b; nhAtt = e.a; } if (!v || done.has(v)) continue; const nd = dist[u].d + cost; if (!dist[v] || nd < dist[v].d) { dist[v] = { d: nd, first: u === src ? { ifc: out.ifc, nh: ip2n(nhAtt.ip) } : dist[u].first }; if (todo.indexOf(v) < 0) todo.push(v); } } }
        const have = new Set(R.rib[src].filter((r) => r.proto === "C").map((r) => r.len + ":" + r.pfx));
        for (const v of Object.keys(dist)) { if (v === src) continue; for (const s of stubs[v]) { const key = s.len + ":" + s.pfx; if (have.has(key)) continue; const metric = dist[v].d + s.cost; const ex = R.rib[src].find((r) => r.proto === "O" && r.len === s.len && r.pfx === s.pfx); if (ex) { if (metric < ex.metric) { ex.metric = metric; ex.nh = dist[v].first.nh; ex.ifc = dist[v].first.ifc; } continue; } addRoute(src, { pfx: s.pfx, len: s.len, proto: "O", ad: adFor(dev(src), "O"), metric, nh: dist[v].first.nh, ifc: dist[v].first.ifc }); }
          for (const x of ext[v] || []) { const key = x.len + ":" + x.pfx; if (have.has(key) || R.rib[src].some((r) => (r.proto === "O" || r.proto === "E2") && r.len === x.len && r.pfx === x.pfx)) continue; addRoute(src, { pfx: x.pfx, len: x.len, proto: "E2", ad: adFor(dev(src), "E2"), metric: 20, nh: dist[v].first.nh, ifc: dist[v].first.ifc, asbr: R.ospf[v].rid }); } }
      }
    };
    spf(null);

    // 4. BGP -----------------------------------------------------------------
    const bgpDevs = names.filter((n) => dev(n).bgp);
    const prefStr = (p, l) => n2ip(p) + "/" + l;
    const igpRib = {}; for (const n of names) igpRib[n] = R.rib[n].slice();
    const ownerOf = (ipS) => { for (const n of names) for (const nm of dev(n).order) { const i = dev(n).ifs[nm]; if (i.ip && i.ip.addr === ipS && (R.line[n][nm])) return { dev: n, ifc: nm }; } return null; };
    const srcFor = (d, nb) => { const B = dev(d).bgp; const nbr = B.neighbors[nb]; if (nbr.updateSource) { const i = dev(d).ifs[nbr.updateSource]; return i && i.ip && R.line[d][nbr.updateSource] ? i.ip.addr : null; } const r = resolve(d, ip2n(nb)); if (!r) return null; const i = dev(d).ifs[r.ifc]; return i.ip.addr; };
    const sessions = []; // {a, b, nbA, nbB}
    for (const d of bgpDevs) for (const nbIp of Object.keys(dev(d).bgp.neighbors)) {
      const nb = dev(d).bgp.neighbors[nbIp], rec = { dev: d, ip: nbIp, state: "Idle", reason: "", peerDev: null, pfxRcvd: 0, pfxSent: 0, remoteAs: nb.remoteAs, peerKey: null };
      R.bgp[d][nbIp] = rec;
      if (nb.shutdown) { rec.state = "Idle"; rec.reason = "Admin down"; continue; }
      const owner = ownerOf(nbIp); const reach = resolve(d, ip2n(nbIp));
      if (!reach) { rec.state = "Active"; rec.reason = "noroute"; ev(d, { kind: "bgp-noroute", peer: nbIp }); continue; }
      const src = srcFor(d, nbIp); if (!src) { rec.state = "Active"; rec.reason = "nosource"; continue; }
      if (!owner) { rec.state = "Active"; rec.reason = "nopeer"; continue; }
      const P = dev(owner.dev); rec.peerDev = owner.dev;
      const pb = P.bgp; if (!pb) { rec.state = "Active"; rec.reason = "refused"; continue; }
      const back = pb.neighbors[src];
      if (!back) { rec.state = "Active"; rec.reason = "refused"; ev(d, { kind: "bgp-refused", peer: nbIp }); continue; }
      if (back.shutdown) { rec.state = "Active"; rec.reason = "refused"; continue; }
      if (srcFor(owner.dev, src) !== nbIp) { rec.state = "Active"; rec.reason = "refused"; ev(d, { kind: "bgp-refused", peer: nbIp }); continue; }
      const rev = resolve(owner.dev, ip2n(src)); if (!rev) { rec.state = "Active"; rec.reason = "noreturn"; continue; }
      const ebgp = nb.remoteAs !== dev(d).bgp.asn;
      if (ebgp) {
        const direct = (n0, ipn, srcIp) => { const c = connectedNh(n0, ip2n(ipn)); return !!c && inNet(srcIp, c.ip, c.len); };
        const okMine = (nb.multihop || 1) >= 2 || direct(d, nbIp, src), okPeer = (back.multihop || 1) >= 2 || direct(owner.dev, src, nbIp);
        if (!okMine || !okPeer) { rec.state = "Active"; rec.reason = "ttl"; ev(d, { kind: "bgp-ttl", peer: nbIp }); continue; }
      }
      if ((nb.password || null) !== (back.password || null)) { rec.state = "Active"; rec.reason = "auth"; ev(d, { kind: "bgp-auth", peer: nbIp }); ev(owner.dev, { kind: "bgp-auth", peer: src }); continue; }
      if (nb.remoteAs !== pb.asn) { rec.state = "Idle"; rec.reason = "badas"; ev(d, { kind: "bgp-badas", peer: nbIp, sent: "received" , asn: nb.remoteAs, theirs: pb.asn }); continue; }
      if (back.remoteAs !== dev(d).bgp.asn) { rec.state = "Idle"; rec.reason = "badas-peer"; ev(d, { kind: "bgp-badas-peer", peer: nbIp }); continue; }
      const ridA = dev(d).bgp.rid || R.ospf[d].rid || ridOf(d), ridB = pb.rid || R.ospf[owner.dev].rid || ridOf(owner.dev);
      if (ridA === ridB) { rec.state = "Idle"; rec.reason = "badid"; ev(d, { kind: "bgp-badid", peer: nbIp }); continue; }
      rec.state = "Established"; rec.src = src; rec.peerSrc = nbIp; rec.peerAsn = pb.asn; rec.ebgp = ebgp; rec.peerNb = back; rec.myNb = nb; rec.rid = ridB;
      sessions.push(rec);
    }
    // route exchange
    const best = {}; for (const n of bgpDevs) { best[n] = {}; R.bgpTable[n] = {}; }
    const origin = (n) => {
      const B = dev(n).bgp, out = [];
      const add = (pfx, len, org) => out.push({ pfx, len, nh: null, asPath: [], lp: 100, med: 0, origin: org, from: "local", fromDev: n, ebgp: false, local: true, valid: true, rid: ridOf(n) });
      if (dev(n).os !== "junos") { for (const nw of B.networks || []) { const p = netOf(nw.ip, nw.len); if (R.rib[n].some((r) => r.pfx === p && r.len === nw.len && r.proto !== "B")) add(p, nw.len, "i"); } const rd = B.redist || {}; for (const r of igpRib[n]) { if (r.proto === "L") continue; const key = r.proto === "C" ? "connected" : r.proto === "S" ? "static" : r.proto === "O" || r.proto === "E2" ? "ospf" : null; if (key && rd[key] && !out.some((x) => x.pfx === r.pfx && x.len === r.len)) add(r.pfx, r.len, "?"); } }
      else for (const r of igpRib[n]) if (r.proto !== "L" && r.proto !== "B") add(r.pfx, r.len, "i");   // Junos: policy decides on export
      return out;
    };
    for (const n of bgpDevs) for (const p of origin(n)) { const k = prefStr(p.pfx, p.len); (R.bgpTable[n][k] = R.bgpTable[n][k] || []).push(p); }
    const valid = (n, p) => p.local || (p.nh !== null && !!resolve(n, p.nh));
    const better = (a, b) => { if (a.local !== b.local) return a.local; if (a.lp !== b.lp) return a.lp > b.lp; if (a.asPath.length !== b.asPath.length) return a.asPath.length < b.asPath.length; const o = { i: 0, e: 1, "?": 2 }; if (a.origin !== b.origin) return o[a.origin] < o[b.origin]; if (a.med !== b.med) return a.med < b.med; if (a.ebgp !== b.ebgp) return a.ebgp; return ip2n(a.rid) < ip2n(b.rid); };
    const pick = (n) => { for (const k of Object.keys(R.bgpTable[n])) { let b = null; for (const p of R.bgpTable[n][k]) { p.valid = valid(n, p); if (!p.valid) continue; if (!b || better(p, b)) b = p; } best[n][k] = b; for (const p of R.bgpTable[n][k]) p.best = p === b; } };
    for (let round = 0; round < 8; round++) {
      for (const n of bgpDevs) pick(n);
      let changed = false;
      for (const s of sessions) {
        const A = s.dev, B = s.peerDev, nbA = s.myNb, nbB = s.peerNb, aDev = dev(A), bDev = dev(B);
        const sendTo = (from, to, nbFrom, nbTo, fromSrc, toSrc, ebgp, fromDev, toDev) => {
          for (const k of Object.keys(R.bgpTable[from])) {
            const p = best[from][k]; if (!p) continue;
            if (p.from === toSrc) continue;                                                         // split horizon
            if (!p.local && !p.ebgp && !ebgp && !(nbFrom.rrClient || p.fromClient)) continue;  // iBGP-learned is not sent to iBGP (route reflection excepted)
            let r = { pfx: p.pfx, len: p.len, asPath: p.asPath.slice(), lp: p.lp, med: p.med, origin: p.origin, nh: p.nh };
            const junos = fromDev.os === "junos"; const proto = p.local ? (junos ? protoOf(from, p) : "local") : "bgp";
            const pol = applyMap(fromDev, nbFrom.rmOut, r, { proto, junos }); if (pol === "default") { if (junos && p.local) continue; } else if (pol === null) continue; else r = pol;
            if (nbFrom.prefixOut && !prefixListMatch(fromDev.prefixLists[nbFrom.prefixOut], r.pfx, r.len)) continue;
            if (junos && p.local && !nbFrom.rmOut) continue;
            if (ebgp) { r.asPath = [fromDev.bgp.asn].concat(r.asPath); r.nh = ip2n(fromSrc); r.lp = 100; if (p.med === undefined || !p.local) r.med = p.local ? r.med : 0; }
            else if (p.local || nbFrom.nhs || r.nhs) r.nh = ip2n(fromSrc);
            if (ebgp && r.asPath.indexOf(toDev.bgp.asn) >= 0) continue;
            const inb = applyMap(toDev, nbTo.rmIn, r, { proto: "bgp" }); let fin = inb === "default" ? r : inb; if (!fin) continue;
            if (nbTo.prefixIn && !prefixListMatch(toDev.prefixLists[nbTo.prefixIn], fin.pfx, fin.len)) continue;
            const path = { pfx: fin.pfx, len: fin.len, nh: fin.nh, asPath: fin.asPath, lp: fin.lp, med: fin.med, origin: fin.origin, from: fromSrc, fromDev: from, ebgp, local: false, rid: fromDev.bgp.rid || ridOf(from), fromClient: !!nbTo.rrClient };
            const key = prefStr(fin.pfx, fin.len); const list = (R.bgpTable[to][key] = R.bgpTable[to][key] || []);
            const ex = list.findIndex((q) => q.from === fromSrc);
            if (ex >= 0) { const o = list[ex]; if (JSON.stringify([o.nh, o.asPath, o.lp, o.med]) === JSON.stringify([path.nh, path.asPath, path.lp, path.med])) continue; list[ex] = path; } else list.push(path);
            changed = true;
          }
        };
        const protoOf = (n, p) => { const r = igpRib[n].find((x) => x.pfx === p.pfx && x.len === p.len); return r ? ({ C: "connected", S: "static", O: "ospf", E2: "ospf" }[r.proto] || "other") : "other"; };
        sendTo(A, B, nbA, nbB, s.src, s.peerSrc, s.ebgp, aDev, bDev);
        sendTo(B, A, nbB, nbA, s.peerSrc, s.src, s.ebgp, bDev, aDev);
      }
      for (const n of bgpDevs) { for (const k of Object.keys(R.bgpTable[n])) R.bgpTable[n][k] = R.bgpTable[n][k].filter((p) => p.local || sessions.some((s) => (s.dev === n && s.peerSrc === p.from) || (s.peerDev === n && s.src === p.from))); }
      if (!changed) break;
    }
    for (const n of bgpDevs) pick(n);
    for (const s of sessions) { const rc = R.bgpTable[s.dev]; let got = 0, sent = 0; for (const k of Object.keys(rc)) for (const p of rc[k]) if (p.from === s.peerSrc) got++; for (const k of Object.keys(R.bgpTable[s.peerDev])) for (const p of R.bgpTable[s.peerDev][k]) if (p.from === s.src) sent++; s.pfxRcvd = got; s.pfxSent = sent; }
    for (const n of bgpDevs) for (const k of Object.keys(best[n])) { const p = best[n][k]; if (!p || p.local) continue; const rs = resolve(n, p.nh); if (!rs) continue; if (R.rib[n].some((r) => r.pfx === p.pfx && r.len === p.len && (r.proto === "C" || r.proto === "S" && r.ad <= adFor(dev(n), "B", p.ebgp)))) continue; R.rib[n].push({ pfx: p.pfx, len: p.len, proto: "B", ad: adFor(dev(n), "B", p.ebgp), metric: p.med || 0, nh: p.nh, ifc: rs.ifc, ebgp: p.ebgp }); }

    // 5. final lookup
    R.lookup = (d, ipn) => { let b = null; for (const r of R.rib[d]) { if (!inNet(n2ip(ipn), n2ip(r.pfx), r.len)) continue; if (!b || r.len > b.len || (r.len === b.len && (r.ad < b.ad || (r.ad === b.ad && r.metric < b.metric)))) b = r; } return b; };
    R.ownerOf = ownerOf; R.attOf = attOf;
    R.resolveFinal = (d, nh) => { for (let k = 0, cur = nh; k < 5; k++) { const c = connectedNh(d, cur); if (c) return { ifc: c.ifc, hop: cur }; const r = R.lookup(d, cur); if (!r || !r.nh || r.nh === cur) return null; cur = r.nh; } return null; };
    return R;
  }

  // ------------------------------------------------------------ forwarding
  function aclPermits(dev, name, pkt) {
    if (!name) return true; const acl = dev.acls[name]; if (!acl) return true;
    for (const e of acl) {
      if (e.proto !== "ip" && e.proto !== pkt.proto) continue;
      const m = (spec, ipS) => spec === "any" || (spec.host ? spec.host === ipS : inNet(ipS, spec.ip, spec.len));
      if (!m(e.src, pkt.src) || !m(e.dst, pkt.dst)) continue;
      if (e.port !== undefined && e.port !== null && e.port !== pkt.port) continue;
      return e.action === "permit";
    }
    return false;
  }
  // One direction. Returns {ok, hops, fail}
  function walk(R, from, dstIp, srcIp, pkt) {
    const net = R.net, dst = ip2n(dstIp); const hops = []; let cur = from, ingress = null;
    pkt = Object.assign({ proto: "icmp", port: null, src: srcIp, dst: dstIp }, pkt || {});
    for (let ttl = 0; ttl < 32; ttl++) {
      const D = net.devices[cur];
      const own = R.att.find((a) => a.dev === cur && a.ip === dstIp);
      if (own) { if (ingress && !aclPermits(D, D.ifs[ingress].acl.in, pkt) && false) return { ok: false, hops, fail: { kind: "acl", at: cur } }; return { ok: true, hops, last: cur }; }
      const r = R.lookup(cur, dst);
      if (!r || r.proto === "L") return { ok: false, hops, fail: { kind: "noroute", at: cur } };
      let out = null, hopIp = dstIp;
      if (r.proto === "C") out = r.ifc; else { const rs = R.resolveFinal(cur, r.nh); if (!rs) return { ok: false, hops, fail: { kind: "noroute", at: cur } }; out = rs.ifc; hopIp = n2ip(rs.hop); }
      if (!aclPermits(D, D.ifs[out].acl.out, pkt)) return { ok: false, hops, fail: { kind: "acl", at: cur, ifc: out, dir: "out" } };
      const myAtt = R.attOf(cur, out); const cands = R.att.filter((a) => a.seg === myAtt.seg && a.dev !== cur && a.ip === hopIp); const next = cands.find((a) => net.links.some((l) => (l.a.dev === cur && l.b.dev === a.dev) || (l.b.dev === cur && l.a.dev === a.dev))) || cands[0];
      if (!next) return { ok: false, hops, fail: { kind: "arp", at: cur, ifc: out, ip: hopIp } };
      const ND = net.devices[next.dev];
      if (!aclPermits(ND, ND.ifs[next.ifc].acl.in, pkt)) return { ok: false, hops, fail: { kind: "acl", at: next.dev, ifc: next.ifc, dir: "in" } };
      hops.push({ dev: next.dev, ifc: next.ifc, ip: next.ip, from: cur }); cur = next.dev; ingress = next.ifc;
    }
    return { ok: false, hops, fail: { kind: "ttl", at: cur } };
  }
  function ping(R, from, dstIp, o) {
    o = o || {}; const D = R.net.devices[from];
    if (ip2n(dstIp) === null) return { ok: false, fail: { kind: "bad" }, hops: [] };
    let srcIp = o.source || null;
    if (!srcIp) { const r = R.lookup(from, ip2n(dstIp)); if (r && r.proto !== "L") { const out = r.proto === "C" ? r.ifc : (R.resolveFinal(from, r.nh) || {}).ifc; const i = out && D.ifs[out]; if (i && i.ip) srcIp = i.ip.addr; } const own = R.att.find((a) => a.dev === from && a.ip === dstIp); if (own) srcIp = dstIp; }
    if (!srcIp) return { ok: false, fail: { kind: "noroute", at: from }, hops: [], srcIp: null };
    const f = walk(R, from, dstIp, srcIp, { proto: o.proto || "icmp", port: o.port || null });
    if (!f.ok) return Object.assign({ srcIp }, f);
    const b = walk(R, f.last, srcIp, dstIp, { proto: o.proto || "icmp", port: null });
    if (!b.ok) return { ok: false, srcIp, hops: f.hops, fail: { kind: "timeout", at: b.fail.at, back: b.fail }, replied: false };
    return { ok: true, srcIp, hops: f.hops, back: b.hops, replier: f.last };
  }
  function compute(net) {
    const R = computeCore(net);
    if (api.overlay && Object.values(net.devices).some((d) => d.vxlan)) { const o = api.overlay(R); R.evpn = o.info; if (o.unions.length) { const R2 = computeCore(net, { unions: o.unions }); R2.evpn = o.info; return R2; } }
    return R;
  }
  function neighbors(net, d) { const out = []; const D = net.devices[d]; for (const nm of D.order) { const pe = peerOf(net, d, nm); if (pe && pe.link.up !== false) out.push({ ifc: nm, peerDev: pe.dev, peerIf: pe.ifc }); } return out; }

  const api = { normArea, adFor, ip2n, n2ip, lenMask, maskLen, wildLen, netOf, inNet, cidr, newNet, addDevice, addIf, connect, peerOf, clone, isSwitchport, prefixListMatch, applyMap, compute, ping, walk, neighbors, aclPermits };
  root.Netsim = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
