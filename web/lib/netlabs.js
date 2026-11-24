/* Netlabs: seeded troubleshooting labs built on the netsim model. Every lab is
   generated from a seed (random vendors, addresses, AS numbers), has one injected
   fault, a trouble ticket, a hint ladder and a verification that recomputes the
   whole network state, so the fix is judged on behaviour, not on a typed answer. */
(function (root) {
  "use strict";
  const N = root.Netsim || (typeof require !== "undefined" ? require("./netsim.js") : null);
  const J = root.Netjunos || (typeof require !== "undefined" ? require("./netjunos.js") : null);
  const { n2ip, ip2n, netOf, lenMask } = N;

  function rngOf(seed) { let a = seed >>> 0 || 1; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const wild = (len) => n2ip((~lenMask(len)) >>> 0);
  const NAMES = { ios: "Cisco IOS-XE", nxos: "Cisco NX-OS", eos: "Arista EOS", junos: "Juniper Junos", linux: "Linux" };

  // ---- construction helpers
  function ifName(os, n) { return { ios: `GigabitEthernet0/${n}`, eos: `Ethernet${n + 1}`, nxos: `Ethernet1/${n + 1}`, junos: `ge-0/0/${n}`, linux: `eth${n}` }[os]; }
  const loName = (os) => ({ ios: "Loopback0", eos: "Loopback0", nxos: "loopback0", junos: "lo0" })[os];
  function mk(net, name, os, role) { const d = N.addDevice(net, { name, os, role: role || (os === "linux" ? "host" : "router") }); d._n = 0; if (os === "nxos") d.features = { ospf: true, bgp: true, "interface-vlan": true }; return d; }
  function port(dev, cidr, o) { const c = cidr && N.cidr(cidr); const nm = ifName(dev.os, dev._n++); N.addIf(dev, nm, Object.assign({ ip: c ? { addr: c.ip, len: c.len } : null }, o || {})); return nm; }
  function link(net, a, b, ca, cb) { const x = port(a, ca), y = port(b, cb); N.connect(net, a.name, x, b.name, y); return [x, y]; }
  function loop(dev, ip) { const nm = loName(dev.os); N.addIf(dev, nm, { ip: { addr: ip, len: 32 }, loopback: true }); return nm; }
  const addrOf = (dev, nm) => dev.ifs[nm].ip.addr;
  function gw(host, ip) { host.statics.push({ pfx: "0.0.0.0", len: 0, nh: ip, ad: 1 }); }

  function ospfOn(dev, rid, items) { // items: [{ifc, area, passive}]
    dev.ospf = { pid: 1, rid, networks: [], passive: [], redist: {} };
    for (const it of items) { const i = dev.ifs[it.ifc], area = it.area === undefined ? 0 : it.area; if (dev.os === "ios" || dev.os === "eos") dev.ospf.networks.push({ ip: n2ip(netOf(i.ip.addr, i.ip.len)), wild: wild(i.ip.len), area, ifc: it.ifc }); else i.ospf.area = area; if (it.passive) dev.ospf.passive.push(it.ifc); }
  }
  function bgpOn(dev, asn, rid) { dev.bgp = { asn, rid, neighbors: {}, networks: [], redist: {} }; return dev.bgp; }
  function nb(dev, ip, o) { dev.bgp.neighbors[ip] = Object.assign({ remoteAs: 0 }, o); }

  // ---- Junos: emit set-lines from the model so a Junos device starts with real configuration
  function emitJunos(d) {
    const L = [`set system host-name ${d.hostname}`], put = (s) => L.push("set " + s);
    for (const nm of d.order) { const i = d.ifs[nm]; if (i.derived) continue; if (i.ip) put(`interfaces ${nm} unit 0 family inet address ${i.ip.addr}/${i.ip.len}`); if (i.desc) put(`interfaces ${nm} description "${i.desc}"`); if (i.shutdown) put(`interfaces ${nm} disable`); if (i.mtu !== 1500) put(`interfaces ${nm} mtu ${i.mtu}`); if (i.acl && i.acl.in) put(`interfaces ${nm} unit 0 family inet filter input ${i.acl.in}`); }
    const rid = (d.ospf && d.ospf.rid) || (d.bgp && d.bgp.rid); if (rid) put(`routing-options router-id ${rid}`); if (d.bgp) put(`routing-options autonomous-system ${d.bgp.asn}`);
    for (const s of d.statics) put(`routing-options static route ${s.pfx}/${s.len} next-hop ${s.nh}${s.ad && s.ad !== 5 && s.ad !== 1 ? " preference " + s.ad : ""}`);
    if (d.ospf) for (const nm of d.order) { const i = d.ifs[nm]; if (i.ospf.area === null || i.ospf.area === undefined) continue; const b = `protocols ospf area ${N.normArea(i.ospf.area)} interface ${nm}${i.loopback ? ".0" : ".0"}`; put(b); if (d.ospf.passive.indexOf(nm) >= 0) put(b + " passive"); if (i.ospf.hello !== 10) put(b + ` hello-interval ${i.ospf.hello}`); if (i.ospf.dead !== 40) put(b + ` dead-interval ${i.ospf.dead}`); if (i.ospf.cost) put(b + ` metric ${i.ospf.cost}`); if (i.ospf.auth) put(b + ` authentication simple-password ${i.ospf.auth}`); if (i.ospf.mtuIgnore) put(b + " ignore-mtu"); }
    if (d.bgp) { let k = 0; const nets = d.bgp.networks;
      if (nets.length) { put(`policy-options policy-statement ORIGINATE term LAN from protocol direct`); nets.forEach((w) => put(`policy-options policy-statement ORIGINATE term LAN from route-filter ${w.ip}/${w.len} exact`)); put(`policy-options policy-statement ORIGINATE term LAN then accept`); }
      let nhs = false;
      for (const [ip, n] of Object.entries(d.bgp.neighbors)) { const g = `PEER${++k}`, ext = n.remoteAs !== d.bgp.asn; put(`protocols bgp group ${g} type ${ext ? "external" : "internal"}`); if (ext) put(`protocols bgp group ${g} peer-as ${n.remoteAs}`); put(`protocols bgp group ${g} neighbor ${ip}`); if (n.updateSource) put(`protocols bgp group ${g} local-address ${d.ifs[n.updateSource].ip.addr}`); if (n.multihop) put(`protocols bgp group ${g} multihop ttl ${n.multihop}`); if (n.password) put(`protocols bgp group ${g} authentication-key ${n.password}`); if (n.shutdown) put(`protocols bgp group ${g} neighbor ${ip} disable`); const pol = []; if (nets.length) pol.push("ORIGINATE"); if (n.nhs) { if (!nhs) { put(`policy-options policy-statement NHS term ALL from protocol bgp`); put(`policy-options policy-statement NHS term ALL then next-hop self`); put(`policy-options policy-statement NHS term ALL then accept`); nhs = true; } pol.push("NHS"); } if (pol.length) put(`protocols bgp group ${g} export ${pol.length > 1 ? "[ " + pol.join(" ") + " ]" : pol[0]}`); } }
    return L;
  }
  // The "export [ A B ]" list is handled by taking the first policy; expand to a combined policy instead.
  function finalize(net) { for (const d of Object.values(net.devices)) if (d.os === "junos") { sync(d); } net._rev = (net._rev || 0) + 1; return net; }
  function sync(d) { d.jset = emitJunos(d); const hasBoth = d.jset.some((l) => /export \[ ORIGINATE NHS \]/.test(l)); if (hasBoth) { d.jset = d.jset.filter((l) => !/policy-statement NHS term ALL/.test(l)).map((l) => l.replace("export [ ORIGINATE NHS ]", "export ORIGINATE")); d.jset.push("set policy-options policy-statement ORIGINATE term ALL from protocol bgp", "set policy-options policy-statement ORIGINATE term ALL then next-hop self", "set policy-options policy-statement ORIGINATE term ALL then accept"); } J.rebuild(d); }

  // ---- verification
  function snapshot(net, spec) {
    const R = N.compute(net), state = { pings: {}, ospf: {}, bgp: {} };
    for (const c of spec.checks) { const r = N.ping(R, c.from, c.to, { source: c.source || null }); state.pings[c.id] = !!r.ok; }
    for (const [d, dev] of Object.entries(net.devices)) { if (dev.ospf && R.ospf[d]) state.ospf[d] = R.ospf[d].nbrs.filter((x) => x.state === "FULL").length; if (dev.bgp && R.bgp[d]) for (const ip of Object.keys(dev.bgp.neighbors)) state.bgp[d + ">" + ip] = R.bgp[d][ip] ? R.bgp[d][ip].state === "Established" : false; }
    return state;
  }
  function verify(lab) {
    const now = snapshot(lab.net, lab.spec), want = lab.baseline, problems = [];
    for (const c of lab.spec.checks) if (want.pings[c.id] && !now.pings[c.id]) problems.push(c.label);
    for (const [d, n] of Object.entries(want.ospf)) if ((now.ospf[d] || 0) < n) problems.push(`${d}: OSPF has ${now.ospf[d] || 0} of ${n} expected adjacencies`);
    for (const k of Object.keys(want.bgp)) if (want.bgp[k] && !now.bgp[k]) problems.push(`BGP session ${k.replace(">", " to ")} is not Established`);
    return { solved: !problems.length, problems, now };
  }

  // ---- fault catalogue; each scenario builds a healthy net then one fault with its undo
  const SC = {};
  const pickOs = (rnd, pool) => pool[Math.floor(rnd() * pool.length)];
  const rtrs = ["ios", "eos", "nxos", "junos"];

  SC.ospf = {
    title: "OSPF adjacency", area: "Routing",
    build(rnd, o) {
      const net = N.newNet(), x = 10 + Math.floor(rnd() * 200), os = [0, 1, 2].map(() => pickOs(rnd, rtrs));
      const R = os.map((s, k) => mk(net, "R" + (k + 1), s)), lo = R.map((r, k) => loop(r, `10.255.${x}.${k + 1}`));
      const l12 = link(net, R[0], R[1], `10.${x}.12.1/30`, `10.${x}.12.2/30`), l23 = link(net, R[1], R[2], `10.${x}.23.1/30`, `10.${x}.23.2/30`);
      const it = [[{ ifc: l12[0] }, { ifc: lo[0] }], [{ ifc: l12[1] }, { ifc: l23[0] }, { ifc: lo[1] }], [{ ifc: l23[1] }, { ifc: lo[2] }]];
      R.forEach((r, k) => ospfOn(r, `10.255.${x}.${k + 1}`, it[k].map((q) => Object.assign({ passive: q.ifc === lo[k] }, q))));
      const pos = { R1: { x: 14, y: 50 }, R2: { x: 50, y: 50 }, R3: { x: 86, y: 50 } };
      const spec = { checks: [{ id: "a", from: "R1", to: `10.255.${x}.3`, source: `10.255.${x}.1`, label: `R1 cannot reach R3's loopback 10.255.${x}.3` }, { id: "b", from: "R3", to: `10.255.${x}.1`, source: `10.255.${x}.3`, label: `R3 cannot reach R1's loopback 10.255.${x}.1` }] };
      const links = [{ a: "R1", b: "R2" }, { a: "R2", b: "R3" }];
      // choose a fault
      const side = rnd() < 0.5 ? 0 : 1, a = R[side + 0], b = R[side + 1], ia = side ? l23[0] : l12[0], ib = side ? l23[1] : l12[1];
      const victim = rnd() < 0.5 ? a : b, vi = victim === a ? ia : ib, other = victim === a ? b : a, oi = victim === a ? ib : ia;
      const faults = [];
      faults.push({ id: "hello", ok: true, title: "Hello interval mismatch", ticket: `After a change window, ${R[0].name} lost sight of the rest of the network and ${R[2].name} cannot be reached.`, apply() { const i = victim.ifs[vi]; const was = i.ospf.hello; i.ospf.hello = 4; return () => { i.ospf.hello = was; }; }, hints: [`Which OSPF neighbour is missing? Compare "show ... ospf neighbor" on the two routers of the broken link.`, `The adjacency never forms. Look at the OSPF interface settings (timers) on both ends of the ${victim.name}-${other.name} link.`, `${victim.name} ${vi} uses a different hello interval from ${other.name}. Make them match (default 10 s).`], why: `OSPF only forms an adjacency when hello and dead intervals agree on both ends. ${victim.name} had hello 4 s on ${vi} while ${other.name} still used 10 s, so every hello was dropped as a parameter mismatch.` });
      faults.push({ id: "area", ok: true, title: "Area mismatch", ticket: `A new link was brought into service and ${victim.name} does not exchange routes with ${other.name}.`, apply() { if (victim.os === "ios" || victim.os === "eos") { const w = victim.ospf.networks.find((q) => q.ifc === vi); const was = w.area; w.area = 1; return () => { w.area = was; }; } const i = victim.ifs[vi]; const was = i.ospf.area; i.ospf.area = 1; return () => { i.ospf.area = was; }; }, hints: [`The neighbour is not listed at all. Check the log for the reason a Hello was ignored.`, `Compare which OSPF area the interface on each side belongs to.`, `${victim.name} places ${vi} in area 1 while ${other.name} uses area 0. Put both ends in the same area (0).`], why: `The Hello carries the area ID and a receiver on a link only accepts Hellos for its own area. ${victim.name} put ${vi} in area 1, so ${other.name} ignored its Hellos.` });
      faults.push({ id: "passive", ok: victim.os !== "nxos", title: "Interface passive", ticket: `${victim.name} stopped forming an OSPF neighbour with ${other.name}, but the link is up and pingable.`, apply() { const was = victim.ospf.passive.slice(); if (victim.ospf.passive.indexOf(vi) < 0) victim.ospf.passive.push(vi); return () => { victim.ospf.passive = was; }; }, hints: [`The link pings fine but there is no neighbour. Which routers send Hellos on this link?`, `Check whether the OSPF interface on ${victim.name} is allowed to send Hellos at all (passive interface).`, `${vi} on ${victim.name} is passive. Remove the passive setting on the transit interface (only loopbacks should be passive).`], why: `A passive interface advertises its network but sends no Hellos and forms no adjacency. Passive belongs on stub interfaces like loopbacks and LANs, not on transit links.` });
      faults.push({ id: "network", ok: true, title: "Interface not in OSPF", ticket: `The ${victim.name}-${other.name} link is up but ${victim.name} learns nothing from ${other.name}.`, apply() { if (victim.os === "ios" || victim.os === "eos") { const k = victim.ospf.networks.findIndex((q) => q.ifc === vi), w = victim.ospf.networks.splice(k, 1)[0]; return () => { victim.ospf.networks.splice(k, 0, w); }; } const i = victim.ifs[vi]; const was = i.ospf.area; i.ospf.area = null; return () => { i.ospf.area = was; }; }, hints: [`Is OSPF even running on every interface of the router that misses its neighbour? Check "show ... ospf interface".`, `${vi} does not appear in the OSPF interface list on ${victim.name}.`, victim.os === "ios" || victim.os === "eos" ? `The network statement covering ${vi} is missing. Add a network statement that includes the interface address, in area 0.` : `Enable OSPF on ${vi} (put the interface in area 0).`], why: `An interface only takes part in OSPF when it is enabled, through a network statement or an interface/area statement depending on the platform. Without it no Hellos are sent and its subnet is not advertised.` });
      faults.push({ id: "mtu", ok: true, title: "MTU mismatch", ticket: `${victim.name} and ${other.name} keep flapping between neighbour states and never reach Full.`, apply() { const i = victim.ifs[vi]; const was = i.mtu; i.mtu = 1400; return () => { i.mtu = was; }; }, hints: [`The neighbour is visible but stuck in a state that is not Full. Which state?`, `ExStart/Exchange loops are the classic sign of an MTU difference. Compare the MTU of both ends.`, `${victim.name} ${vi} has MTU 1400, ${other.name} 1500. Set both to the same value (1500).`], why: `During database exchange both sides compare the interface MTU in the DBD packets; if the neighbour's is larger than what a router can receive, the exchange stalls in ExStart.` });
      faults.push({ id: "auth", ok: true, title: "Authentication mismatch", ticket: `Security pushed a hardening change last night. Since then ${victim.name} has no OSPF neighbour on one link.`, apply() { const i = victim.ifs[vi]; const was = i.ospf.auth; i.ospf.auth = "S3cret"; return () => { i.ospf.auth = was; }; }, hints: [`Check the log on both routers for the reason the packets are dropped.`, `One side authenticates OSPF, the other does not.`, `${victim.name} ${vi} has an OSPF authentication key that ${other.name} lacks. Remove it there or configure the same key on both.`], why: `OSPF authentication is configured per interface and must match on both ends. A one-sided key makes every packet from the other side fail validation.` });
      faults.push({ id: "rid", ok: true, title: "Duplicate router ID", ticket: `${victim.name} and ${other.name} see each other on the wire, yet the adjacency does not stay and routes beyond are missing.`, apply() { const was = victim.ospf.rid; victim.ospf.rid = other.ospf.rid; return () => { victim.ospf.rid = was; }; }, hints: [`Compare the Router ID shown by "show ... ospf" on the two neighbouring routers.`, `${victim.name} and ${other.name} use the same Router ID.`, `Give ${victim.name} its own unique router ID (10.255.${x}.${victim.name.slice(1)}).`], why: `A router ID has to be unique in the OSPF domain. A neighbour that announces your own ID is rejected, so the adjacency cannot form.` });
      faults.push({ id: "shut", ok: true, title: "Interface shut down", ticket: `A maintenance change touched ${victim.name}. Now ${other.name} reports its neighbour is gone.`, apply() { const i = victim.ifs[vi]; const was = i.shutdown; i.shutdown = true; return () => { i.shutdown = was; }; }, hints: [`Check the interface status on the routers around the broken link.`, `One end of the link is administratively down.`, `Bring ${vi} on ${victim.name} back up (no shutdown / delete disable).`], why: `An administratively shut interface is down at both ends of the link, so the OSPF neighbour disappears and the routes learned through it are withdrawn.` });
      const f = pickFault(rnd, faults, o);
      return { net, spec, pos, links, fault: f, vendors: os, intro: `Three routers in a chain, OSPF area 0, loopbacks advertised.` };
    },
  };

  SC.bgp = {
    title: "eBGP between two ASes", area: "Routing",
    build(rnd, o) {
      const net = N.newNet(), os = [pickOs(rnd, rtrs), pickOs(rnd, rtrs)], a1 = 64512 + Math.floor(rnd() * 400), a2 = a1 + 1 + Math.floor(rnd() * 50), x = 10 + Math.floor(rnd() * 150);
      const loopPeer = rnd() < 0.5;
      const R1 = mk(net, "R1", os[0]), R2 = mk(net, "R2", os[1]), H1 = mk(net, "H1", "linux"), H2 = mk(net, "H2", "linux");
      const wan = link(net, R1, R2, `172.${x}.0.1/30`, `172.${x}.0.2/30`), l1 = link(net, R1, H1, `192.168.${x}.1/24`, `192.168.${x}.10/24`), l2 = link(net, R2, H2, `192.168.${x + 1}.1/24`, `192.168.${x + 1}.10/24`);
      gw(H1, `192.168.${x}.1`); gw(H2, `192.168.${x + 1}.1`);
      const B1 = bgpOn(R1, a1, `1.1.${x}.1`), B2 = bgpOn(R2, a2, `1.1.${x}.2`); B1.networks.push({ ip: `192.168.${x}.0`, len: 24 }); B2.networks.push({ ip: `192.168.${x + 1}.0`, len: 24 });
      let ip1, ip2, upd1 = null, upd2 = null;
      if (loopPeer) { const lo1 = loop(R1, `10.255.${x}.1`), lo2 = loop(R2, `10.255.${x}.2`); R1.statics.push({ pfx: `10.255.${x}.2`, len: 32, nh: `172.${x}.0.2`, ad: 1 }); R2.statics.push({ pfx: `10.255.${x}.1`, len: 32, nh: `172.${x}.0.1`, ad: 1 }); ip1 = `10.255.${x}.2`; ip2 = `10.255.${x}.1`; upd1 = lo1; upd2 = lo2; }
      else { ip1 = `172.${x}.0.2`; ip2 = `172.${x}.0.1`; }
      nb(R1, ip1, { remoteAs: a2, updateSource: upd1, multihop: loopPeer ? 2 : undefined }); nb(R2, ip2, { remoteAs: a1, updateSource: upd2, multihop: loopPeer ? 2 : undefined });
      const clean = (d) => { for (const n of Object.values(d.bgp.neighbors)) for (const k of Object.keys(n)) if (n[k] === undefined || n[k] === null) delete n[k]; }; clean(R1); clean(R2);
      const pos = { H1: { x: 8, y: 50 }, R1: { x: 34, y: 50 }, R2: { x: 66, y: 50 }, H2: { x: 92, y: 50 } };
      const spec = { checks: [{ id: "a", from: "H1", to: `192.168.${x + 1}.10`, label: `H1 (192.168.${x}.10) cannot reach H2 (192.168.${x + 1}.10)` }, { id: "b", from: "H2", to: `192.168.${x}.10`, label: `H2 cannot reach H1` }] };
      const links = [{ a: "H1", b: "R1" }, { a: "R1", b: "R2" }, { a: "R2", b: "H2" }];
      const victim = rnd() < 0.5 ? R1 : R2, other = victim === R1 ? R2 : R1, vip = victim === R1 ? ip1 : ip2, oip = victim === R1 ? ip2 : ip1;
      const faults = [];
      faults.push({ id: "remoteas", ok: true, title: "Wrong remote AS", ticket: `The new customer link between ${R1.name} and ${R2.name} is up, but the BGP session never comes up.`, apply() { const n = victim.bgp.neighbors[vip]; const was = n.remoteAs; n.remoteAs = was + 7; return () => { n.remoteAs = was; }; }, hints: [`Look at the BGP session state and the reason on the router that is not Established.`, `The session is rejected during OPEN: compare the AS numbers each side expects.`, `${victim.name} expects the neighbour ${vip} in the wrong AS. Set remote-as to ${victim === R1 ? a2 : a1}.`], why: `In the BGP OPEN message each router announces its AS. If it differs from the remote-as configured on the other side, the session is torn down with an OPEN error (bad peer AS).` });
      faults.push({ id: "noneighbor", ok: true, title: "Neighbor missing on one side", ticket: `${victim.name} was rebuilt from a template. The BGP session to ${other.name} is down.`, apply() { const n = victim.bgp.neighbors[vip]; delete victim.bgp.neighbors[vip]; return () => { victim.bgp.neighbors[vip] = n; }; }, hints: [`Which side is trying to connect, and which side never answers?`, `One router does not know the other as a neighbour at all.`, `Configure ${vip} as a neighbour on ${victim.name} with remote-as ${victim === R1 ? a2 : a1}${loopPeer ? " (and update-source loopback, multihop 2)" : ""}.`], why: `TCP port 179 is opened by whichever side initiates, but the other side only accepts it from configured neighbours. With the neighbour missing, the session is refused.` });
      faults.push({ id: "password", ok: true, title: "MD5 password mismatch", ticket: `After a "security tidy-up" the BGP session between ${R1.name} and ${R2.name} no longer comes up.`, apply() { const n = victim.bgp.neighbors[vip]; const was = n.password; n.password = "Lab2024"; return () => { if (was === undefined) delete n.password; else n.password = was; }; }, hints: [`Look in the log of both routers for TCP/authentication messages.`, `One side has a BGP password configured; the other does not.`, `Remove the password on ${victim.name} or configure the same on ${other.name}.`], why: `BGP over TCP MD5 authentication needs the same key on both ends. A one-sided key makes TCP segments from the other side invalid, so the session cannot open.` });
      faults.push({ id: "shut", ok: true, title: "Neighbor shut down", ticket: `${victim.name} shows the neighbour as Idle (Admin) since a recent maintenance.`, apply() { const n = victim.bgp.neighbors[vip]; n.shutdown = true; return () => { delete n.shutdown; }; }, hints: [`Look at the state column in the BGP summary.`, `The neighbour is administratively shut down.`, `Re-enable neighbour ${vip} on ${victim.name} (no neighbor shutdown / delete disable).`], why: `An administratively shut BGP neighbour is held in Idle and sends no OPEN, so the session cannot establish until it is re-enabled.` });
      faults.push({ id: "network", ok: true, title: "Prefix not advertised", ticket: `The BGP session is Established, yet the hosts behind ${R1.name} and ${R2.name} cannot reach each other.`, apply() { const w = victim.bgp.networks.shift(); return () => { victim.bgp.networks.unshift(w); }; }, hints: [`The session is up. Check what each side receives with "show ... bgp" / received-routes.`, `${other.name} does not receive the LAN of ${victim.name}. What makes BGP originate a prefix?`, victim.os === "junos" ? `${victim.name} has no export policy that announces its LAN (192.168.${victim === R1 ? x : x + 1}.0/24). Add the policy and apply it as export on the neighbour.` : `${victim.name} lacks the "network 192.168.${victim === R1 ? x : x + 1}.0 mask 255.255.255.0" statement. Add it under the address family.`], why: `BGP only originates what you tell it to: a network statement (or export policy on Junos) for a prefix that exists in the routing table. Without it the LAN is never advertised.` });
      if (loopPeer) {
        faults.push({ id: "updsrc", ok: true, title: "Missing update-source", ticket: `The loopback-based BGP session between ${R1.name} and ${R2.name} does not establish, although the loopbacks can reach each other.`, apply() { const n = victim.bgp.neighbors[vip]; const was = n.updateSource; delete n.updateSource; return () => { n.updateSource = was; }; }, hints: [`The neighbour address is a loopback. From which address does ${victim.name} open the TCP session?`, `The source of the session has to be the loopback that the other side has configured as its neighbour.`, `Set the update source of neighbour ${vip} on ${victim.name} to its loopback (${victim.ifs[victim === R1 ? upd1 : upd2].name}).`], why: `A router opens the session from the egress interface address by default. The peer expects connections from the loopback it was configured with, so it refuses them.` });
        faults.push({ id: "multihop", ok: true, title: "eBGP multihop missing", ticket: `${R1.name}-${R2.name} peer over loopbacks. Pings between loopbacks work, but BGP is stuck.`, apply() { const n = victim.bgp.neighbors[vip]; const was = n.multihop; delete n.multihop; return () => { n.multihop = was; }; }, hints: [`Check the TTL behaviour for external BGP sessions that do not use directly connected interfaces.`, `eBGP packets by default have TTL 1.`, `Allow ebgp-multihop 2 (Junos: multihop ttl 2) on ${victim.name} for neighbour ${vip}.`], why: `eBGP sends packets with TTL 1 by default, assuming a directly connected peer. A loopback address is one hop beyond, so the session needs multihop.` });
      }
      const f = pickFault(rnd, faults, o);
      return { net, spec, pos, links, fault: f, vendors: os, intro: `Two autonomous systems (AS ${a1}, AS ${a2}) with a host behind each.` + (loopPeer ? " Peering uses loopback addresses." : "") };
    },
  };

  SC.ibgp = {
    title: "iBGP and next-hop", area: "Routing",
    build(rnd, o) {
      const net = N.newNet(), os = [pickOs(rnd, rtrs), pickOs(rnd, ["ios", "eos", "nxos", "junos"]), pickOs(rnd, rtrs)], mine = 65000 + Math.floor(rnd() * 400), isp = 64500 + Math.floor(rnd() * 50), x = 10 + Math.floor(rnd() * 150);
      const R0 = mk(net, "ISP", os[0]), R1 = mk(net, "R1", os[1]), R2 = mk(net, "R2", os[2]), H0 = mk(net, "H0", "linux"), H2 = mk(net, "H2", "linux");
      const wan = link(net, R0, R1, `198.51.${x}.1/30`, `198.51.${x}.2/30`), core = link(net, R1, R2, `10.${x}.12.1/30`, `10.${x}.12.2/30`), lan0 = link(net, R0, H0, `203.0.${x}.1/24`, `203.0.${x}.10/24`), lan2 = link(net, R2, H2, `10.${x}.20.1/24`, `10.${x}.20.10/24`);
      gw(H0, `203.0.${x}.1`); gw(H2, `10.${x}.20.1`);
      const lo1 = loop(R1, `10.255.${x}.1`), lo2 = loop(R2, `10.255.${x}.2`);
      ospfOn(R1, `10.255.${x}.1`, [{ ifc: core[0] }, { ifc: lo1, passive: true }]); ospfOn(R2, `10.255.${x}.2`, [{ ifc: core[1] }, { ifc: lo2, passive: true }]);
      const B0 = bgpOn(R0, isp, `9.9.${x}.1`), B1 = bgpOn(R1, mine, `10.255.${x}.1`), B2 = bgpOn(R2, mine, `10.255.${x}.2`);
      B0.networks.push({ ip: `203.0.${x}.0`, len: 24 });
      nb(R0, `198.51.${x}.2`, { remoteAs: mine }); nb(R1, `198.51.${x}.1`, { remoteAs: isp }); nb(R1, `10.255.${x}.2`, { remoteAs: mine, updateSource: lo1, nhs: true }); nb(R2, `10.255.${x}.1`, { remoteAs: mine, updateSource: lo2 });
      B2.networks.push({ ip: `10.${x}.20.0`, len: 24 });
      const pos = { H0: { x: 6, y: 50 }, ISP: { x: 27, y: 50 }, R1: { x: 52, y: 50 }, R2: { x: 76, y: 50 }, H2: { x: 94, y: 50 } };
      const spec = { checks: [{ id: "a", from: "H2", to: `203.0.${x}.10`, label: `H2 (10.${x}.20.10) cannot reach the ISP server 203.0.${x}.10` }, { id: "b", from: "H0", to: `10.${x}.20.10`, label: `The ISP server cannot reach H2` }] };
      const links = [{ a: "H0", b: "ISP" }, { a: "ISP", b: "R1" }, { a: "R1", b: "R2" }, { a: "R2", b: "H2" }];
      const faults = [];
      faults.push({ id: "nhs", ok: true, title: "iBGP next-hop unreachable", ticket: `Customers behind R2 cannot reach the ISP's 203.0.${x}.0/24. R2 has the route in its BGP table but traffic is not forwarded.`, apply() { const n = R1.bgp.neighbors[`10.255.${x}.2`]; delete n.nhs; return () => { n.nhs = true; }; }, hints: [`On R2 compare "show ip bgp" (route present) with "show ip route" (route absent from the routing table). What is the next hop of the BGP route?`, `The next hop is the ISP-facing address 198.51.${x}.1, which R2 cannot reach via the IGP.`, `On R1 set next-hop-self towards the iBGP neighbour R2 (Junos: export policy with "then next-hop self"), or advertise the ISP link into OSPF.`], why: `iBGP keeps the next hop learned from eBGP. R2 learned 203.0.${x}.0/24 with next hop 198.51.${x}.1, an address that is not in its IGP, so the route is unusable. next-hop-self on R1 replaces it by R1's loopback.` });
      faults.push({ id: "updsrc", ok: true, title: "iBGP update-source missing", ticket: `R1 and R2 are the iBGP pair of our AS, but the session is down. OSPF between them is healthy.`, apply() { const v = rnd() < 0.5 ? R1 : R2, ip = v === R1 ? `10.255.${x}.2` : `10.255.${x}.1`; const n = v.bgp.neighbors[ip]; const was = n.updateSource; delete n.updateSource; return () => { n.updateSource = was; }; }, hints: [`The neighbour addresses are loopbacks. Which address is the TCP session sourced from?`, `One router does not use its loopback as the source.`, `Configure update-source Loopback0 (Junos: local-address) on the router that lacks it.`], why: `The peer is configured with the other router's loopback and only accepts sessions from it. Without update-source the session comes from the link address and is rejected.` });
      faults.push({ id: "ospfloop", ok: true, title: "Loopback not in the IGP", ticket: `The iBGP session between R1 and R2 never establishes. Both routers have the neighbour configured with the correct AS.`, apply() { const i = R2.ifs[lo2], was = i.ospf.area; if (R2.os === "ios" || R2.os === "eos") { const k = R2.ospf.networks.findIndex((q) => q.ifc === lo2), w = R2.ospf.networks.splice(k, 1)[0]; return () => R2.ospf.networks.splice(k, 0, w); } i.ospf.area = null; return () => { i.ospf.area = was; }; }, hints: [`Can R1 ping R2's loopback ${`10.255.${x}.2`}?`, `R2's loopback is not advertised by OSPF.`, `Put R2's Loopback0 into OSPF area 0 (network statement or interface area).`], why: `iBGP sessions between loopbacks depend on the IGP to carry the loopbacks. Without a route to the peer loopback TCP cannot connect.` });
      const f = pickFault(rnd, faults, o);
      return { net, spec, pos, links, fault: f, vendors: os, intro: `Your AS ${mine} (R1, R2) connects to an ISP (AS ${isp}). R1 and R2 run OSPF plus an iBGP session between loopbacks.` };
    },
  };

  SC.vlan = {
    title: "VLANs and trunks", area: "Switching",
    build(rnd, o) {
      const net = N.newNet(), swOs = ["ios", "eos", "nxos"], os = [pickOs(rnd, swOs), pickOs(rnd, swOs)], v = [10, 20, 30, 40, 50, 100][Math.floor(rnd() * 6)], x = 10 + Math.floor(rnd() * 150);
      const S1 = mk(net, "SW1", os[0], "switch"), S2 = mk(net, "SW2", os[1], "switch"), H1 = mk(net, "H1", "linux"), H2 = mk(net, "H2", "linux"), H3 = mk(net, "H3", "linux");
      const trunk = link(net, S1, S2), p1 = link(net, S1, H1, null, `10.${x}.${v}.11/24`), p2 = link(net, S2, H2, null, `10.${x}.${v}.12/24`), p3 = link(net, S2, H3, null, `10.${x}.${v + 1}.13/24`);
      for (const s of [S1, S2]) { s.vlans[v] = "USERS"; s.vlans[v + 1] = "GUEST"; }
      const T = (s, nm) => Object.assign(s.ifs[nm], { mode: "trunk", allowed: [v, v + 1], native: 1 });
      T(S1, trunk[0]); T(S2, trunk[1]); S1.ifs[p1[0]].mode = "access"; S1.ifs[p1[0]].accessVlan = v; S2.ifs[p2[0]].mode = "access"; S2.ifs[p2[0]].accessVlan = v; S2.ifs[p3[0]].mode = "access"; S2.ifs[p3[0]].accessVlan = v + 1;
      const pos = { H1: { x: 10, y: 22 }, SW1: { x: 34, y: 50 }, SW2: { x: 66, y: 50 }, H2: { x: 90, y: 22 }, H3: { x: 90, y: 80 } };
      const spec = { checks: [{ id: "a", from: "H1", to: `10.${x}.${v}.12`, label: `H1 cannot reach H2 (both are in VLAN ${v})` }, { id: "b", from: "H2", to: `10.${x}.${v}.11`, label: `H2 cannot reach H1` }] };
      const links = [{ a: "H1", b: "SW1" }, { a: "SW1", b: "SW2" }, { a: "SW2", b: "H2" }, { a: "SW2", b: "H3" }];
      const faults = [];
      faults.push({ id: "access", ok: true, title: "Wrong access VLAN", ticket: `A technician moved H2 to a new patch port. It can no longer talk to H1 although both belong to the same team (VLAN ${v}).`, apply() { const i = S2.ifs[p2[0]]; const was = i.accessVlan; i.accessVlan = v + 1; return () => { i.accessVlan = was; }; }, hints: [`Compare the VLAN of the two host ports ("show vlan brief").`, `H2's port is not in the same VLAN as H1's.`, `Put ${p2[0]} on SW2 in VLAN ${v} (switchport access vlan ${v}).`], why: `Hosts talk at layer 2 only inside the same VLAN. With H2's port in VLAN ${v + 1}, its frames never reach VLAN ${v}.` });
      faults.push({ id: "allowed", ok: true, title: "VLAN not allowed on the trunk", ticket: `Since the trunk was re-configured, hosts on different switches in VLAN ${v} lost contact.`, apply() { const i = S1.ifs[trunk[0]]; const was = i.allowed.slice(); i.allowed = i.allowed.filter((q) => q !== v); return () => { i.allowed = was; }; }, hints: [`Look at which VLANs each end of the trunk carries ("show interfaces trunk").`, `VLAN ${v} is not in the allowed list on one side of the trunk.`, `Add VLAN ${v} to the allowed VLANs on ${trunk[0]} of SW1 (switchport trunk allowed vlan add ${v}).`], why: `A trunk only carries the VLANs in its allowed list. If VLAN ${v} is pruned on one end, frames of that VLAN are dropped.` });
      faults.push({ id: "novlan", ok: true, title: "VLAN missing on a switch", ticket: `H2's access port is configured for VLAN ${v} but H2 and H1 cannot communicate.`, apply() { const was = S2.vlans[v]; delete S2.vlans[v]; return () => { S2.vlans[v] = was; }; }, hints: [`Is VLAN ${v} present in the VLAN database of both switches?`, `SW2 does not know VLAN ${v}.`, `Create VLAN ${v} on SW2 (vlan ${v}).`], why: `On many platforms a port assigned to a VLAN that does not exist is inactive and traffic is not forwarded until the VLAN is created.` });
      faults.push({ id: "shut", ok: true, title: "Host port or trunk shut", ticket: `H1 lost link and cannot reach anything.`, apply() { const i = S1.ifs[p1[0]]; i.shutdown = true; return () => { i.shutdown = false; }; }, hints: [`Check the interface status of H1's switch port.`, `The port is administratively down.`, `Enable ${p1[0]} on SW1 (no shutdown).`], why: `An administratively down port forwards nothing. It usually results from a maintenance change that wasn't reverted.` });
      const f = pickFault(rnd, faults, o);
      return { net, spec, pos, links, fault: f, vendors: os, intro: `Two switches joined by a trunk, hosts in VLAN ${v} on both.` };
    },
  };

  SC.static = {
    title: "Static routing and filters", area: "Routing",
    build(rnd, o) {
      const net = N.newNet(), os = [pickOs(rnd, rtrs), pickOs(rnd, rtrs), pickOs(rnd, rtrs)], x = 10 + Math.floor(rnd() * 150);
      const R1 = mk(net, "R1", os[0]), R2 = mk(net, "R2", os[1]), R3 = mk(net, "R3", os[2]), H1 = mk(net, "H1", "linux"), H2 = mk(net, "H2", "linux");
      const a = link(net, R1, H1, `10.${x}.1.1/24`, `10.${x}.1.10/24`), b = link(net, R1, R2, `10.${x}.12.1/30`, `10.${x}.12.2/30`), c = link(net, R2, R3, `10.${x}.23.1/30`, `10.${x}.23.2/30`), d = link(net, R3, H2, `10.${x}.3.1/24`, `10.${x}.3.10/24`);
      gw(H1, `10.${x}.1.1`); gw(H2, `10.${x}.3.1`);
      const st = (dev, p, len, nh) => dev.statics.push({ pfx: p, len, nh, ad: dev.os === "junos" ? 5 : 1 });
      st(R1, `10.${x}.3.0`, 24, `10.${x}.12.2`); st(R2, `10.${x}.3.0`, 24, `10.${x}.23.2`); st(R2, `10.${x}.1.0`, 24, `10.${x}.12.1`); st(R3, `10.${x}.1.0`, 24, `10.${x}.23.1`);
      const pos = { H1: { x: 7, y: 50 }, R1: { x: 29, y: 50 }, R2: { x: 52, y: 50 }, R3: { x: 74, y: 50 }, H2: { x: 93, y: 50 } };
      const spec = { checks: [{ id: "a", from: "H1", to: `10.${x}.3.10`, label: `H1 (10.${x}.1.10) cannot reach H2 (10.${x}.3.10)` }, { id: "b", from: "H2", to: `10.${x}.1.10`, label: `H2 cannot reach H1` }] };
      const links = [{ a: "H1", b: "R1" }, { a: "R1", b: "R2" }, { a: "R2", b: "R3" }, { a: "R3", b: "H2" }];
      const faults = [];
      const del = (dev, pfx) => { const k = dev.statics.findIndex((q) => q.pfx === pfx); const w = dev.statics.splice(k, 1)[0]; return () => dev.statics.splice(k, 0, w); };
      faults.push({ id: "fwd", ok: true, title: "Missing forward route", ticket: `H1 cannot reach the new server network 10.${x}.3.0/24 behind R3.`, apply() { return del(R2, `10.${x}.3.0`); }, hints: [`Trace from H1 and see where the packets stop ("traceroute").`, `The last router that answers has no route to 10.${x}.3.0/24.`, `Add on R2 a static route 10.${x}.3.0/24 via 10.${x}.23.2.`], why: `Static routing needs an entry in every router on the path, in both directions. R2 had no route towards the server network, so it dropped the packets.` });
      faults.push({ id: "ret", ok: true, title: "Missing return route", ticket: `H1 can trace all the way to H2's router, but pings to H2 get no answer.`, apply() { return del(R3, `10.${x}.1.0`); }, hints: [`Traceroute reaches the target network, so the forward path works. Think about the way back.`, `Does R3 know how to reach 10.${x}.1.0/24?`, `Add on R3 a static route 10.${x}.1.0/24 via 10.${x}.23.1.`], why: `Reply packets travel the reverse path; with no return route on R3 the echo request arrives but the reply is dropped.` });
      faults.push({ id: "nexthop", ok: true, title: "Wrong next hop", ticket: `After a re-addressing the route to the server LAN on R1 stopped working.`, apply() { const s = R1.statics[0]; const was = s.nh; s.nh = `10.${x}.12.9`; return () => { s.nh = was; }; }, hints: [`Check "show ip route" on R1: is the route to 10.${x}.3.0/24 installed?`, `The next hop of the static route is not on a connected subnet of R1 / not a router.`, `Point the route on R1 to 10.${x}.12.2 (R2's address on the shared link).`], why: `A static route is installed only if its next hop is reachable through a connected network, and is useful only if it is an address of the next router.` });
      faults.push({ id: "gw", ok: true, title: "Wrong default gateway on host", ticket: `H2 can reach its own LAN but nothing beyond.`, apply() { const s = H2.statics[0]; const was = s.nh; s.nh = `10.${x}.3.254`; return () => { s.nh = was; }; }, hints: [`On H2 check the default route (ip route).`, `The default gateway is not R3's address.`, `Set the default gateway of H2 to 10.${x}.3.1 (sudo ip route replace default via 10.${x}.3.1).`], why: `A host sends everything off-link to its default gateway. If it is wrong, packets never reach the router.` });
      if (R2.os !== "junos") faults.push({ id: "acl", ok: true, title: "ACL blocking traffic", ticket: `A security ACL was applied on R2 yesterday. Since then nothing works between the two sites.`, apply() { const nm = c0(R2); R2.acls.EDGE_IN = [{ action: "deny", proto: "icmp", src: "any", dst: "any", port: null }, { action: "permit", proto: "ip", src: "any", dst: "any", port: null }]; R2.ifs[nm].acl.in = "EDGE_IN"; return () => { R2.ifs[nm].acl.in = null; delete R2.acls.EDGE_IN; }; }, hints: [`Routing looks right on every router. Is something filtering?`, `Check the interfaces of R2 for an access-group and show the ACL.`, `ACL EDGE_IN on R2 denies ICMP. Remove it from the interface or permit ICMP.`], why: `An ACL applied on an interface filters traffic before routing. The deny for ICMP drops every ping while other traffic would still pass.` });
      function c0(r) { return r.order[0]; }
      const f = pickFault(rnd, faults, o);
      return { net, spec, pos, links, fault: f, vendors: os, intro: `Two sites connected by three routers with static routes.` };
    },
  };


  SC.evpn = {
    title: "VXLAN EVPN fabric", area: "Data centre",
    build(rnd, o) {
      const net = N.newNet(), fab = ["nxos", "eos"], x = 10 + Math.floor(rnd() * 150), asn = 65000 + Math.floor(rnd() * 400);
      const SP = [1, 2].map((j) => mk(net, "S" + j, pickOs(rnd, fab), "router")), LF = [1, 2, 3].map((k) => mk(net, "L" + k, pickOs(rnd, fab), "router"));
      const HS = { H1: [LF[0], 10, 11], H2: [LF[1], 10, 12], H3: [LF[2], 20, 13], H4: [LF[0], 20, 14] }, hosts = {};
      for (const sp of SP) { sp.role = "router"; }
      const lo0 = {}, lo1 = {}, sp0 = {};
      SP.forEach((s, j) => { sp0[s.name] = loop(s, `10.255.${x}.${j + 1}`); });
      LF.forEach((l, k) => { lo0[l.name] = loop(l, `10.255.${x}.${11 + k}`); });
      // second loopback = VTEP source
      LF.forEach((l, k) => { const nm = l.os === "nxos" ? "loopback1" : "Loopback1"; N.addIf(l, nm, { ip: { addr: `10.254.${x}.${k + 1}`, len: 32 }, loopback: true }); lo1[l.name] = nm; });
      const fabIf = {};
      LF.forEach((l, k) => SP.forEach((s, j) => { const [a, b] = link(net, s, l, `10.${x}.${10 * (k + 1) + j + 1}.1/30`, `10.${x}.${10 * (k + 1) + j + 1}.2/30`); fabIf[s.name + l.name] = a; fabIf[l.name + s.name] = b; if (l.os !== "linux") { /* routed ports */ } }));
      const ospfItems = (d) => d.order.filter((nm) => d.ifs[nm].ip && !d.ifs[nm].svi).map((nm) => ({ ifc: nm, passive: !!d.ifs[nm].loopback }));
      // overlay
      const vlans = [10, 20], vni = (v) => 10000 + v;
      LF.forEach((l, k) => {
        for (const v of vlans) { l.vlans[v] = "VLAN" + v; const nm = "Vlan" + v; N.addIf(l, nm, { svi: v, mode: "routed", ip: { addr: `10.${x}.${v}.1`, len: 24 }, anycast: true }); }
      });
      for (const [h, [leaf, v, n]] of Object.entries(HS)) { const H = mk(net, h, "linux"); hosts[h] = H; const [pa] = link(net, leaf, H, null, `10.${x}.${v}.${n}/24`); leaf.ifs[pa].mode = "access"; leaf.ifs[pa].accessVlan = v; gw(H, `10.${x}.${v}.1`); }
      for (const l of LF) { const nm = l.os === "nxos" ? "nve1" : "Vxlan1"; N.addIf(l, nm, { loopback: true, virtual: true, mode: "routed", shutdown: false }); l.vxlan = { features: { nv: true, vnseg: true, nvEvpn: true }, nve: { ifc: nm, src: lo1[l.name] }, vlanVni: { 10: vni(10), 20: vni(20) }, members: { [vni(10)]: true, [vni(20)]: true }, gwMac: "0000.2222.3333" }; l.evpn = { vnis: {}, vlans: {} };
        for (const v of vlans) { if (l.os === "nxos") l.evpn.vnis[vni(v)] = { rd: "auto", imp: ["auto"], exp: ["auto"] }; else l.evpn.vlans[v] = { rd: "auto", imp: [`${asn}:${vni(v)}`], exp: [`${asn}:${vni(v)}`], learned: true }; } }
      for (const d of SP.concat(LF)) { ospfOn(d, d.ifs[d.order.find((q) => d.ifs[q].loopback && !d.ifs[q].virtual)].ip.addr, ospfItems(d)); }
      const ridOf = (d) => d.ifs[d.order.find((q) => d.ifs[q].loopback && !d.ifs[q].virtual)].ip.addr;
      for (const d of SP.concat(LF)) bgpOn(d, asn, ridOf(d));
      for (const s of SP) for (const l of LF) { nb(s, ridOf(l), { remoteAs: asn, updateSource: sp0[s.name], evpn: true, extComm: true, rrClient: true }); nb(l, ridOf(s), { remoteAs: asn, updateSource: lo0[l.name], evpn: true, extComm: true }); }
      const pos = { S1: { x: 32, y: 12 }, S2: { x: 68, y: 12 }, L1: { x: 18, y: 48 }, L2: { x: 50, y: 48 }, L3: { x: 82, y: 48 }, H1: { x: 8, y: 86 }, H4: { x: 28, y: 86 }, H2: { x: 50, y: 86 }, H3: { x: 82, y: 86 } };
      const links = []; for (const s of SP) for (const l of LF) links.push({ a: s.name, b: l.name }); for (const [h, [leaf]] of Object.entries(HS)) links.push({ a: leaf.name, b: h });
      const ip = (h) => `10.${x}.${HS[h][1]}.${HS[h][2]}`;
      const chk = (id, a, b) => ({ id, from: a, to: ip(b), label: `${a} (${ip(a)}) cannot reach ${b} (${ip(b)})` });
      const spec = { checks: [chk("a", "H1", "H2"), chk("b", "H2", "H1"), chk("c", "H4", "H3"), chk("d", "H3", "H4"), chk("e", "H1", "H3"), chk("f", "H3", "H2")] };
      const V = LF[Math.floor(rnd() * 3)], others = LF.filter((q) => q !== V), vv = vni(10), nxv = V.os === "nxos";
      const nbs = (l) => SP.map((s) => l.bgp.neighbors[ridOf(s)]);
      const faults = [];
      faults.push({ id: "vtep-underlay", ok: true, title: "VTEP loopback not in the underlay", ticket: `After ${V.name} was re-cabled, hosts behind it can no longer talk to the rest of the fabric. BGP to the spines looks fine.`, apply() { const nm = lo1[V.name]; if (V.os === "eos") { const k = V.ospf.networks.findIndex((q) => q.ifc === nm), w = V.ospf.networks.splice(k, 1)[0]; return () => V.ospf.networks.splice(k, 0, w); } const i = V.ifs[nm], was = i.ospf.area; i.ospf.area = null; return () => { i.ospf.area = was; }; }, hints: [`Look at the NVE peers and VNIs on ${V.name} and on another leaf. Which VTEP address is missing or Down?`, `The VTEP addresses are the ${lo1[V.name]} loopbacks. Can the other leaves ping ${V.name}'s VTEP address 10.254.${x}.${LF.indexOf(V) + 1}?`, `${lo1[V.name]} on ${V.name} is not advertised in the underlay (OSPF). Add it to OSPF area 0.`], why: `VXLAN tunnels run between VTEP addresses. The VTEP loopback has to be reachable through the underlay routing protocol; otherwise EVPN routes arrive, but the tunnel endpoint is unreachable and the peer stays Down.` });
      faults.push({ id: "vni-mismatch", ok: true, title: "VLAN-to-VNI mismatch", ticket: `Hosts in VLAN 10 on ${V.name} cannot reach VLAN 10 hosts on other leaves after a VLAN clean-up.`, apply() { const was = V.vxlan.vlanVni[10], nw = was + 100; V.vxlan.vlanVni[10] = nw; if (V.os === "nxos") { V.vxlan.members[nw] = true; delete V.vxlan.members[was]; V.evpn.vnis[nw] = V.evpn.vnis[was]; delete V.evpn.vnis[was]; } return () => { V.vxlan.vlanVni[10] = was; }; }, hints: [`Compare "show nve vni" / "show vxlan vni" on ${V.name} with another leaf.`, `VLAN 10 maps to a different VNI on ${V.name}.`, `Map VLAN 10 to VNI ${vv} on ${V.name} (${nxv ? "vlan 10 / vn-segment " + vv + ", nve member vni, evpn vni block" : "interface Vxlan1 / vxlan vlan 10 vni " + vv}).`], why: `The VNI, not the VLAN, identifies the segment in the VXLAN header and in EVPN routes. Both leaves must map the VLAN to the same VNI, otherwise their routes and traffic never meet.` });
      faults.push({ id: "rt-mismatch", ok: true, title: "Route-target mismatch", ticket: `${V.name} sees the other leaves as VTEP peers, but MACs from VLAN 10 never appear there.`, apply() { const c = nxv ? V.evpn.vnis[vv] : V.evpn.vlans[10]; const was = c.imp.slice(); c.imp = [`${asn}:${vv + 1}`]; return () => { c.imp = was; }; }, hints: [`Compare the route-target configuration of VLAN 10 on ${V.name} with another leaf.`, `${V.name} imports a different route-target for VNI ${vv}.`, `Import route-target ${asn}:${vv} for VNI ${vv} on ${V.name} (${nxv ? "evpn / vni " + vv + " l2 / route-target import auto" : "router bgp / vlan 10 / route-target both " + asn + ":" + vv}).`], why: `EVPN routes are imported only if their route-target matches an import target of the VNI. With the wrong import target, ${V.name} receives the routes but ignores them.` });
      faults.push({ id: "extcomm", ok: true, title: "Extended communities not sent", ticket: `BGP EVPN sessions of ${V.name} are Established and prefixes are exchanged, yet no remote MACs are installed.`, apply() { const ns = nbs(V), was = ns.map((n) => n.extComm); ns.forEach((n) => { n.extComm = false; }); return () => ns.forEach((n, i) => { n.extComm = was[i]; }); }, hints: [`Routes arrive but are not imported. What do imported routes depend on? (route-targets travel as extended communities)`, `Check whether ${V.name} sends extended communities to its EVPN neighbours.`, `Configure "send-community extended" for the EVPN address family of both spine neighbours on ${V.name}.`], why: `Route-targets are carried as BGP extended communities. A neighbour without send-community extended strips them, so receivers cannot match any import route-target.` });
      faults.push({ id: "af-activate", ok: true, title: "EVPN address-family not activated", ticket: `A new leaf (${V.name}) joined the fabric. Its hosts are isolated, but ${V.name} has BGP sessions to both spines.`, apply() { const ns = nbs(V); ns.forEach((n) => { n.evpn = false; }); return () => ns.forEach((n) => { n.evpn = true; }); }, hints: [`Compare "show bgp l2vpn evpn summary" / "show bgp evpn summary" on ${V.name} with another leaf.`, `The spines do not appear in the EVPN neighbour list on ${V.name}.`, `Activate the neighbours (the spine loopbacks) under address-family ${nxv ? "l2vpn evpn" : "evpn"} on ${V.name}.`], why: `A BGP session carries only the address families both sides activate. Without l2vpn evpn, the session stays up for IPv4 but exchanges no EVPN routes.` });
      faults.push({ id: "nve-shut", ok: true, title: "NVE interface down", ticket: `${V.name} was reloaded after a power event. Its local hosts reach each other, nothing else.`, apply() { const i = V.ifs[V.vxlan.nve.ifc], was = i.shutdown; i.shutdown = true; return () => { i.shutdown = was; }; }, hints: [`Check the state of the VXLAN interface on ${V.name}.`, `The VTEP interface is shut down.`, `Enable ${V.vxlan.nve.ifc} on ${V.name} (no shutdown).`], why: `The NVE/Vxlan interface is the VTEP. While it is administratively down, no tunnels exist and no EVPN routes are originated.` });
      faults.push({ id: "src-down", ok: true, title: "VTEP source interface down", ticket: `Since a clean-up, ${V.name} reports an NVE that is Down.`, apply() { const i = V.ifs[lo1[V.name]], was = i.shutdown; i.shutdown = true; return () => { i.shutdown = was; }; }, hints: [`Check the NVE state and which interface is its source.`, `The source interface of the NVE is down.`, `Bring ${lo1[V.name]} on ${V.name} back up (no shutdown).`], why: `The VTEP IP is the address of the NVE source interface. If that loopback is down, there is no tunnel endpoint at all.` });
      faults.push({ id: "no-rr", ok: true, title: "Spines not reflecting", ticket: `All leaves have EVPN sessions to both spines, yet no leaf learns anything from another leaf.`, apply() { const ns = []; for (const s of SP) for (const n of Object.values(s.bgp.neighbors)) ns.push(n); const was = ns.map((n) => n.rrClient); ns.forEach((n) => { n.rrClient = false; }); return () => ns.forEach((n, i) => { n.rrClient = was[i]; }); }, hints: [`On a leaf, look at how many EVPN prefixes it receives from the spines.`, `The spines receive routes from the leaves but do not pass them on. Which iBGP rule explains that?`, `Make the leaves route-reflector clients on both spines (address-family l2vpn evpn / route-reflector-client).`], why: `iBGP does not re-advertise routes learned from an iBGP peer. For an iBGP EVPN fabric the spines act as route reflectors, otherwise leaves never receive each other's routes.` });
      faults.push({ id: "vlan-vni-missing", ok: true, title: "VLAN not mapped to a VNI", ticket: `VLAN 10 was added on ${V.name} for a new tenant but its hosts cannot reach other leaves.`, apply() { const was = V.vxlan.vlanVni[10]; delete V.vxlan.vlanVni[10]; return () => { V.vxlan.vlanVni[10] = was; }; }, hints: [`List the VNIs of ${V.name} and compare with another leaf.`, `VLAN 10 has no VNI on ${V.name}.`, `Map VLAN 10 to VNI ${vv} on ${V.name}.`], why: `A VLAN is carried over VXLAN only when it is mapped to a VNI. Without a mapping VLAN 10 stays local to the leaf.` });
      faults.push({ id: "member-vni", ok: nxv, title: "VNI not a member of the NVE", ticket: `${V.name} (NX-OS) was migrated to a new template. VLAN 10 is no longer stretched.`, apply() { const was = V.vxlan.members[vv]; V.vxlan.members[vv] = false; return () => { V.vxlan.members[vv] = was; }; }, hints: [`Check "show nve vni" on ${V.name}: is VNI ${vv} listed?`, `The VNI is missing under the NVE interface.`, `interface nve1 / member vni ${vv}.`], why: `On NX-OS a VNI has to be a member of the NVE interface to be encapsulated. Without it the VLAN-to-VNI map exists but no VNI is active.` });
      faults.push({ id: "feature-evpn", ok: nxv, title: "nv overlay evpn missing", ticket: `${V.name} (NX-OS) ignores EVPN entirely after a configuration restore.`, apply() { const was = V.vxlan.features.nvEvpn; V.vxlan.features.nvEvpn = false; return () => { V.vxlan.features.nvEvpn = was; }; }, hints: [`Check the NVE interface state and why the VTEP is Down.`, `The global EVPN control-plane command is missing.`, `Enter "nv overlay evpn" in global configuration mode.`], why: `On NX-OS the command "nv overlay evpn" enables the EVPN control plane for the VXLAN. Without it, the NVE does not come up in control-plane mode.` });
      const f = pickFault(rnd, faults, o);
      return { net, spec, pos, links, fault: f, vendors: SP.concat(LF).map((d) => d.os), intro: `A small VXLAN EVPN fabric: two spines (BGP route reflectors, AS ${asn}), three leaves with anycast gateways, OSPF underlay. VLAN 10 and VLAN 20 are stretched over VNI ${vni(10)} and ${vni(20)} (asymmetric IRB: every leaf has both gateways).` };
    },
  };

  function pickFault(rnd, list, o) { const ok = list.filter((f) => f.ok && (!o || !o.fault || f.id === o.fault)); const f = ok[Math.floor(rnd() * ok.length)] || list[0]; f.all = list; return f; }
  // Every fault with the difficulty tier (1 easiest .. 4 hardest) the training path uses.
  const TIERS = {
    ospf: { shut: 1, passive: 1, network: 1, hello: 2, area: 2, mtu: 2, auth: 3, rid: 3 },
    bgp: { remoteas: 1, noneighbor: 1, shut: 1, network: 2, password: 2, updsrc: 3, multihop: 3 },
    ibgp: { nhs: 3, updsrc: 3, ospfloop: 4 },
    vlan: { access: 1, shut: 1, allowed: 2, novlan: 2 },
    static: { fwd: 1, ret: 1, nexthop: 2, gw: 2, acl: 3 },
    evpn: { "nve-shut": 3, "src-down": 3, "vtep-underlay": 3, "af-activate": 4, "vlan-vni-missing": 4, "vni-mismatch": 4, "member-vni": 4, "feature-evpn": 4, extcomm: 4, "rt-mismatch": 4, "no-rr": 4 },
  };

  const CATALOG = Object.keys(SC).map((k) => ({ id: k, title: SC[k].title, area: SC[k].area }));

  // opts.double: two independent faults at once (an incident with more than one cause).
  function make(sc, seed, opts, broken) {
    const b = sc.build(rngOf(seed), opts || {}), f = b.fault;
    if (opts && opts.double && f.all) {
      const pool = f.all.filter((x) => x.ok && x.id !== f.id), r2 = rngOf(seed * 31 + 17);
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r2() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      let first = null, second = null;
      if (broken) { f.apply(); for (const g of pool) { try { g.apply(); second = g; break; } catch (e) { /* this pair clashes, try the next */ } } }
      else { for (const g of pool) { const probe = sc.build(rngOf(seed), opts || {}); const pf = probe.fault, pg = pf.all.find((x) => x.id === g.id); try { pf.apply(); pg.apply(); second = g; break; } catch (e) { /* clash */ } } }
      if (second) {
        const hs = []; for (let i = 0; i < Math.max(f.hints.length, second.hints.length); i++) { if (f.hints[i]) hs.push(f.hints[i]); if (second.hints[i]) hs.push(second.hints[i]); }
        b.fault = { id: f.id + "+" + second.id, title: f.title + " and " + second.title, ticket: "Two separate problems were reported. (1) " + f.ticket + " (2) " + second.ticket, hints: hs.slice(0, 6), why: f.why + " Second fault: " + second.why, apply() {} };
      } else if (broken) { first = f; }
      void first;
    } else if (broken) f.apply();
    finalize(b.net); return b;
  }
  function create(scenario, seed, opts) {
    const sc = SC[scenario]; if (!sc) return null;
    const h = make(sc, seed, opts, false), b = make(sc, seed, opts, true);
    const lab = { scenario, seed, opts: opts || {}, title: sc.title, area: sc.area, net: b.net, healthy: h.net, spec: b.spec, pos: b.pos, links: b.links, vendors: b.vendors, intro: b.intro, faultId: b.fault.id, faultTitle: b.fault.title, ticket: b.fault.ticket, hints: b.fault.hints, why: b.fault.why, used: 0, cmds: 0, solved: false };
    lab.baseline = snapshot(h.net, h.spec); lab.broken = verify(lab).problems;
    return lab;
  }
  // reference solution (tests, and the reveal): swap in the healthy network
  function reference(lab) { lab.net = lab.healthy; }
  function score(lab) { const eff = Math.max(0, lab.cmds - 30); return Math.max(10, 100 - lab.used * 15 - Math.min(30, eff)); }
  function serialise(lab) { const n = JSON.parse(JSON.stringify(lab.net, (k, v) => (k === "_R" ? undefined : v))); return { scenario: lab.scenario, seed: lab.seed, net: n, used: lab.used, cmds: lab.cmds, solved: lab.solved, faultId: lab.faultId }; }
  function describe(lab) { return lab.net && Object.values(lab.net.devices).map((d) => `${d.name} (${NAMES[d.os]})`); }
  const api = { TIERS, CATALOG, create, verify, reference, score, serialise, describe, NAMES, finalize, sync, emitJunos, snapshot, rngOf };
  root.Netlabs = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
