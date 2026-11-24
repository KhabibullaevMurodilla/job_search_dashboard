/* Netevpn: VXLAN with a BGP EVPN control plane (NX-OS and EOS leaves and spines).
   evaluate() works out, from the real configuration, which VTEPs are up, which EVPN routes
   reach which leaf (sessions, route reflection, extended communities, route targets) and
   therefore which VLANs are stretched between leaves. The result is fed back into the
   layer-2 model, so hosts really can or cannot reach each other across the fabric. */
(function (root) {
  "use strict";
  const N = root.Netsim || require("./netsim.js");
  const C = root.Netcli || require("./netcli.js");
  const IOS = root.Netios || require("./netios.js");
  const { pad, padL, hash } = C;
  const { ip2n, n2ip } = N;
  const macOf = (k) => { const h = hash(k).toString(16).padStart(8, "0"); return `0050.56${h.slice(0, 2)}.${h.slice(2, 6)}`; };
  const rts = (D, list, vni) => (list || []).map((x) => (x === "auto" ? `${D.bgp ? D.bgp.asn : 0}:${vni}` : x));

  function vniCfg(D, v) {
    const x = D.vxlan, vni = x && x.vlanVni && x.vlanVni[v]; if (!vni) return null;
    const E = D.evpn || {}, c = D.os === "nxos" ? (E.vnis || {})[vni] : (E.vlans || {})[v];
    return { vni, has: !!c, rd: c && c.rd, imp: rts(D, c && c.imp, vni), exp: rts(D, c && c.exp, vni) };
  }
  function vtep(R, n) {
    const D = R.net.devices[n], x = D.vxlan; if (!x) return null;
    if (D.os === "nxos" && !(x.features && x.features.nv && x.features.nvEvpn)) return { up: false, reason: "feature nv overlay or nv overlay evpn is not enabled" };
    const nv = x.nve; if (!nv || !D.ifs[nv.ifc]) return { up: false, reason: "no NVE interface configured" };
    if (D.ifs[nv.ifc].shutdown) return { up: false, reason: "NVE interface is administratively down" };
    const src = nv.src && D.ifs[nv.src]; if (!src) return { up: false, reason: "no source interface configured" };
    if (!src.ip) return { up: false, reason: "source interface has no IP address" };
    if (!R.line[n][nv.src]) return { up: false, reason: "source interface is down" };
    return { up: true, ip: src.ip.addr, src: nv.src };
  }
  function hostsOf(R, n, v) { // locally attached hosts in vlan v
    const D = R.net.devices[n], out = [];
    for (const nm of D.order) { const i = D.ifs[nm]; if (i.mode !== "access" || i.accessVlan !== v || !R.line[n][nm]) continue; const pe = N.peerOf(R.net, n, nm); if (!pe) continue; const H = R.net.devices[pe.dev]; if (H.os !== "linux") continue; const hi = H.ifs[pe.ifc]; out.push({ port: nm, host: pe.dev, mac: macOf(pe.dev + pe.ifc), ip: hi && hi.ip ? hi.ip.addr : "0.0.0.0" }); }
    return out;
  }

  function evaluate(R) {
    const net = R.net, names = Object.keys(net.devices).filter((n) => net.devices[n].vxlan), info = {}, unions = [];
    // BGP evpn edges (an edge exists only when the TCP session is up)
    const E = {};
    for (const a of Object.keys(net.devices)) { E[a] = {}; if (!net.devices[a].bgp) continue; for (const rec of Object.values(R.bgp[a] || {})) if (rec.state === "Established") { const mine = rec.myNb || {}, theirs = rec.peerNb || {}; E[a][rec.peerDev] = { cap: !!(mine.evpn && theirs.evpn), ext: !!mine.extComm, rr: !!mine.rrClient }; } }
    const V = {}; for (const n of names) V[n] = vtep(R, n);
    const orig = {};
    for (const n of names) { const D = net.devices[n]; orig[n] = { t3: [], t2: [] }; if (!V[n].up) continue; for (const v of Object.keys(D.vxlan.vlanVni).map(Number)) { const c = vniCfg(D, v); if (!c || !c.has || D.vlans[v] === undefined) continue; if (D.os === "nxos" && !(D.vxlan.members && D.vxlan.members[c.vni])) continue; orig[n].t3.push({ vlan: v, vni: c.vni }); for (const h of hostsOf(R, n, v)) orig[n].t2.push(Object.assign({ vlan: v, vni: c.vni }, h)); } }
    const vl = (n, vni) => { const D = net.devices[n]; for (const v of Object.keys(D.vxlan.vlanVni)) if (D.vxlan.vlanVni[v] === vni && orig[n].t3.some((t) => t.vni === vni)) return +v; return null; };
    const others = Object.keys(net.devices).filter((x) => net.devices[x].bgp);
    // does a route of A reach B, and does it carry its route targets?
    const path = (A, B) => {
      let best = null;
      const d = E[A][B]; if (d && d.cap) best = { ok: true, rt: d.ext };
      for (const S of others) { if (S === A || S === B) continue; const e1 = E[A][S], e2 = E[S][B]; if (!e1 || !e2 || !e1.cap || !e2.cap) continue; const sRr = E[S][A] && E[S][B] && (E[S][A].rr || E[S][B].rr); if (!sRr) continue; const p = { ok: true, rt: e1.ext && e2.ext }; if (!best || (!best.rt && p.rt)) best = p; }
      return best;
    };
    const underlay = (A, B) => { const r = N.ping(R, A, V[B].ip, { source: V[A].ip }); return !!r.ok; };
    const dir = {}; // dir[A][B][vni] = {reach, imported}
    for (const A of names) { dir[A] = {}; for (const B of names) { if (A === B) continue; dir[A][B] = {}; const p = (V[A].up && V[B].up) || true ? path(A, B) : null; if (!p) continue; for (const t of orig[A].t3) { const vb = vl(B, t.vni) || (net.devices[B].vxlan.vlanVni && Object.keys(net.devices[B].vxlan.vlanVni).map(Number).find((x) => net.devices[B].vxlan.vlanVni[x] === t.vni)); const cb = vb && vniCfg(net.devices[B], vb), ca = vniCfg(net.devices[A], t.vlan); const match = !!(cb && ca && ca.exp.some((x) => cb.imp.indexOf(x) >= 0)); dir[A][B][t.vni] = { received: true, imported: p.rt && match && !!V[B].up && orig[B].t3.some((q) => q.vni === t.vni), rt: p.rt, match, vlanB: vb }; } } }
    // per-device info
    for (const n of names) {
      const D = net.devices[n], me = { vtep: V[n], vnis: {}, orig: orig[n], pfx: {}, macs: [] };
      for (const v of Object.keys(D.vxlan.vlanVni).map(Number)) {
        const c = vniCfg(D, v), peers = [], member = D.os !== "nxos" || !!(D.vxlan.members && D.vxlan.members[c.vni]);
        for (const B of names) if (B !== n && dir[B][n] && dir[B][n][c.vni] && dir[B][n][c.vni].imported && orig[n].t3.some((t) => t.vni === c.vni)) { const ok = V[n].up && V[B].up && underlay(n, B) && underlay(B, n); peers.push({ ip: V[B].ip, dev: B, state: ok ? "Up" : "Down" }); }
        me.vnis[v] = { vni: c.vni, vlan: v, up: V[n].up && member && D.vlans[v] !== undefined && c.has, peers, rd: c.rd, imp: c.imp, exp: c.exp, member, hasCfg: c.has, vlanExists: D.vlans[v] !== undefined };
        for (const h of hostsOf(R, n, v)) me.macs.push({ vlan: v, mac: h.mac, ip: h.ip, local: true, port: h.port });
        for (const p of peers) if (p.state === "Up") for (const t of orig[p.dev].t2) if (t.vni === c.vni) me.macs.push({ vlan: v, mac: t.mac, ip: t.ip, local: false, peer: p.ip });
      }
      info[n] = me;
    }
    // stretch
    for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
      const A = names[i], B = names[j]; if (!V[A].up || !V[B].up) continue; let u = null;
      for (const t of orig[A].t3) { const ab = dir[A][B][t.vni], ba = dir[B][A][t.vni]; if (!ab || !ba || !ab.imported || !ba.imported) continue; if (u === null) u = underlay(A, B) && underlay(B, A); if (!u) continue; const vb = vl(B, t.vni); if (vb) unions.push([{ dev: A, vlan: t.vlan }, { dev: B, vlan: vb }]); }
    }
    // evpn prefix counts per session
    for (const a of others) { for (const [nbIp, rec] of Object.entries(R.bgp[a] || {})) { const out = { rcvd: 0, sent: 0, cap: false }; if (rec.state === "Established") { const e = E[a][rec.peerDev]; out.cap = !!(e && e.cap); if (out.cap) for (const O of names) { const cnt = orig[O].t3.length + orig[O].t2.length; if (O === rec.peerDev && O !== a) out.rcvd += cnt; else if (O !== a && O !== rec.peerDev && !net.devices[rec.peerDev].vxlan) { const eo = E[O][rec.peerDev]; if (eo && eo.cap && E[rec.peerDev][a] && E[rec.peerDev][a].cap && ((E[rec.peerDev][O] && E[rec.peerDev][O].rr) || E[rec.peerDev][a].rr)) out.rcvd += cnt; } } } (info[a] = info[a] || { vnis: {}, macs: [], orig: { t3: [], t2: [] }, pfx: {} }).pfx[nbIp] = out; } }
    return { info, unions, V, dir, E };
  }
  N.overlay = evaluate;

  // ---------------------------------------------------------------- show output
  const upt = (k) => `00:${String(2 + (hash(k) % 50)).padStart(2, "0")}:${String(hash(k + "x") % 60).padStart(2, "0")}`;
  const EV = (c) => (c.R.evpn || {})[c.d] || { vnis: {}, macs: [], orig: { t3: [], t2: [] }, pfx: {} };
  const nveName = (c) => (c.D.vxlan && c.D.vxlan.nve ? c.D.vxlan.nve.ifc : "nve1");
  function nxPeers(c) {
    const ev = EV(c), L = ["Interface Peer-IP          State LearnType Uptime   Router-Mac       ", "--------- ---------------  ----- --------- -------- -----------------"], seen = new Set();
    for (const v of Object.values(ev.vnis)) for (const p of v.peers) if (!seen.has(p.ip)) { seen.add(p.ip); L.push(`${pad(nveName(c), 9)} ${pad(p.ip, 16)} ${pad(p.state, 5)} ${pad("CP", 9)} ${pad(upt(c.d + p.ip), 8)} n/a`); }
    return L.join("\n");
  }
  function nxVni(c) {
    const ev = EV(c), L = ["Codes: CP - Control Plane        DP - Data Plane", "       UC - Unconfigured         SA - Suppress ARP", "       SU - Suppress Unknown Unicast", "", "Interface VNI      Multicast-group   State Mode Type [BD/VRF]      Flags", "--------- -------- ----------------- ----- ---- ------------------ -----"];
    const mem = (c.D.vxlan && c.D.vxlan.members) || {};
    for (const v of Object.values(ev.vnis).sort((a, b) => a.vni - b.vni)) if (mem[v.vni]) L.push(`${pad(nveName(c), 9)} ${pad(v.vni, 8)} ${pad("UnicastBGP", 17)} ${pad(v.up ? "Up" : "Down", 5)} ${pad("CP", 4)} ${pad("L2 [" + v.vlan + "]", 18)}`);
    return L.join("\n");
  }
  function nxIface(c) {
    const x = c.D.vxlan, ev = EV(c), v = ev.vtep || { up: false, reason: "" }; if (!x || !x.nve) return "";
    const src = x.nve.src && c.D.ifs[x.nve.src];
    return `Interface: ${x.nve.ifc}, State: ${v.up ? "Up" : "Down"}, encapsulation: VXLAN\n VPC Capability: VPC-VIP-Only [not-notified]\n Local Router MAC: ${macOf(c.d)}\n Host Learning Mode: Control-Plane\n Source-Interface: ${x.nve.src || "none"} (primary: ${src && src.ip ? src.ip.addr : "0.0.0.0"}, secondary: 0.0.0.0)`;
  }
  function evpnSummary(c, eos) {
    const D = c.D, B = D.bgp, ev = EV(c); if (!B) return "% BGP not active";
    const rows = Object.entries(B.neighbors).filter(([ip, nb]) => nb.evpn || eos === false);
    const L = [];
    if (eos) { L.push("BGP summary information for VRF default", `Router identifier ${B.rid || ""}, local AS number ${B.asn}`, "Neighbor Status Codes: m - Under maintenance", "  Neighbor         V AS           MsgRcvd   MsgSent  InQ OutQ  Up/Down State   PfxRcd PfxAcc"); }
    else { L.push("BGP summary information for VRF default, address family L2VPN EVPN", `BGP router identifier ${B.rid || ""}, local AS number ${B.asn}`, `BGP table version is 12, L2VPN EVPN config peers ${rows.length}, capable peers ${rows.filter(([ip]) => (ev.pfx[ip] || {}).cap).length}`, "", "Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd"); }
    for (const [ip, nb] of rows) { const s = c.R.bgp[c.d][ip], est = s && s.state === "Established", p = ev.pfx[ip] || { rcvd: 0 }, st = est ? String(p.rcvd) : (s && s.state === "Idle" ? "Idle" : "Active");
      L.push(eos ? `  ${pad(ip, 16)} 4 ${pad(nb.remoteAs, 12)} ${padL(est ? 12 + (hash(c.d + ip) % 9) : 0, 7)} ${padL(est ? 10 : 3, 9)} ${padL(0, 3)} ${padL(0, 4)} ${pad(est ? upt(c.d + ip) : "never", 8)} ${pad(est ? "Estab" : st, 7)} ${padL(est ? p.rcvd : "", 6)} ${padL(est ? p.rcvd : "", 6)}` : `${pad(ip, 15)} 4 ${padL(nb.remoteAs, 5)} ${padL(est ? 12 + (hash(c.d + ip) % 9) : 0, 7)} ${padL(est ? 10 : 3, 7)} ${padL(12, 8)} ${padL(0, 3)} ${padL(0, 4)} ${pad(est ? upt(c.d + ip) : "never", 9)} ${st}`); }
    return L.join("\n");
  }
  function routeLines(c, type, eos) {
    const ev = EV(c), L = [], D = c.D, rid = D.vxlan && ev.vtep && ev.vtep.ip ? ev.vtep.ip : (D.bgp && D.bgp.rid) || "";
    const t2 = (m, ip, nh, loc) => `${loc ? "*>l" : "*>i"}[2]:[0]:[0]:[48]:[${m}]:[${ip ? 32 : 0}]:[${ip || "0.0.0.0"}]/${ip ? 272 : 216}  ${pad(nh, 15)} ${pad(100, 4)} ${loc ? 32768 : 0} i`;
    const t3 = (ip, nh, loc) => `${loc ? "*>l" : "*>i"}[3]:[0]:[32]:[${ip}]/88  ${pad(nh, 15)} ${pad(100, 4)} ${loc ? 32768 : 0} i`;
    const want2 = !type || type === "2" || /mac/.test(type), want3 = !type || type === "3" || /imet|multicast/.test(type);
    if (D.vxlan && !ev.vtep) return "";
    for (const v of Object.values(ev.vnis)) if (v.up || v.peers.length) {
      L.push(`Route Distinguisher: ${rid}:${32767 + v.vlan}    (L2VNI ${v.vni})`);
      if (want3 && v.up) L.push(t3(rid, rid, true));
      if (want2) for (const m of ev.macs.filter((x) => x.vlan === v.vlan && x.local)) L.push(t2(m.mac, m.ip, rid, true));
      if (want3) for (const p of v.peers) L.push(t3(p.ip, p.ip, false));
      if (want2) for (const m of ev.macs.filter((x) => x.vlan === v.vlan && !x.local)) L.push(t2(m.mac, m.ip, m.peer, false));
      L.push("");
    }
    return L.join("\n");
  }
  function l2route(c) {
    const ev = EV(c), L = ["Topology    Mac Address    Prod   Flags         Seq No     Next-Hops", "----------- -------------- ------ ------------- ---------- ----------------"];
    for (const m of ev.macs) L.push(`${pad(m.vlan, 11)} ${pad(m.mac, 14)} ${pad(m.local ? "Local" : "BGP", 6)} ${pad(m.local ? "L," : "SplRcv", 13)} ${pad(0, 10)} ${m.local ? m.port : m.peer}`);
    return L.join("\n");
  }
  function eosVtep(c) {
    const ev = EV(c), L = [`Remote VTEPS for ${nveName(c)}:`, "", "VTEP              Tunnel Type(s)", "----------------- --------------"], seen = new Set();
    for (const v of Object.values(ev.vnis)) for (const p of v.peers) if (!seen.has(p.ip) && p.state === "Up") { seen.add(p.ip); L.push(`${pad(p.ip, 17)} flood, unicast`); }
    L.push(`Total number of remote VTEPS:  ${seen.size}`); return L.join("\n");
  }
  function eosVni(c) {
    const ev = EV(c), L = [`VNI to VLAN Mapping for ${nveName(c)}`, "VNI        VLAN       Source       Interface       802.1Q Tag", "---------- ---------- ------------ --------------- ----------"];
    for (const v of Object.values(ev.vnis).sort((a, b) => a.vni - b.vni)) L.push(`${pad(v.vni, 10)} ${pad(v.vlan, 10)} ${pad("static", 12)} ${pad("", 15)} untagged`);
    return L.join("\n");
  }
  function eosAddr(c) {
    const ev = EV(c), L = ["          Vxlan Mac Address Table", "----------------------------------------------------------------------", "VLAN  Mac Address     Type      Prt  VTEP             Moves   Last Move", "----  -----------     ----      ---  ----             -----   ---------"]; let n = 0;
    for (const m of ev.macs) if (!m.local) { n++; L.push(`${padL(m.vlan, 4)}  ${pad(m.mac, 14)}  ${pad("EVPN", 8)}  Vx1  ${pad(m.peer, 15)}  1       0:01:23 ago`); }
    L.push(`Total Remote Mac Addresses for this criterion: ${n}`); return L.join("\n");
  }
  function sanity(c) {
    const D = c.D, ev = EV(c), v = ev.vtep || { up: false, reason: "no NVE" }, B = D.bgp, L = ["Category                            Result  Detail", "---------------------------------- -------- ----------------------------------------------"];
    const row = (k, ok, d) => L.push(`${pad(k, 34)} ${pad(ok ? "OK" : "FAIL", 8)} ${d || ""}`);
    row("Local VTEP Configuration Check", v.up, v.up ? "" : v.reason);
    const nb = B ? Object.entries(B.neighbors) : [];
    row("  Source interface and IP", v.up, v.up ? `${v.src} ${v.ip}` : v.reason);
    row("  VLAN-VNI map", Object.keys(D.vxlan.vlanVni).length > 0, Object.keys(D.vxlan.vlanVni).length ? "" : "no VLAN-VNI mapping");
    row("BGP EVPN configuration", nb.some(([, n]) => n.evpn), nb.some(([, n]) => n.evpn) ? "" : "no neighbor activated in address-family evpn");
    row("  send-community extended", nb.filter(([, n]) => n.evpn).every(([, n]) => n.extComm) && nb.some(([, n]) => n.evpn), nb.filter(([, n]) => n.evpn && !n.extComm).map(([ip]) => `neighbor ${ip} does not send extended communities`).join("; "));
    const bad = Object.values(ev.vnis).filter((x) => !x.hasCfg);
    row("  Route-target / RD per VLAN", !bad.length, bad.map((x) => `VLAN ${x.vlan} has no evpn route-target config`).join("; "));
    const nopeers = Object.values(ev.vnis).filter((x) => x.up && !x.peers.length);
    row("Remote VTEPs per VNI", !nopeers.length, nopeers.map((x) => `VNI ${x.vni} has no remote VTEP`).join("; "));
    return L.join("\n");
  }

  // ---------------------------------------------------------------- configuration commands
  const CFG = ["config"], IF = ["if"], BGP = ["bgp", "af"], OK = "", BAD = "% Invalid input detected at '^' marker.";
  const nvx = (c) => (c.D.vxlan = c.D.vxlan || { features: {}, nve: null, vlanVni: {}, members: {} });
  const inv = "% Invalid command at '^' marker.";
  const T = [], E = (p, modes, run) => T.push({ p, modes, run });
  const cur = (c) => c.D.ifs[c.s.ctx.ifc];
  const srcIf = (c, name) => { const nm = C.resolveIf(c.D, name); return nm; };
  // features and globals
  E("feature nv overlay", CFG, (c) => { if (c.style !== "nxos") return BAD; nvx(c).features.nv = true; c.s.touch(); return OK; });
  E("feature vn-segment-vlan-based", CFG, (c) => { if (c.style !== "nxos") return BAD; nvx(c).features.vnseg = true; c.s.touch(); return OK; });
  E("nv overlay evpn", CFG, (c) => { if (c.style !== "nxos") return BAD; nvx(c).features.nvEvpn = true; c.s.touch(); return OK; });
  E("no nv overlay evpn", CFG, (c) => { if (c.D.vxlan) c.D.vxlan.features.nvEvpn = false; c.s.touch(); return OK; });
  E("fabric forwarding anycast-gateway-mac <m>", CFG, (c, a) => { if (c.style !== "nxos") return BAD; nvx(c).gwMac = a.m; c.s.touch(); return OK; });
  E("ip virtual-router mac-address <m>", CFG, (c, a) => { if (c.style !== "eos") return BAD; nvx(c).gwMac = a.m; c.s.touch(); return OK; });
  // vlan-to-vni (NX-OS: under vlan)
  E("vn-segment <n>", ["vlan"], (c, a) => { const x = nvx(c); if (c.style !== "nxos" || !x.features.vnseg) return inv; x.vlanVni[c.s.ctx.vlan] = +a.n; c.s.touch(); return OK; });
  E("no vn-segment <n?>", ["vlan"], (c) => { if (c.D.vxlan) delete c.D.vxlan.vlanVni[c.s.ctx.vlan]; c.s.touch(); return OK; });
  // NVE interface
  const virt = (c) => { const i = cur(c); return i && i.virtual; };
  E("source-interface <i>", IF, (c, a) => { if (c.style !== "nxos" || !virt(c)) return BAD; const nm = srcIf(c, a.i); if (!nm) return BAD; c.D.vxlan.nve.src = nm; c.s.touch(); return OK; });
  E("no source-interface <i?>", IF, (c) => { if (!virt(c)) return BAD; c.D.vxlan.nve.src = null; c.s.touch(); return OK; });
  E("vxlan source-interface <i>", IF, (c, a) => { if (c.style !== "eos" || !virt(c)) return BAD; const nm = srcIf(c, a.i); if (!nm) return BAD; c.D.vxlan.nve.src = nm; c.s.touch(); return OK; });
  E("no vxlan source-interface <i?>", IF, (c) => { if (!virt(c)) return BAD; c.D.vxlan.nve.src = null; c.s.touch(); return OK; });
  E("vxlan udp-port <n>", IF, (c) => (virt(c) ? OK : BAD));
  E("vxlan learn-restrict <x...>", IF, (c) => (virt(c) ? OK : BAD));
  E("vxlan vlan <v> vni <n>", IF, (c, a) => { if (c.style !== "eos" || !virt(c)) return BAD; c.D.vxlan.vlanVni[+a.v] = +a.n; c.s.touch(); return OK; });
  E("no vxlan vlan <v> vni <n?>", IF, (c, a) => { if (virt(c)) delete c.D.vxlan.vlanVni[+a.v]; c.s.touch(); return OK; });
  E("host-reachability protocol bgp", IF, (c) => (virt(c) && c.style === "nxos" ? OK : BAD));
  E("member vni <n> <x?>", IF, (c, a) => { if (c.style !== "nxos" || !virt(c)) return BAD; c.D.vxlan.members[+a.n] = true; c.s.touch(); return OK; });
  E("no member vni <n> <x?>", IF, (c, a) => { if (virt(c)) delete c.D.vxlan.members[+a.n]; c.s.touch(); return OK; });
  E("ingress-replication protocol bgp", IF, (c) => (virt(c) ? OK : BAD));
  E("mcast-group <x>", IF, (c) => (virt(c) ? OK : BAD));
  // anycast gateway on SVIs
  E("fabric forwarding mode anycast-gateway", IF, (c) => { if (c.style !== "nxos" || !cur(c).svi) return BAD; cur(c).anycast = true; c.s.touch(); return OK; });
  E("no fabric forwarding mode anycast-gateway", IF, (c) => { cur(c).anycast = false; c.s.touch(); return OK; });
  E("ip address virtual <p>", IF, (c, a) => { if (c.style !== "eos") return BAD; const p = N.cidr(a.p); if (!p) return BAD; cur(c).ip = { addr: p.ip, len: p.len }; cur(c).anycast = true; c.s.touch(); return OK; });
  // NX-OS evpn block
  E("evpn", CFG, (c) => { if (c.style !== "nxos") return BAD; if (!(c.D.vxlan && c.D.vxlan.features.nvEvpn)) return inv; c.D.evpn = c.D.evpn || { vnis: {}, vlans: {} }; c.s.mode = "evpn"; return OK; });
  E("vni <n> l2", ["evpn"], (c, a) => { c.D.evpn.vnis[+a.n] = c.D.evpn.vnis[+a.n] || { rd: null, imp: [], exp: [] }; c.s.mode = "evpnvni"; c.s.ctx.vni = +a.n; c.s.touch(); return OK; });
  // EOS: per-VLAN block under router bgp
  E("vlan <v>", ["bgp"], (c, a) => { if (c.style !== "eos") return BAD; c.D.evpn = c.D.evpn || { vnis: {}, vlans: {} }; c.D.evpn.vlans[+a.v] = c.D.evpn.vlans[+a.v] || { rd: null, imp: [], exp: [] }; c.s.mode = "macvrf"; c.s.ctx.vlan = +a.v; c.s.touch(); return OK; });
  const blk = (c) => (c.s.mode === "evpnvni" ? c.D.evpn.vnis[c.s.ctx.vni] : c.D.evpn.vlans[c.s.ctx.vlan]);
  E("rd <x>", ["evpnvni", "macvrf"], (c, a) => { blk(c).rd = a.x; c.s.touch(); return OK; });
  E("redistribute learned", ["macvrf"], (c) => { blk(c).learned = true; c.s.touch(); return OK; });
  const rtSet = (c, dir, x, add) => { const b = blk(c), ds = dir === "both" ? ["imp", "exp"] : dir === "import" ? ["imp"] : ["exp"]; for (const k of ds) { b[k] = b[k].filter((y) => y !== x); if (add) b[k].push(x); } c.s.touch(); return OK; };
  E("route-target <d> <x>", ["evpnvni", "macvrf"], (c, a) => (/^(import|export|both)$/.test(a.d) ? rtSet(c, a.d, a.x, true) : BAD));
  E("route-target <d> evpn <x>", ["macvrf"], (c, a) => (/^(import|export|both)$/.test(a.d) ? rtSet(c, a.d, a.x, true) : BAD));
  E("no route-target <d> <x>", ["evpnvni", "macvrf"], (c, a) => (/^(import|export|both)$/.test(a.d) ? rtSet(c, a.d, a.x, false) : BAD));
  E("no rd <x?>", ["evpnvni", "macvrf"], (c) => { blk(c).rd = null; c.s.touch(); return OK; });
  // NX-OS neighbor sub-mode
  const nbOf = (c) => c.D.bgp.neighbors[c.s.ctx.nbr];
  E("neighbor <ip>", ["bgp"], (c, a) => { if (c.style !== "nxos") return "% Incomplete command."; if (ip2n(a.ip) === null) return BAD; if (!c.D.bgp.neighbors[a.ip]) c.D.bgp.neighbors[a.ip] = { remoteAs: 0 }; c.s.mode = "nbr"; c.s.ctx.nbr = a.ip; c.s.touch(); return OK; });
  E("remote-as <as>", ["nbr"], (c, a) => { nbOf(c).remoteAs = +a.as; c.s.touch(); return OK; });
  E("update-source <i>", ["nbr"], (c, a) => { const nm = srcIf(c, a.i); if (!nm) return BAD; nbOf(c).updateSource = nm; c.s.touch(); return OK; });
  E("description <d...>", ["nbr"], (c, a) => { nbOf(c).desc = a.d; return OK; });
  E("shutdown", ["nbr"], (c) => { nbOf(c).shutdown = true; c.s.touch(); return OK; });
  E("no shutdown", ["nbr"], (c) => { nbOf(c).shutdown = false; c.s.touch(); return OK; });
  E("ebgp-multihop <n>", ["nbr"], (c, a) => { nbOf(c).multihop = +a.n; c.s.touch(); return OK; });
  E("password <p...>", ["nbr"], (c, a) => { nbOf(c).password = a.p.replace(/^\d\s+/, ""); c.s.touch(); return OK; });
  E("address-family l2vpn evpn", ["nbr"], (c) => { nbOf(c).evpn = true; c.s.mode = "nbraf"; c.s.ctx.af = "evpn"; c.s.touch(); return OK; });
  E("address-family ipv4 unicast", ["nbr"], (c) => { c.s.mode = "nbraf"; c.s.ctx.af = "ipv4"; return OK; });
  E("send-community <x?>", ["nbraf"], (c, a) => { if (c.s.ctx.af === "evpn" && /^(extended|both)$/.test(a.x || "")) { nbOf(c).extComm = true; c.s.touch(); } else if (a.x && !/^(extended|both|standard)$/.test(a.x)) return BAD; return OK; });
  E("no send-community <x?>", ["nbraf"], (c) => { if (c.s.ctx.af === "evpn") nbOf(c).extComm = false; c.s.touch(); return OK; });
  E("route-reflector-client", ["nbraf"], (c) => { nbOf(c).rrClient = true; c.s.touch(); return OK; });
  E("no route-reflector-client", ["nbraf"], (c) => { nbOf(c).rrClient = false; c.s.touch(); return OK; });
  E("soft-reconfiguration inbound <x?>", ["nbraf"], () => OK);
  E("next-hop-self", ["nbraf"], (c) => { nbOf(c).nhs = true; c.s.touch(); return OK; });
  // neighbor flags in the flat form (EOS and generic)
  E("no neighbor <ip> send-community <x?>", BGP, (c, a) => { const n = c.D.bgp.neighbors[a.ip]; if (n) n.extComm = false; c.s.touch(); return OK; });
  E("no neighbor <ip> route-reflector-client", BGP, (c, a) => { const n = c.D.bgp.neighbors[a.ip]; if (n) n.rrClient = false; c.s.touch(); return OK; });
  E("no neighbor <ip> activate", BGP, (c, a) => { const n = c.D.bgp.neighbors[a.ip]; if (n && c.s.ctx.af === "evpn") n.evpn = false; c.s.touch(); return OK; });
  // exit / end for the new modes
  const UP = { evpnvni: "evpn", evpn: "config", nbraf: "nbr", nbr: "bgp", macvrf: "bgp" };
  E("exit", ["evpn", "evpnvni", "nbr", "nbraf", "macvrf"], (c) => { c.s.mode = UP[c.s.mode]; return OK; });
  E("end", ["evpn", "evpnvni", "nbr", "nbraf", "macvrf"], (c) => { c.s.mode = "priv"; return OK; });
  // show commands
  const S = ["user", "priv"];
  E("show nve peers", S, (c) => (c.style === "nxos" ? nxPeers(c) : BAD));
  E("show nve vni", S, (c) => (c.style === "nxos" ? nxVni(c) : BAD));
  E("show nve interface <x?>", S, (c) => (c.style === "nxos" ? nxIface(c) : BAD));
  E("show bgp l2vpn evpn summary", S, (c) => evpnSummary(c, false));
  E("show bgp l2vpn evpn route-type <t>", S, (c, a) => routeLines(c, a.t, false));
  E("show bgp l2vpn evpn <x?>", S, (c) => routeLines(c, null, false));
  E("show l2route evpn mac all", S, l2route);
  E("show l2route evpn mac-ip all", S, l2route);
  E("show vxlan vtep", S, (c) => (c.style === "eos" ? eosVtep(c) : BAD));
  E("show vxlan vni", S, (c) => (c.style === "eos" ? eosVni(c) : BAD));
  E("show vxlan address-table", S, (c) => (c.style === "eos" ? eosAddr(c) : BAD));
  E("show vxlan config-sanity", S, (c) => (c.style === "eos" ? sanity(c) : BAD));
  E("show bgp evpn summary", S, (c) => evpnSummary(c, true));
  E("show bgp evpn route-type <t>", S, (c, a) => routeLines(c, a.t, true));
  E("show bgp evpn", S, (c) => routeLines(c, null, true));
  E("show interfaces vxlan <n>", S, (c) => { const x = c.D.vxlan; if (c.style !== "eos" || !x || !x.nve) return BAD; const v = EV(c).vtep || {}; return `Vxlan${(x.nve.ifc.match(/\d+/) || [1])[0]} is ${v.up ? "up" : "down"}, line protocol is ${v.up ? "up" : "down"} (connected)\n  Hardware is Vxlan\n  Source interface is ${x.nve.src || "not configured"} and is active with ${v.up ? v.ip : "no address"}\n  Replication/Flood Mode is headend with Flood List Source: EVPN\n  Static VLAN to VNI mapping is ${Object.entries(x.vlanVni).map(([a, b]) => `[${a}, ${b}]`).join(", ")}`; });
  IOS.TABLE.push(...C.compile(T));

  // ---------------------------------------------------------------- running-config rendering
  C.cfgx.vlan = (D, v, style, L) => { if (style === "nxos" && D.vxlan && D.vxlan.vlanVni[v]) L.push(` vn-segment ${D.vxlan.vlanVni[v]}`); };
  C.cfgx.top = (D, style, L) => {
    const x = D.vxlan; if (!x) return;
    if (style === "nxos") { if (x.features.nv) L.push("feature nv overlay"); if (x.features.vnseg) L.push("feature vn-segment-vlan-based"); if (x.features.nvEvpn) L.push("nv overlay evpn"); if (x.gwMac) L.push(`fabric forwarding anycast-gateway-mac ${x.gwMac}`); L.push("!"); const ev = D.evpn; if (ev && Object.keys(ev.vnis).length) { L.push("evpn"); for (const [vni, c] of Object.entries(ev.vnis)) { L.push(` vni ${vni} l2`); L.push(`   rd ${c.rd || "auto"}`); (c.imp.length ? c.imp : []).forEach((r) => L.push(`   route-target import ${r}`)); (c.exp.length ? c.exp : []).forEach((r) => L.push(`   route-target export ${r}`)); } L.push("!"); } }
    else if (x.gwMac) { L.push(`ip virtual-router mac-address ${x.gwMac}`); L.push("!"); }
  };
  C.cfgx.iface = (D, i, style, L) => {
    const x = D.vxlan; if (!x) return;
    if (i.virtual && x.nve && x.nve.ifc === i.name) {
      if (style === "nxos") { L.push(" host-reachability protocol bgp"); if (x.nve.src) L.push(` source-interface ${x.nve.src}`); for (const v of Object.keys(x.members || {})) if (x.members[v]) { L.push(` member vni ${v}`); L.push("   ingress-replication protocol bgp"); } }
      else { if (x.nve.src) L.push(` vxlan source-interface ${x.nve.src}`); L.push(" vxlan udp-port 4789"); for (const [v, n] of Object.entries(x.vlanVni)) L.push(` vxlan vlan ${v} vni ${n}`); }
    }
    if (i.svi && i.anycast) L.push(style === "nxos" ? " fabric forwarding mode anycast-gateway" : null);
  };
  C.cfgx.bgp = (D, style, L) => {
    const B = D.bgp; if (!B) return;
    const ev = Object.entries(B.neighbors).filter(([, n]) => n.evpn || n.extComm);
    if (style === "nxos" && ev.length) { for (const [ip, n] of ev) { L.push(` neighbor ${ip}`); L.push("  address-family l2vpn evpn"); if (n.extComm) L.push("   send-community extended"); if (n.rrClient) L.push("   route-reflector-client"); } }
    if (style === "eos") {
      for (const [ip, n] of Object.entries(B.neighbors)) if (n.extComm) L.push(` neighbor ${ip} send-community extended`);
      for (const [v, c] of Object.entries((D.evpn && D.evpn.vlans) || {})) { L.push(` vlan ${v}`); L.push(`   rd ${c.rd || "auto"}`); c.imp.filter((r) => c.exp.indexOf(r) >= 0).forEach((r) => L.push(`   route-target both ${r}`)); c.imp.filter((r) => c.exp.indexOf(r) < 0).forEach((r) => L.push(`   route-target import ${r}`)); c.exp.filter((r) => c.imp.indexOf(r) < 0).forEach((r) => L.push(`   route-target export ${r}`)); if (c.learned !== false) L.push("   redistribute learned"); }
      if (ev.length) { L.push(" address-family evpn"); for (const [ip, n] of ev) { if (n.evpn) L.push(`  neighbor ${ip} activate`); if (n.rrClient) L.push(`  neighbor ${ip} route-reflector-client`); } }
    }
  };
  const api = { evaluate, vtep, vniCfg, macOf };
  root.Netevpn = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
