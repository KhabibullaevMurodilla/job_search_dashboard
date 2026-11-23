/* Netios: the command set for Cisco IOS-XE, Cisco NX-OS and Arista EOS.
   One command table; the style flag changes output formats, names and the few
   commands that differ (NX-OS "feature", EOS "no switchport", and so on). */
(function (root) {
  "use strict";
  const C = root.Netcli || (typeof require !== "undefined" ? require("./netcli.js") : null);
  const { N, pad, padL, hash, upt, maskOf, resolveIf, short, compile, dispatch, caretErr, ribRows, showRouteIos, ospfStateStr, runConfig, logLines, ifStatus, Session } = C;
  const { ip2n, n2ip, lenMask, maskLen, wildLen, netOf, inNet } = N;

  const EX = ["user", "priv"], SHOW = ["user", "priv"], PRIV = ["priv"], CFG = ["config"], IF = ["if"], OSPF = ["ospf"], BGP = ["bgp", "af"];
  const ALLCFG = ["config", "if", "ospf", "bgp", "af", "vlan", "rmap", "acl"];
  const mac = (k) => { const h = hash(k).toString(16).padStart(8, "0"); return `0050.56${h.slice(0, 2)}.${h.slice(2, 6)}`; };
  const vlanList = (s) => { const out = []; for (const part of String(s).split(",")) { const m = part.match(/^(\d+)(?:-(\d+))?$/); if (!m) return null; const a = +m[1], b = m[2] ? +m[2] : a; if (a < 1 || b > 4094 || b < a) return null; for (let v = a; v <= b; v++) out.push(v); } return out; };
  const parseNet = (a, b) => { // "10.0.0.0" + mask  or  "10.0.0.0/24"
    if (a.indexOf("/") >= 0) { const c = N.cidr(a); return c ? { ip: c.ip, len: c.len, used: 1 } : null; }
    const l = maskLen(b || ""); return ip2n(a) !== null && l !== null ? { ip: a, len: l, used: 2 } : null;
  };
  const isIp = (s) => ip2n(s) !== null;

  function reachText(style, R, d, target, srcOpt, count) {
    const net = R.net; count = count || 5;
    if (!isIp(target)) return style === "ios" ? "% Unrecognized host or address, or protocol not running." : `ping: ${target}: Name or service not known`;
    let source = null; if (srcOpt) { const D = net.devices[d]; const nm = resolveIf(D, srcOpt); if (nm) source = D.ifs[nm].ip && R.line[d][nm] ? D.ifs[nm].ip.addr : null; else if (isIp(srcOpt)) source = srcOpt; if (!source) return style === "ios" ? "% Invalid source address or interface" : "ping: invalid source"; }
    const r = N.ping(R, d, target, { source });
    const h = hash(d + target), rtt = (i) => 1 + ((h >>> (i * 3)) % 5);
    if (style === "ios") {
      let sym = "!"; if (!r.ok) sym = r.fail.kind === "noroute" && r.fail.at === d ? "." : (r.fail.kind === "noroute" || r.fail.kind === "acl") ? "U" : ".";
      const marks = r.ok ? "!".repeat(count) : (sym === "U" ? "U".repeat(count) : ".".repeat(count)), good = r.ok ? count : 0;
      return `Type escape sequence to abort.\nSending ${count}, 100-byte ICMP Echos to ${target}, timeout is 2 seconds:\n${source ? "Packet sent with a source address of " + source + "\n" : ""}${marks}\nSuccess rate is ${Math.round(good * 100 / count)} percent (${good}/${count})${r.ok ? `, round-trip min/avg/max = ${rtt(0)}/${rtt(1) + 1}/${rtt(2) + 3} ms` : ""}`;
    }
    const ttl = style === "junos" ? 64 : 64 - (r.hops ? r.hops.length : 0);
    const head = style === "junos" ? `PING ${target} (${target}): 56 data bytes` : `PING ${target} (${target}) 72(100) bytes of data.`;
    if (r.ok) { const L = [head]; for (let i = 1; i <= count; i++) L.push(style === "junos" ? `64 bytes from ${target}: icmp_seq=${i - 1} ttl=${ttl} time=${rtt(i)}.${hash(d + i) % 10} ms` : `80 bytes from ${target}: icmp_seq=${i} ttl=${ttl} time=${rtt(i)}.${hash(d + i) % 10} ms`); L.push("", `--- ${target} ping statistics ---`, style === "junos" ? `${count} packets transmitted, ${count} packets received, 0% packet loss\nround-trip min/avg/max/stddev = 1.0/2.0/4.0/0.8 ms` : `${count} packets transmitted, ${count} received, 0% packet loss, time ${count * 8}ms\nrtt min/avg/max/mdev = 1.0/2.0/4.0/0.8 ms`); return L.join("\n"); }
    const L = [head];
    if (r.fail.kind === "noroute" && r.fail.at === d) L.push(style === "junos" ? "ping: sendto: No route to host" : "connect: Network is unreachable");
    else { const where = r.hops && r.hops.length ? r.hops[r.hops.length - 1].ip : (r.srcIp || target); for (let i = 1; i <= count; i++) { if (r.fail.kind === "noroute") L.push(`From ${where} icmp_seq=${i} Destination Net Unreachable`); else if (r.fail.kind === "acl") L.push(`From ${where} icmp_seq=${i} Destination Host Unreachable`.replace("Host Unreachable", "Packet filtered")); else if (r.fail.kind === "arp") L.push(`From ${r.srcIp || where} icmp_seq=${i} Destination Host Unreachable`); } }
    L.push("", `--- ${target} ping statistics ---`, `${count} packets transmitted, 0 received, 100% packet loss, time ${count * 1000}ms`); return L.join("\n");
  }
  function traceText(style, R, d, target) {
    if (!isIp(target)) return "% Unrecognized host or address, or protocol not running.";
    const r = N.ping(R, d, target), L = [];
    const rows = (r.hops || []).map((h) => h.ip); const stars = r.ok ? 0 : 3;
    if (style === "ios") L.push("Type escape sequence to abort.", `Tracing the route to ${target}`, "VRF info: (vrf in name/id, vrf out name/id)"); else L.push(`traceroute to ${target} (${target}), 30 hops max, 60 byte packets`);
    rows.forEach((ip, k) => L.push(style === "ios" ? `  ${k + 1} ${ip} ${1 + k} msec ${2 + k} msec ${1 + k} msec` : `${padL(k + 1, 2)}  ${ip} (${ip})  ${1 + k}.${hash(ip) % 9} ms  ${1 + k}.${hash(ip + "b") % 9} ms  ${2 + k}.${hash(ip + "c") % 9} ms`));
    for (let k = 0; k < stars; k++) L.push(style === "ios" ? `  ${rows.length + k + 1}  *  *  * ` : `${padL(rows.length + k + 1, 2)}  * * *`);
    return L.join("\n");
  }

  // ------------------------------------------------------------ show handlers
  function bgpSummary(c) {
    const { R, d, style } = c, D = c.D, B = D.bgp; if (!B) return style === "ios" ? "% BGP not active" : "BGP is not running";
    const rid = B.rid || R.ospf[d].rid || "0.0.0.0", L = [];
    if (style === "eos") L.push(`BGP summary information for VRF default\nRouter identifier ${rid}, local AS number ${B.asn}\nNeighbor         V  AS           MsgRcvd   MsgSent  InQ OutQ  Up/Down State   PfxRcd PfxAcc`);
    else if (style === "nxos") L.push(`BGP summary information for VRF default, address family IPv4 Unicast\nBGP router identifier ${rid}, local AS number ${B.asn}\nBGP table version is 5, IPv4 Unicast config peers ${Object.keys(B.neighbors).length}, capable peers ${Object.values(R.bgp[d]).filter((x) => x.state === "Established").length}\n\nNeighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd`);
    else L.push(`BGP router identifier ${rid}, local AS number ${B.asn}\nBGP table version is 5, main routing table version 5\n\nNeighbor        V           AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd`);
    for (const ip of Object.keys(B.neighbors)) {
      const s = R.bgp[d][ip], nb = B.neighbors[ip], est = s.state === "Established"; const st = est ? String(s.pfxRcvd) : s.reason === "Admin down" ? "Idle (Admin)" : s.state;
      const up = est ? upt(d + ip) : "never", msgs = est ? 8 + (hash(d + ip) % 30) : 0;
      if (style === "eos") L.push(`${pad(ip, 16)} 4  ${pad(nb.remoteAs, 12)}${padL(msgs, 7)}${padL(msgs, 10)}${padL(0, 5)}${padL(0, 5)} ${pad(up, 8)} ${pad(est ? "Estab" : st, 7)}${est ? padL(s.pfxRcvd, 6) + padL(s.pfxRcvd, 7) : ""}`);
      else L.push(`${pad(ip, 15)} 4 ${padL(nb.remoteAs, 11)} ${padL(msgs, 7)} ${padL(msgs, 7)} ${padL(est ? 5 : 1, 8)} ${padL(0, 3)} ${padL(0, 4)} ${pad(up, 9)} ${st}`);
    }
    return L.join("\n");
  }
  function bgpTable(c, onlyPfx) {
    const { R, d, style } = c, T = R.bgpTable[d]; if (!c.D.bgp) return "% BGP not active";
    const keys = Object.keys(T).filter((k) => !onlyPfx || k === onlyPfx || k.split("/")[0] === onlyPfx).sort((a, b) => ip2n(a.split("/")[0]) - ip2n(b.split("/")[0]));
    if (onlyPfx && !keys.length) return `% Network not in table`;
    const L = [`BGP table version is 5, local router ID is ${c.D.bgp.rid || R.ospf[d].rid || "0.0.0.0"}\nStatus codes: s suppressed, d damped, h history, * valid, > best, i - internal,\n              r RIB-failure, S Stale, m multipath, b backup-path, f RT-Filter, \n              x best-external, a additional-path, c RIB-compressed, \nOrigin codes: i - IGP, e - EGP, ? - incomplete\n\n     Network          Next Hop            Metric LocPrf Weight Path`];
    for (const k of keys) for (const p of T[k]) { const flag = (p.valid ? "*" : " ") + (p.best ? ">" : " ") + (p.local ? " " : p.ebgp ? " " : "i"); L.push(`${flag}  ${pad(k, 17)}${pad(p.nh === null ? "0.0.0.0" : n2ip(p.nh), 20)}${padL(p.med || 0, 6)} ${padL(p.lp, 6)} ${padL(p.local ? 32768 : 0, 6)} ${p.asPath.join(" ")}${p.asPath.length ? " " : ""}${p.origin}`.replace(/\s+$/, "")); }
    return L.join("\n");
  }
  function bgpNeighbor(c, ip) {
    const { R, d, D } = c; if (!D.bgp) return "% BGP not active"; const nb = D.bgp.neighbors[ip]; if (!nb) return `% No such neighbor`; const s = R.bgp[d][ip], ext = nb.remoteAs !== D.bgp.asn;
    const L = [`BGP neighbor is ${ip},  remote AS ${nb.remoteAs}, ${ext ? "external" : "internal"} link`];
    if (nb.desc) L.push(` Description: ${nb.desc}`);
    L.push(`  BGP version 4, remote router ID ${s.state === "Established" ? s.rid : "0.0.0.0"}`, `  BGP state = ${s.state}${s.state === "Established" ? ", up for " + upt(d + ip) : ""}`);
    const reasons = { badas: "Last reset 00:00:10, due to BGP Notification received, OPEN Message Error/Bad Peer AS", "badas-peer": "Last reset 00:00:10, due to BGP Notification sent, OPEN Message Error/Bad Peer AS", badid: "Last reset 00:00:10, due to BGP Notification received, OPEN Message Error/Bad BGP Identifier" };
    L.push(`  Last read 00:00:07, last write 00:00:07, hold time is 180, keepalive interval is 60 seconds`);
    L.push(s.state === "Established" ? "  Last reset never" : reasons[s.reason] ? "  " + reasons[s.reason] : "  Last reset never");
    if (nb.updateSource) L.push(`  Update source is ${nb.updateSource}`);
    if (ext && nb.multihop) L.push(`  External BGP neighbor may be up to ${nb.multihop} hops away.`); else if (ext) { const direct = R.att.some((a) => a.dev === d && inNet(ip, a.ip, a.len)); if (!direct || nb.updateSource) L.push("  External BGP neighbor not directly connected."); }
    if (s.state === "Established") L.push(`  Prefixes received ${s.pfxRcvd}, sent ${s.pfxSent}`); else L.push(`  Connection state is ${s.state === "Idle" ? "IDLE" : "ACTIVE"}, I/O status: 1, unread input bytes: 0`, `  Connections established 0; dropped 0`);
    if (nb.rmIn) L.push(`  Route map for incoming advertisements is ${nb.rmIn}`); if (nb.rmOut) L.push(`  Route map for outgoing advertisements is ${nb.rmOut}`);
    L.push(s.state === "Established" ? "  Connection state is ESTAB, I/O status: 1, unread input bytes: 0" : "");
    return L.filter((x) => x !== "").join("\n");
  }
  function ospfNbrs(c) {
    const { R, d, style } = c, nb = R.ospf[d].nbrs; const L = [];
    if (style === "eos") L.push("Neighbor ID     Instance VRF      Pri State                  Dead Time   Address         Interface");
    else if (style === "nxos") L.push(` OSPF Process ID ${c.D.ospf ? c.D.ospf.pid : 1} VRF default\n Total number of neighbors: ${nb.length}\n Neighbor ID     Pri State            Up Time  Address         Interface`);
    else L.push("Neighbor ID     Pri   State           Dead Time   Address         Interface");
    for (const x of nb) { const st = ospfStateStr(R, d, x, style), pri = 1; if (style === "eos") L.push(`${pad(x.id, 15)} ${pad(c.D.ospf.pid, 8)} ${pad("default", 8)}${pad(pri, 4)}${pad(st, 23)}${pad("00:00:3" + (hash(d + x.id) % 10), 12)}${pad(x.addr, 16)}${x.iface}`); else if (style === "nxos") L.push(` ${pad(x.id, 15)} ${padL(pri, 3)} ${pad(st, 16)} ${pad(upt(d + x.id), 8)} ${pad(x.addr, 15)} ${short(x.iface)}`); else L.push(`${pad(x.id, 15)} ${padL(pri, 3)}   ${pad(st, 15)} 00:00:3${hash(d + x.id) % 10}    ${pad(x.addr, 15)} ${x.iface}`); }
    return L.join("\n");
  }
  function ospfIfaces(c, only) {
    const { R, d, D } = c; if (!D.ospf) return "% OSPF: Router process not configured";
    const L = [];
    for (const nm of D.order) { const o = R.ospf[d].ifs[nm]; if (!o) continue; if (only && nm !== only) continue; const i = D.ifs[nm], nbs = R.ospf[d].nbrs.filter((x) => x.iface === nm), full = nbs.filter((x) => x.state === "FULL").length;
      if (c.brief) { if (!L.length) L.push("Interface    PID   Area            IP Address/Mask    Cost  State Nbrs F/C"); L.push(`${pad(short(nm), 12)} ${pad(D.ospf.pid, 5)} ${pad(o.area, 15)} ${pad((i.ip ? i.ip.addr + "/" + i.ip.len : ""), 18)} ${pad(i.ospf.cost || 1, 5)} ${pad(!R.line[d][nm] ? "DOWN" : o.passive ? "DR" : i.loopback ? "LOOP" : full ? (ip2n(R.ospf[d].rid) > ip2n(nbs[0].id) ? "DR" : "BDR") : "DR", 5)} ${full}/${nbs.length}`); continue; }
      L.push(`${nm} is ${R.line[d][nm] ? "up" : "down"}, line protocol is ${R.line[d][nm] ? "up" : "down"}`, `  Internet Address ${i.ip.addr}/${i.ip.len}, Area ${o.area}, Attached via Interface Enable`, `  Process ID ${D.ospf.pid}, Router ID ${R.ospf[d].rid}, Network Type ${i.loopback ? "LOOPBACK" : i.ospf.type === "p2p" ? "POINT_TO_POINT" : "BROADCAST"}, Cost: ${i.ospf.cost || 1}`);
      if (!i.loopback) L.push(`  Transmit Delay is 1 sec, State ${o.passive ? "DR" : full ? "DR" : "DR"}, Priority 1`, `  Timer intervals configured, Hello ${i.ospf.hello}, Dead ${i.ospf.dead}, Wait ${i.ospf.dead}, Retransmit 5`, o.passive ? "  No Hellos (Passive interface)" : `    oob-resync timeout 40`, `  Neighbor Count is ${nbs.length}, Adjacent neighbor count is ${full}`); L.push(""); }
    return L.length ? L.join("\n").replace(/\n+$/, "") : "";
  }
  function vlanBrief(c) {
    const { D, R, d } = c, L = ["VLAN Name                             Status    Ports", "---- -------------------------------- --------- -------------------------------"];
    for (const v of Object.keys(D.vlans).map(Number).sort((a, b) => a - b)) { const ports = D.order.filter((nm) => D.ifs[nm].mode === "access" && D.ifs[nm].accessVlan === v).map((nm) => short(nm)); L.push(`${pad(v, 4)} ${pad(D.vlans[v], 32)} active    ${ports.join(", ")}`); }
    return L.join("\n");
  }
  function trunkTable(c) {
    const { D, R, d } = c, tr = D.order.filter((nm) => D.ifs[nm].mode === "trunk"); if (!tr.length) return "";
    const L = ["Port        Mode             Encapsulation  Status        Native vlan"]; for (const nm of tr) L.push(`${pad(short(nm), 11)} ${pad("on", 16)} ${pad("802.1q", 14)} ${pad(R.line[d][nm] ? "trunking" : "not-trunking", 13)} ${D.ifs[nm].native}`);
    L.push("", "Port        Vlans allowed on trunk"); for (const nm of tr) { const a = D.ifs[nm].allowed; L.push(`${pad(short(nm), 11)} ${a === null ? "1-4094" : a.join(",") || "none"}`); }
    L.push("", "Port        Vlans allowed and active in management domain"); for (const nm of tr) { const a = D.ifs[nm].allowed, act = Object.keys(D.vlans).map(Number).filter((v) => a === null || a.indexOf(v) >= 0); L.push(`${pad(short(nm), 11)} ${act.join(",") || "none"}`); }
    return L.join("\n");
  }
  function arpTable(c) {
    const { R, d, D } = c, L = ["Protocol  Address          Age (min)  Hardware Addr   Type   Interface"];
    for (const a of R.att) { if (a.dev !== d) continue; L.push(`Internet  ${pad(a.ip, 16)} -          ${mac(d + a.ifc)}  ARPA   ${a.ifc}`); for (const b of R.att) if (b.dev !== d && b.seg === a.seg && (inNet(b.ip, a.ip, a.len))) L.push(`Internet  ${pad(b.ip, 16)} ${pad(hash(b.ip) % 9, 10)} ${mac(b.dev + b.ifc)}  ARPA   ${a.ifc}`); }
    return L.join("\n");
  }
  function neighTable(c) {
    const { net, d, style, D } = c, nb = N.neighbors(net, d);
    const hdr = style === "eos" ? "Port       Neighbor Device ID            Neighbor Port ID           TTL" : style === "nxos" ? "Device ID        Local Intrfce  Hldtme Capability  Port ID" : "Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID";
    const L = [hdr]; for (const x of nb) { const pd = net.devices[x.peerDev]; if (style === "eos") L.push(`${pad(x.ifc, 10)} ${pad(pd.hostname, 29)} ${pad(x.peerIf, 26)} 120`); else if (style === "nxos") L.push(`${pad(pd.hostname, 16)} ${pad(short(x.ifc), 14)} 120    R S I      ${x.peerIf}`); else L.push(`${pad(pd.hostname, 16)} ${pad(short(x.ifc).replace(/(\D+)(\d)/, "$1 $2"), 17)} 150        R B        CSR1000V  ${short(x.peerIf).replace(/(\D+)(\d)/, "$1 $2")}`); }
    return L.join("\n");
  }
  function ifBrief(c) {
    const { net, R, d, D, style } = c, L = [];
    if (style === "ios") { L.push("Interface              IP-Address      OK? Method Status                Protocol"); for (const nm of D.order) { const i = D.ifs[nm], st = ifStatus(net, R, d, nm); L.push(`${pad(nm, 22)} ${pad(i.ip ? i.ip.addr : "unassigned", 15)} YES ${pad(i.ip ? "manual" : "unset", 6)} ${pad(st.status, 21)} ${st.proto}`); } }
    else if (style === "eos") { L.push("                                                                       Address\nInterface         IP Address            Status       Protocol            MTU    Owner"); for (const nm of D.order) { const i = D.ifs[nm]; if (!i.ip && N.isSwitchport(i)) continue; const st = ifStatus(net, R, d, nm); L.push(`${pad(nm, 17)} ${pad(i.ip ? i.ip.addr + "/" + i.ip.len : "unassigned", 21)} ${pad(st.status === "administratively down" ? "adminDown" : st.status, 12)} ${pad(st.proto === "up" ? "up" : "down", 19)} ${pad(i.mtu, 6)}`); } }
    else { L.push('IP Interface Status for VRF "default"(1)\nInterface            IP Address      Interface Status'); for (const nm of D.order) { const i = D.ifs[nm]; if (!i.ip) continue; const st = ifStatus(net, R, d, nm); L.push(`${pad(short(nm), 20)} ${pad(i.ip.addr, 15)} protocol-${st.proto}/link-${st.status === "up" ? "up" : "down"}/admin-${i.shutdown ? "down" : "up"}`); } }
    return L.join("\n");
  }
  function ifDetail(c, nm) {
    const { net, R, d, D, style } = c, i = D.ifs[nm], st = ifStatus(net, R, d, nm), up = st.status === "up";
    if (style === "nxos") return `${nm} is ${up ? "up" : st.status === "administratively down" ? "down (Administratively down)" : "down (Link not connected)"}\nadmin state is ${i.shutdown ? "down" : "up"},\n  Hardware: 1000/10000 Ethernet, address: ${mac(d + nm)}\n${i.desc ? "  Description: " + i.desc + "\n" : ""}${i.ip ? `  Internet Address is ${i.ip.addr}/${i.ip.len}\n` : ""}  MTU ${i.mtu} bytes, BW 1000000 Kbit, DLY 10 usec\n  Port mode is ${i.mode === "routed" ? "routed" : i.mode}\n  0 input packets 0 unicast packets 0 multicast packets\n  0 output packets`;
    if (style === "eos") return `${nm} is ${up ? "up" : st.status === "administratively down" ? "administratively down" : "down"}, line protocol is ${up ? "up (connected)" : "down (notconnect)"}\n  Hardware is Ethernet, address is ${mac(d + nm)}\n${i.desc ? "  Description: " + i.desc + "\n" : ""}${i.ip ? `  Internet address is ${i.ip.addr}/${i.ip.len}\n` : ""}  IP MTU ${i.mtu} bytes , BW 1000000 kbit\n  Full-duplex, 1Gb/s, auto negotiation: off`;
    return `${nm} is ${st.status}, line protocol is ${st.proto} \n  Hardware is CSR vNIC, address is ${mac(d + nm)} (bia ${mac(d + nm)})\n${i.desc ? "  Description: " + i.desc + "\n" : ""}${i.ip ? `  Internet address is ${i.ip.addr}/${i.ip.len}\n` : ""}  MTU ${i.mtu} bytes, BW 1000000 Kbit/sec, DLY 10 usec, \n     reliability 255/255, txload 1/255, rxload 1/255\n  Encapsulation ARPA, loopback not set\n  Full Duplex, 1000Mbps, link type is auto, media type is RJ45\n  5 minute input rate 0 bits/sec, 0 packets/sec`;
  }
  function protocols(c) {
    const { D, R, d } = c, L = [];
    if (D.ospf) { L.push(`Routing Protocol is "ospf ${D.ospf.pid}"`, "  Outgoing update filter list for all interfaces is not set", `  Router ID ${R.ospf[d].rid}`, "  Routing for Networks:"); for (const w of D.ospf.networks) L.push(`    ${w.ip} ${w.wild} area ${w.area}`); L.push("  Passive Interface(s):"); for (const p of D.ospf.passive || []) L.push(`    ${p}`); L.push("  Routing Information Sources:", "    Gateway         Distance      Last Update"); for (const x of R.ospf[d].nbrs) L.push(`    ${pad(x.id, 15)} 110           00:01:02`); L.push("  Distance: (default is 110)", ""); }
    if (D.bgp) { L.push(`Routing Protocol is "bgp ${D.bgp.asn}"`, `  IGP synchronization is disabled`, `  Neighbor(s):`, "    Address          FiltIn FiltOut DistIn DistOut Weight RouteMap"); for (const [ip, nb] of Object.entries(D.bgp.neighbors)) L.push(`    ${pad(ip, 16)} ${pad("", 6)} ${pad("", 7)} ${pad("", 6)} ${pad("", 7)} ${pad("", 6)} ${nb.rmIn || nb.rmOut || ""}`); }
    return L.join("\n").replace(/\n+$/, "") || "";
  }

  // ------------------------------------------------------------ the table
  function build() {
    const T = [];
    const E = (p, modes, run) => T.push({ p, modes, run });
    const showOnly = (fn) => (c, a) => fn(c, a);
    const need = (c, ok, msg) => ok;
    const cur = (c) => c.D.ifs[c.s.ctx.ifc];
    const OK = "";

    // --- exec
    E("enable", ["user"], (c) => { c.s.mode = "priv"; return OK; });
    E("disable", ["priv"], (c) => { c.s.mode = "user"; return OK; });
    E("configure|conf terminal|t", PRIV, (c) => { c.s.mode = "config"; return c.style === "eos" ? "" : "Enter configuration commands, one per line.  End with CNTL/Z."; });
    E("configure|conf", PRIV, (c) => { c.s.mode = "config"; return c.style === "eos" ? "" : "Enter configuration commands, one per line.  End with CNTL/Z."; });
    E("terminal length|width|monitor <n?>", EX, () => OK);
    E("exit", ["user", "priv"], (c) => { c.s.mode = "user"; return OK; });
    E("logout", EX, () => OK);
    E("write|wr <m?>", PRIV, (c) => (c.style === "eos" ? "Copy completed successfully." : "Building configuration...\n[OK]"));
    E("copy running-config startup-config", PRIV, (c) => (c.style === "eos" ? "Copy completed successfully." : "Destination filename [startup-config]? \nBuilding configuration...\n[OK]"));
    E("clear ip bgp <x...>", PRIV, (c) => { c.s.touch(); return OK; });
    E("clear bgp <x...>", PRIV, (c) => { c.s.touch(); return OK; });
    E("clear ip ospf <x...>", PRIV, (c) => { c.s.touch(); return OK; });
    E("clear ip route <x...>", PRIV, (c) => { c.s.touch(); return OK; });
    E("clear logging", PRIV, (c) => { c.D.logCleared = true; return OK; });
    E("ping <t>", EX, (c, a) => reachText(c.style, c.R, c.d, a.t, null, 5));
    E("ping <t> <rest...>", EX, (c, a) => { const w = a.rest.split(/\s+/); let src = null, cnt = 5; for (let k = 0; k < w.length; k++) { if (/^source(-interface)?$/.test(w[k])) src = w[++k]; else if (/^(repeat|count|-c)$/.test(w[k])) cnt = Math.min(20, +w[++k] || 5); } return reachText(c.style, c.R, c.d, a.t, src, cnt); });
    E("traceroute|tracepath <t>", EX, (c, a) => traceText(c.style, c.R, c.d, a.t));
    E("traceroute <t> <rest...>", EX, (c, a) => traceText(c.style, c.R, c.d, a.t));
    E("show clock", SHOW, () => "*10:42:17.123 UTC Sun Nov 22 2026");
    E("show version", SHOW, (c) => (c.style === "eos" ? `Arista vEOS-lab\nSoftware image version: 4.28.3M\nUptime: 2 days, 3 hours` : c.style === "nxos" ? `Cisco Nexus Operating System (NX-OS) Software\n  system:    version 9.3(8)\nHardware: Nexus9000 C9300v\n  Device name: ${c.D.hostname}` : `Cisco IOS XE Software, Version 17.09.04a\nCisco IOS Software [Cupertino], Virtual XE Software\n${c.D.hostname} uptime is 2 days, 3 hours, 11 minutes`));
    E("show running-config|run|startup-config <x...>", SHOW, (c, a) => { const full = runConfig(c.net, c.d, c.style).split("\n"); const q = a.x; if (/^interface/i.test(q)) { const nm = resolveIf(c.D, q.replace(/^interface\s*/i, "")); if (!nm) return "% Invalid input"; const out = [], start = full.indexOf("interface " + nm); if (start < 0) return ""; for (let k = start; k < full.length && (k === start || full[k] !== "!"); k++) out.push(full[k]); return "Building configuration...\n\nCurrent configuration : 128 bytes\n!\n" + out.join("\n") + "\nend"; } if (/^\|/.test(q)) { const m = q.match(/^\|\s*(?:include|i|section|sec|begin|b)\s+(.*)$/i); const pat = m ? m[1].toLowerCase() : ""; return full.filter((l) => l.toLowerCase().indexOf(pat) >= 0).join("\n"); } if (/^(section|sec|include)/i.test(q)) return full.filter((l) => l.toLowerCase().indexOf(q.split(/\s+/)[1].toLowerCase()) >= 0).join("\n"); return full.join("\n"); });
    E("show running-config|run|startup-config", SHOW, (c) => runConfig(c.net, c.d, c.style));
    E("show ip interface brief", SHOW, ifBrief);
    E("show ip interface <i?>", SHOW, (c, a) => { const nm = resolveIf(c.D, a.i); return nm ? ifDetail(c, nm) : ifBrief(c); });
    E("show interfaces|interface status", SHOW, (c) => { const L = [c.style === "ios" ? "Port         Name               Status       Vlan       Duplex  Speed Type" : "Port       Name               Status       Vlan       Duplex Speed Type"]; for (const nm of c.D.order) { const i = c.D.ifs[nm]; if (i.loopback || i.svi || i.sub) continue; const up = c.R.line[c.d][nm]; L.push(`${pad(short(nm), 12)} ${pad(i.desc.slice(0, 18), 18)} ${pad(i.shutdown ? "disabled" : up ? "connected" : "notconnect", 12)} ${pad(i.mode === "trunk" ? "trunk" : i.mode === "access" ? i.accessVlan : "routed", 10)} a-full  a-1000 1000BaseT`); } return L.join("\n"); });
    E("show interfaces|interface trunk", SHOW, trunkTable);
    E("show interfaces|interface description", SHOW, (c) => { const L = ["Interface                      Status         Protocol Description"]; for (const nm of c.D.order) { const st = ifStatus(c.net, c.R, c.d, nm); L.push(`${pad(short(nm), 30)} ${pad(st.status === "administratively down" ? "admin down" : st.status, 14)} ${pad(st.proto, 8)} ${c.D.ifs[nm].desc}`); } return L.join("\n"); });
    E("show interfaces|interface <i>", SHOW, (c, a) => { const nm = resolveIf(c.D, a.i); return nm ? ifDetail(c, nm) : "% Invalid input detected at '^' marker."; });
    E("show interfaces|interface", SHOW, (c) => c.D.order.map((nm) => ifDetail(c, nm)).join("\n"));
    E("show ip route", SHOW, (c) => showRouteIos(c.R, c.d, c.style));
    E("show ip route <x>", SHOW, (c, a) => { const x = a.x.toLowerCase(); const map = { ospf: ["O", "E2"], bgp: ["B"], static: ["S"], connected: ["C"] }; const key = Object.keys(map).find((k) => k.startsWith(x)); if (key) return showRouteIos(c.R, c.d, c.style, (r) => map[key].indexOf(r.proto) >= 0); if (!isIp(a.x.split("/")[0])) return "% Invalid input detected at '^' marker."; const r = c.R.lookup(c.d, ip2n(a.x.split("/")[0])); if (!r || r.proto === "L") return `% Network not in table`; const L = [`Routing entry for ${n2ip(r.pfx)}/${r.len}`, `  Known via "${({ C: "connected", S: "static", O: "ospf " + (c.D.ospf ? c.D.ospf.pid : 1), E2: "ospf " + (c.D.ospf ? c.D.ospf.pid : 1), B: "bgp " + (c.D.bgp ? c.D.bgp.asn : "") })[r.proto]}", distance ${r.ad}, metric ${r.metric}`]; if (r.nh) L.push("  Routing Descriptor Blocks:", `  * ${n2ip(r.nh)}, from ${n2ip(r.nh)}, 00:05:12 ago, via ${r.ifc}`); else L.push("  Routing Descriptor Blocks:", `  * directly connected, via ${r.ifc}`); return L.join("\n"); });
    E("show ip route <x> <y>", SHOW, (c, a) => showRouteIos(c.R, c.d, c.style));
    E("show ip ospf neighbor|neighbors|nei", SHOW, ospfNbrs);
    E("show ip ospf neighbor|neighbors|nei <x...>", SHOW, ospfNbrs);
    E("show ip ospf interface|interfaces brief", SHOW, (c) => ospfIfaces(Object.assign({}, c, { brief: true })));
    E("show ip ospf interface|interfaces <i>", SHOW, (c, a) => { const nm = resolveIf(c.D, a.i); return nm ? ospfIfaces(c, nm) : "% Invalid interface"; });
    E("show ip ospf interface|interfaces", SHOW, (c) => ospfIfaces(c));
    E("show ip ospf", SHOW, (c) => (c.D.ospf ? ` Routing Process "ospf ${c.D.ospf.pid}" with ID ${c.R.ospf[c.d].rid}\n Supports only single TOS(TOS0) routes\n Number of areas in this router is ${new Set(Object.values(c.R.ospf[c.d].ifs).map((o) => o.area)).size}` : "% OSPF: Router process not configured"));
    E("show ip ospf database", SHOW, (c) => `            OSPF Router with ID (${c.R.ospf[c.d].rid}) (Process ID ${c.D.ospf ? c.D.ospf.pid : 1})\n\n                Router Link States (Area 0)\n\nLink ID         ADV Router      Age         Seq#       Checksum Link count\n${[c.R.ospf[c.d].rid].concat(c.R.ospf[c.d].nbrs.map((n) => n.id)).filter((v, k, arr) => arr.indexOf(v) === k).map((id) => `${pad(id, 15)} ${pad(id, 15)} ${pad(100 + (hash(id) % 400), 11)} 0x80000003 0x00${(hash(id) % 9000 + 1000).toString(16)} 2`).join("\n")}`);
    E("show ip protocols", SHOW, protocols);
    E("show bgp ipv4 unicast summary|sum", SHOW, bgpSummary);
    E("show bgp summary|sum", SHOW, bgpSummary);
    E("show ip bgp summary|sum", SHOW, bgpSummary);
    E("show bgp ipv4 unicast <x?>", SHOW, (c, a) => bgpTable(c, a.x));
    E("show ip bgp neighbors|neighbor <ip>", SHOW, (c, a) => bgpNeighbor(c, a.ip));
    E("show ip bgp neighbors|neighbor <ip> advertised-routes|received-routes|routes", SHOW, (c, a) => { const s = c.R.bgp[c.d][a.ip]; if (!s) return "% No such neighbor"; if (s.state !== "Established") return "% Neighbor is not established"; const L = []; const T = c.R.bgpTable[c.d]; const recv = /rout/.test(c.line.split(/\s+/).pop()) && !/advert/.test(c.line); return /advert/i.test(c.line) ? bgpTable(Object.assign({}, c), null).split("\n").filter((l, k) => k < 6 || /^\*>/.test(l) && !/\s i\s/.test(l.slice(0, 5)) || true).join("\n") : bgpTable(c); });
    E("show ip bgp <x?>", SHOW, (c, a) => (a.x && !isIp(a.x.split("/")[0]) ? "% Invalid input detected at '^' marker." : bgpTable(c, a.x)));
    E("show ip bgp <x> <y>", SHOW, (c) => bgpTable(c));
    E("show vlan brief|id <x?>", SHOW, vlanBrief);
    E("show vlan", SHOW, vlanBrief);
    E("show spanning-tree <x?>", SHOW, (c) => `VLAN0001\n  Spanning tree enabled protocol rstp\n  Root ID    Priority    32769\n             Address     ${mac(c.d)}\n             This bridge is the root`);
    E("show mac address-table <x?>", SHOW, (c) => "Vlan    Mac Address       Type        Ports\n----    -----------       --------    -----");
    E("show ip arp|arp <x?>", SHOW, arpTable);
    E("show arp", SHOW, arpTable);
    E("show cdp neighbors|neighbor <x?>", SHOW, neighTable);
    E("show lldp neighbors|neighbor <x?>", SHOW, neighTable);
    E("show logging|log <x?>", SHOW, (c) => { if (c.D.logCleared) return "Syslog logging: enabled"; const L = logLines(c.net, c.R, c.d, c.style); return "Syslog logging: enabled (0 messages dropped)\n    Console logging: level debugging\n\nLog Buffer (8192 bytes):\n\n" + L.join("\n"); });
    E("show ip access-lists|access-lists <x?>", SHOW, (c, a) => { const L = []; for (const [nm, ac] of Object.entries(c.D.acls)) { if (a.x && a.x !== nm) continue; L.push(`Extended IP access list ${nm}`); ac.forEach((e, k) => L.push(`    ${(k + 1) * 10} ${e.action} ${e.proto} ${e.src === "any" ? "any" : e.src.host ? "host " + e.src.host : e.src.ip + " " + n2ip((~lenMask(e.src.len)) >>> 0)} ${e.dst === "any" ? "any" : e.dst.host ? "host " + e.dst.host : e.dst.ip + " " + n2ip((~lenMask(e.dst.len)) >>> 0)}${e.port ? " eq " + e.port : ""} (${hash(nm + k) % 40} matches)`)); } return L.join("\n"); });
    E("show access-lists <x?>", SHOW, (c) => "");
    E("show ip prefix-list <x?>", SHOW, (c, a) => { const L = []; for (const [nm, list] of Object.entries(c.D.prefixLists)) { if (a.x && a.x !== nm) continue; L.push(`ip prefix-list ${nm}: ${list.length} entries`); for (const e of list.slice().sort((x, y) => x.seq - y.seq)) L.push(`   seq ${e.seq} ${e.action} ${e.pfx}/${e.len}${e.ge ? " ge " + e.ge : ""}${e.le ? " le " + e.le : ""}`); } return L.join("\n"); });
    E("show route-map <x?>", SHOW, (c, a) => { const L = []; for (const [nm, cl] of Object.entries(c.D.routeMaps)) { if (a.x && a.x !== nm) continue; for (const x of cl) { L.push(`route-map ${nm}, ${x.action}, sequence ${x.seq}`, "  Match clauses:"); if (x.match && x.match.prefixList) L.push(`    ip address prefix-lists: ${x.match.prefixList}`); L.push("  Set clauses:"); if (x.set && x.set.lp !== undefined) L.push(`    local-preference ${x.set.lp}`); if (x.set && x.set.med !== undefined) L.push(`    metric ${x.set.med}`); if (x.set && x.set.prepend) L.push(`    as-path prepend ${x.set.prepend.join(" ")}`); } } return L.join("\n"); });
    E("show feature", SHOW, (c) => `Feature Name          Instance  State\n${["ospf", "bgp", "interface-vlan"].map((f) => pad(f, 21) + pad(1, 10) + (c.D.features && c.D.features[f] ? "enabled" : "disabled")).join("\n")}`);

    // --- config: global
    E("hostname <h>", CFG, (c, a) => { c.D.hostname = a.h; return OK; });
    E("feature <f>", CFG, (c, a) => { if (c.style !== "nxos") return "% Invalid input detected at '^' marker."; c.D.features = c.D.features || {}; c.D.features[a.f] = true; c.s.touch(); return OK; });
    E("no feature <f>", CFG, (c, a) => { if (c.style !== "nxos") return "% Invalid input detected at '^' marker."; (c.D.features = c.D.features || {})[a.f] = false; c.s.touch(); return OK; });
    E("interface|int <i>", CFG.concat(IF, OSPF, BGP, ["rmap", "acl", "vlan"]), (c, a) => {
      let nm = resolveIf(c.D, a.i);
      if (!nm) { const lo = a.i.match(/^(?:loopback|lo)(\d+)$/i), vl = a.i.match(/^(?:vlan|vl)(\d+)$/i), sub = a.i.match(/^(.+)\.(\d+)$/);
        if (lo) { nm = (c.style === "nxos" ? "loopback" : "Loopback") + lo[1]; N.addIf(c.D, nm, { loopback: true, mode: "routed" }); }
        else if (vl) { if (c.style === "nxos" && !(c.D.features && c.D.features["interface-vlan"])) return "% Invalid command at '^' marker."; nm = "Vlan" + vl[1]; N.addIf(c.D, nm, { svi: +vl[1], mode: "routed", shutdown: false }); }
        else if (sub && resolveIf(c.D, sub[1])) { const par = resolveIf(c.D, sub[1]); nm = par + "." + sub[2]; N.addIf(c.D, nm, { parent: par, mode: "routed" }); }
        else return caretErr(c.style, c.prompt, c.line, [], 1);
      }
      c.s.mode = "if"; c.s.ctx = { ifc: nm }; c.s.touch(); return OK; });
    E("vlan <ids>", CFG.concat(["vlan"]), (c, a) => { const ids = vlanList(a.ids); if (!ids) return "% Invalid input detected at '^' marker."; for (const v of ids) if (c.D.vlans[v] === undefined) c.D.vlans[v] = "VLAN" + String(v).padStart(4, "0"); c.s.mode = "vlan"; c.s.ctx = { vlan: ids[0] }; c.s.touch(); return OK; });
    E("no vlan <ids>", CFG, (c, a) => { const ids = vlanList(a.ids); if (!ids) return "% Invalid input detected at '^' marker."; for (const v of ids) if (v !== 1) delete c.D.vlans[v]; c.s.touch(); return OK; });
    E("name <n...>", ["vlan"], (c, a) => { c.D.vlans[c.s.ctx.vlan] = a.n; return OK; });
    E("ip route <a> <b> <c?> <d?>", CFG, (c, a) => { let net = parseNet(a.a, a.b), rest = net && net.used === 2 ? [a.c, a.d] : [a.b, a.c]; if (!net) return "% Invalid input detected at '^' marker."; const nh = rest[0]; if (!isIp(nh)) return "% Invalid input detected at '^' marker."; const ad = rest[1] ? +rest[1] : 1; c.D.statics = c.D.statics.filter((s) => !(s.pfx === n2ip(netOf(net.ip, net.len)) && s.len === net.len && s.nh === nh)); c.D.statics.push({ pfx: n2ip(netOf(net.ip, net.len)), len: net.len, nh, ad }); c.s.touch(); return OK; });
    E("no ip route <a> <b> <c?> <d?>", CFG, (c, a) => { const net = parseNet(a.a, a.b); if (!net) return "% Invalid input detected at '^' marker."; const before = c.D.statics.length; c.D.statics = c.D.statics.filter((s) => !(s.pfx === n2ip(netOf(net.ip, net.len)) && s.len === net.len && (net.used === 2 ? s.nh === a.c : s.nh === a.b || !a.b))); if (c.D.statics.length === before) return "%No matching route to delete"; c.s.touch(); return OK; });
    E("ip prefix-list <name> seq <seq> <action> <pfx> <o1?> <o2?> <o3?> <o4?>", CFG, (c, a) => addPrefix(c, a.name, +a.seq, a.action, a.pfx, [a.o1, a.o2, a.o3, a.o4]));
    E("ip prefix-list <name> <action> <pfx> <o1?> <o2?> <o3?> <o4?>", CFG, (c, a) => { const list = c.D.prefixLists[a.name] || []; return addPrefix(c, a.name, (list.length ? Math.max(...list.map((e) => e.seq)) : 0) + 5, a.action, a.pfx, [a.o1, a.o2, a.o3, a.o4]); });
    E("no ip prefix-list <name> <x...>", CFG, (c, a) => { delete c.D.prefixLists[a.name]; c.s.touch(); return OK; });
    E("no ip prefix-list <name>", CFG, (c, a) => { delete c.D.prefixLists[a.name]; c.s.touch(); return OK; });
    E("route-map <name> <action?> <seq?>", CFG.concat(["rmap"]), (c, a) => { const action = a.action || "permit", seq = a.seq ? +a.seq : 10; if (action !== "permit" && action !== "deny") return "% Invalid input detected at '^' marker."; const list = (c.D.routeMaps[a.name] = c.D.routeMaps[a.name] || []); let cl = list.find((x) => x.seq === seq); if (!cl) { cl = { seq, action, match: {}, set: {} }; list.push(cl); } c.s.mode = "rmap"; c.s.ctx = { rm: a.name, seq }; c.s.touch(); return OK; });
    E("no route-map <name> <x...>", CFG, (c, a) => { delete c.D.routeMaps[a.name]; c.s.touch(); return OK; });
    E("no route-map <name>", CFG, (c, a) => { delete c.D.routeMaps[a.name]; c.s.touch(); return OK; });
    const clause = (c) => c.D.routeMaps[c.s.ctx.rm].find((x) => x.seq === c.s.ctx.seq);
    E("match ip address prefix-list <n>", ["rmap"], (c, a) => { clause(c).match.prefixList = a.n; c.s.touch(); return OK; });
    E("match ip next-hop prefix-list <n>", ["rmap"], () => OK);
    E("set local-preference <n>", ["rmap"], (c, a) => { clause(c).set.lp = +a.n; c.s.touch(); return OK; });
    E("set metric <n>", ["rmap"], (c, a) => { clause(c).set.med = +a.n; c.s.touch(); return OK; });
    E("set as-path prepend <x...>", ["rmap"], (c, a) => { clause(c).set.prepend = a.x.split(/\s+/).map(Number); c.s.touch(); return OK; });
    E("ip access-list extended <name>", CFG.concat(["acl"]), (c, a) => { c.D.acls[a.name] = c.D.acls[a.name] || []; c.s.mode = "acl"; c.s.ctx = { acl: a.name }; c.s.touch(); return OK; });
    E("ip access-list <name>", CFG.concat(["acl"]), (c, a) => { c.D.acls[a.name] = c.D.acls[a.name] || []; c.s.mode = "acl"; c.s.ctx = { acl: a.name }; c.s.touch(); return OK; });
    E("permit|deny <proto> <x...>", ["acl"], (c, a, line) => addAcl(c, c.s.ctx.acl, line.split(/\s+/)));
    E("<seq> permit|deny <proto> <x...>", ["acl"], (c, a, line) => addAcl(c, c.s.ctx.acl, line.split(/\s+/).slice(1)));
    E("no ip access-list extended <name>", CFG, (c, a) => { delete c.D.acls[a.name]; c.s.touch(); return OK; });
    E("access-list <num> permit|deny <proto> <x...>", CFG, (c, a, line) => { c.D.acls[a.num] = c.D.acls[a.num] || []; return addAcl(c, a.num, line.split(/\s+/).slice(2)); });

    // --- interface
    E("shutdown", IF, (c) => { cur(c).shutdown = true; c.s.touch(); return OK; });
    E("no shutdown", IF, (c) => { cur(c).shutdown = false; c.s.touch(); return OK; });
    E("description <t...>", IF, (c, a) => { cur(c).desc = a.t; return OK; });
    E("no description", IF, (c) => { cur(c).desc = ""; return OK; });
    E("mtu|ip mtu <n>", IF, (c, a) => { const n = +a.n; if (!(n >= 68 && n <= 9216)) return "% Invalid input detected at '^' marker."; cur(c).mtu = n; c.s.touch(); return OK; });
    E("ip mtu <n>", IF, (c, a) => { cur(c).mtu = +a.n; c.s.touch(); return OK; });
    E("speed|duplex|negotiation|cdp|lldp|logging|load-interval|bandwidth|no cdp|keepalive <x...>", IF, () => OK);
    E("ip address <a> <m?>", IF, (c, a) => {
      const i = cur(c), net = parseNet(a.a, a.m); if (!net || isNaN(ip2n(net.ip))) return "% Invalid input detected at '^' marker.";
      if (N.isSwitchport(i)) return "% Invalid input detected at '^' marker.";
      if (i.parent && !i.sub) return "% Configuring IP routing on a LAN subinterface is only allowed if that subinterface is already configured as part of an IEEE 802.10, IEEE 802.1Q, or ISL vLAN.";
      if (net.len === 32 && !i.loopback) { /* allowed on routed ports */ }
      for (const nm of c.D.order) { const o = c.D.ifs[nm]; if (nm !== i.name && o.ip && !o.shutdown && (inNet(net.ip, o.ip.addr, Math.min(o.ip.len, net.len)) && Math.min(o.ip.len, net.len) > 0) && !(o.ip.len === 32 && net.len === 32 && o.ip.addr !== net.ip)) return `% ${n2ip(netOf(net.ip, net.len))} overlaps with ${nm}`; }
      i.ip = { addr: net.ip, len: net.len }; c.s.touch(); return OK; });
    E("no ip address <x?>", IF, (c) => { cur(c).ip = null; c.s.touch(); return OK; });
    E("ip ospf hello-interval <n>", IF, (c, a) => { cur(c).ospf.hello = +a.n; c.s.touch(); return OK; });
    E("ip ospf dead-interval <n>", IF, (c, a) => { cur(c).ospf.dead = +a.n; c.s.touch(); return OK; });
    E("ip ospf cost <n>", IF, (c, a) => { cur(c).ospf.cost = +a.n; c.s.touch(); return OK; });
    E("ip ospf priority <n>", IF, () => OK);
    E("ip ospf network <t> <x?>", IF, (c, a) => { cur(c).ospf.type = /point/i.test(a.t) ? "p2p" : "broadcast"; c.s.touch(); return OK; });
    E("ip ospf mtu-ignore", IF, (c) => { cur(c).ospf.mtuIgnore = true; c.s.touch(); return OK; });
    E("no ip ospf hello-interval <n?>", IF, (c) => { cur(c).ospf.hello = 10; c.s.touch(); return OK; });
    E("no ip ospf dead-interval <n?>", IF, (c) => { cur(c).ospf.dead = 40; c.s.touch(); return OK; });
    E("no ip ospf cost <n?>", IF, (c) => { cur(c).ospf.cost = null; c.s.touch(); return OK; });
    E("no ip ospf network <x...>", IF, (c) => { cur(c).ospf.type = "broadcast"; c.s.touch(); return OK; });
    E("no mtu <n?>", IF, (c) => { cur(c).mtu = 1500; c.s.touch(); return OK; });
    E("no ip ospf mtu-ignore", IF, (c) => { cur(c).ospf.mtuIgnore = false; c.s.touch(); return OK; });
    E("ip ospf authentication-key <k>", IF, (c, a) => { cur(c).ospf.auth = a.k; c.s.touch(); return OK; });
    E("ip ospf message-digest-key <id> md5 <k>", IF, (c, a) => { cur(c).ospf.auth = "md5:" + a.k; c.s.touch(); return OK; });
    E("no ip ospf authentication-key|message-digest-key <x...>", IF, (c) => { cur(c).ospf.auth = null; c.s.touch(); return OK; });
    E("ip ospf authentication <x...>", IF, () => OK);
    E("ip ospf <pid> area <a>", IF, (c, a) => { if (!c.D.ospf) c.D.ospf = { pid: +a.pid, rid: null, networks: [], passive: [], redist: {} }; cur(c).ospf.area = a.a; c.s.touch(); return OK; });
    E("ip router ospf <pid> area <a>", IF, (c, a) => { if (c.style !== "nxos") return "% Invalid input detected at '^' marker."; if (!c.D.ospf) return "% Invalid command at '^' marker."; cur(c).ospf.area = a.a; c.s.touch(); return OK; });
    E("no ip ospf <pid> area <a?>", IF, (c) => { cur(c).ospf.area = null; c.s.touch(); return OK; });
    E("no ip router ospf <x...>", IF, (c) => { cur(c).ospf.area = null; c.s.touch(); return OK; });
    E("switchport", IF, (c) => { const i = cur(c); if (i.loopback || i.svi) return "% Invalid input detected at '^' marker."; i.mode = "access"; c.s.touch(); return OK; });
    E("no switchport", IF, (c) => { cur(c).mode = "routed"; c.s.touch(); return OK; });
    E("switchport mode <m>", IF, (c, a) => { const i = cur(c); if (i.mode === "routed" && c.D.role !== "switch" && c.style === "ios") return "% Invalid input detected at '^' marker."; if (/^acc/.test(a.m)) i.mode = "access"; else if (/^tru/.test(a.m)) i.mode = "trunk"; else return "% Invalid input detected at '^' marker."; c.s.touch(); return OK; });
    E("switchport trunk encapsulation <x>", IF, () => OK);
    E("switchport nonegotiate|host", IF, () => OK);
    E("switchport access vlan <v>", IF, (c, a) => { const v = +a.v; if (!(v >= 1 && v <= 4094)) return "% Invalid input detected at '^' marker."; const i = cur(c); i.accessVlan = v; if (i.mode !== "trunk") i.mode = "access"; c.s.touch(); return c.D.vlans[v] === undefined && c.style === "ios" ? `% Access VLAN does not exist. Creating vlan ${v}` : OK; });
    E("switchport trunk native vlan <v>", IF, (c, a) => { cur(c).native = +a.v; c.s.touch(); return OK; });
    E("switchport trunk allowed vlan add <l>", IF, (c, a) => { const l = vlanList(a.l); if (!l) return "% Invalid input detected at '^' marker."; const i = cur(c); if (i.allowed !== null) i.allowed = Array.from(new Set(i.allowed.concat(l))).sort((x, y) => x - y); c.s.touch(); return OK; });
    E("switchport trunk allowed vlan remove <l>", IF, (c, a) => { const l = vlanList(a.l); if (!l) return "% Invalid input detected at '^' marker."; const i = cur(c); const all = i.allowed === null ? Object.keys(c.D.vlans).map(Number) : i.allowed; i.allowed = all.filter((v) => l.indexOf(v) < 0); c.s.touch(); return OK; });
    E("switchport trunk allowed vlan all|none <x?>", IF, (c, a) => { cur(c).allowed = /^all/.test(c.line.trim().split(/\s+/)[4]) ? null : []; c.s.touch(); return OK; });
    E("switchport trunk allowed vlan <l>", IF, (c, a) => { const l = vlanList(a.l); if (!l) return "% Invalid input detected at '^' marker."; cur(c).allowed = l; c.s.touch(); return OK; });
    E("encapsulation dot1q|dot1Q <v>", IF, (c, a) => { const i = cur(c); if (!i.parent) return "% Invalid input detected at '^' marker."; i.sub = +a.v; c.s.touch(); return OK; });
    E("ip access-group <n> <dir>", IF, (c, a) => { if (!/^(in|out)/.test(a.dir)) return "% Invalid input detected at '^' marker."; cur(c).acl[/^in/.test(a.dir) ? "in" : "out"] = a.n; c.s.touch(); return OK; });
    E("no ip access-group <n> <dir>", IF, (c, a) => { cur(c).acl[/^in/.test(a.dir) ? "in" : "out"] = null; c.s.touch(); return OK; });
    E("no ip access-group <n>", IF, (c) => { cur(c).acl = { in: null, out: null }; c.s.touch(); return OK; });

    // --- ospf
    E("router ospf <pid> <x?>", CFG.concat(["ospf", "bgp", "af", "if"]), (c, a) => { if (c.style === "nxos" && !(c.D.features && c.D.features.ospf)) return "% Invalid command at '^' marker."; if (!c.D.ospf) c.D.ospf = { pid: +a.pid, rid: null, networks: [], passive: [], redist: {} }; else if (c.D.ospf.pid !== +a.pid) return `% OSPF: Router process ${a.pid} could not be created (process ${c.D.ospf.pid} exists in this simulator)`; c.s.mode = "ospf"; c.s.touch(); return OK; });
    E("no router ospf <pid>", CFG, (c) => { c.D.ospf = null; for (const i of Object.values(c.D.ifs)) i.ospf.area = null; c.s.touch(); return OK; });
    E("router-id <r>", OSPF.concat(BGP), (c, a) => { if (!isIp(a.r)) return "% Invalid input detected at '^' marker."; if (c.s.mode === "ospf") c.D.ospf.rid = a.r; else c.D.bgp.rid = a.r; c.s.touch(); return OK; });
    E("no router-id <x?>", OSPF, (c) => { c.D.ospf.rid = null; c.s.touch(); return OK; });
    E("network <n> <w> area <ar>", OSPF, (c, a) => { if (!isIp(a.n) || wildLen(a.w) === null) return "% Invalid input detected at '^' marker."; c.D.ospf.networks.push({ ip: a.n, wild: a.w, area: a.ar }); c.s.touch(); return OK; });
    E("network <n> area <ar>", OSPF, (c, a) => { const x = N.cidr(a.n); if (!x) return "% Invalid input detected at '^' marker."; c.D.ospf.networks.push({ ip: x.ip, wild: n2ip((~lenMask(x.len)) >>> 0), area: a.ar }); c.s.touch(); return OK; });
    E("no network <n> <w> area <ar>", OSPF, (c, a) => { c.D.ospf.networks = c.D.ospf.networks.filter((x) => !(x.ip === a.n && x.wild === a.w)); c.s.touch(); return OK; });
    E("no network <n> area <ar>", OSPF, (c, a) => { const x = N.cidr(a.n); c.D.ospf.networks = c.D.ospf.networks.filter((q) => !(x && q.ip === x.ip)); c.s.touch(); return OK; });
    E("passive-interface <i>", OSPF, (c, a) => { if (a.i === "default") { c.D.ospf.defaultPassive = true; c.s.touch(); return OK; } const nm = resolveIf(c.D, a.i); if (!nm) return "% Invalid input detected at '^' marker."; if (c.D.ospf.defaultPassive) c.D.ospf.nonPassive = (c.D.ospf.nonPassive || []).filter((x) => x !== nm); else if (c.D.ospf.passive.indexOf(nm) < 0) c.D.ospf.passive.push(nm); c.s.touch(); return OK; });
    E("no passive-interface <i>", OSPF, (c, a) => { if (a.i === "default") { c.D.ospf.defaultPassive = false; c.s.touch(); return OK; } const nm = resolveIf(c.D, a.i); if (!nm) return "% Invalid input detected at '^' marker."; if (c.D.ospf.defaultPassive) { c.D.ospf.nonPassive = (c.D.ospf.nonPassive || []).concat([nm]); } else c.D.ospf.passive = c.D.ospf.passive.filter((x) => x !== nm); c.s.touch(); return OK; });
    E("redistribute <p> <o1?> <o2?> <o3?>", OSPF, (c, a) => { const p = a.p.toLowerCase(); if (!/^(static|connected|bgp)/.test(p)) return "% Invalid input detected at '^' marker."; c.D.ospf.redist[/^st/.test(p) ? "static" : /^con/.test(p) ? "connected" : "bgp"] = true; c.s.touch(); return OK; });
    E("no redistribute <p> <o1?> <o2?> <o3?>", OSPF, (c, a) => { const p = a.p.toLowerCase(); c.D.ospf.redist[/^st/.test(p) ? "static" : /^con/.test(p) ? "connected" : "bgp"] = false; c.s.touch(); return OK; });
    E("log-adjacency-changes|auto-cost|area|maximum-paths|default-information|timers|bfd|nsf|graceful-restart|max-metric|distance <x...>", OSPF.concat(BGP), () => OK);
    E("log-adjacency-changes|bgp|no bgp|maximum-paths|timers|bestpath|graceful-restart <x...>", BGP, () => OK);

    // --- bgp
    E("router bgp <asn>", CFG.concat(["ospf", "bgp", "af", "if"]), (c, a) => { if (c.style === "nxos" && !(c.D.features && c.D.features.bgp)) return "% Invalid command at '^' marker."; if (!c.D.bgp) c.D.bgp = { asn: +a.asn, rid: null, neighbors: {}, networks: [], redist: {} }; else if (c.D.bgp.asn !== +a.asn) return `% BGP is already running; AS is ${c.D.bgp.asn}`; c.s.mode = "bgp"; c.s.touch(); return OK; });
    E("no router bgp <asn>", CFG, (c) => { c.D.bgp = null; c.s.touch(); return OK; });
    E("bgp router-id <r>", BGP, (c, a) => { c.D.bgp.rid = a.r; c.s.touch(); return OK; });
    E("neighbor <ip> remote-as <as>", BGP, (c, a) => { if (!isIp(a.ip)) return "% Invalid input detected at '^' marker."; const n = c.D.bgp.neighbors[a.ip] || (c.D.bgp.neighbors[a.ip] = {}); n.remoteAs = +a.as; c.s.touch(); return OK; });
    const nb = (c, ip) => c.D.bgp.neighbors[ip];
    const nbErr = "% Specify remote-as or peer-group commands first";
    E("neighbor <ip> update-source <i>", BGP, (c, a) => { const n = nb(c, a.ip); if (!n) return nbErr; const nm = resolveIf(c.D, a.i); if (!nm) return "% Invalid input detected at '^' marker."; n.updateSource = nm; c.s.touch(); return OK; });
    E("no neighbor <ip> update-source <x?>", BGP, (c, a) => { const n = nb(c, a.ip); if (n) delete n.updateSource; c.s.touch(); return OK; });
    E("neighbor <ip> ebgp-multihop <n?>", BGP, (c, a) => { const n = nb(c, a.ip); if (!n) return nbErr; n.multihop = a.n ? +a.n : 255; c.s.touch(); return OK; });
    E("no neighbor <ip> ebgp-multihop <n?>", BGP, (c, a) => { const n = nb(c, a.ip); if (n) delete n.multihop; c.s.touch(); return OK; });
    E("neighbor <ip> password <p...>", BGP, (c, a) => { const n = nb(c, a.ip); if (!n) return nbErr; n.password = a.p.replace(/^\d\s+/, ""); c.s.touch(); return OK; });
    E("no neighbor <ip> password <x?>", BGP, (c, a) => { const n = nb(c, a.ip); if (n) delete n.password; c.s.touch(); return OK; });
    E("neighbor <ip> next-hop-self <x?>", BGP, (c, a) => { const n = nb(c, a.ip); if (!n) return nbErr; n.nhs = true; c.s.touch(); return OK; });
    E("no neighbor <ip> next-hop-self <x?>", BGP, (c, a) => { const n = nb(c, a.ip); if (n) n.nhs = false; c.s.touch(); return OK; });
    E("neighbor <ip> route-reflector-client", BGP, (c, a) => { const n = nb(c, a.ip); if (!n) return nbErr; n.rrClient = true; c.s.touch(); return OK; });
    E("neighbor <ip> route-map <m> <dir>", BGP, (c, a) => { const n = nb(c, a.ip); if (!n) return nbErr; if (!/^(in|out)/.test(a.dir)) return "% Invalid input detected at '^' marker."; n[/^in/.test(a.dir) ? "rmIn" : "rmOut"] = a.m; c.s.touch(); return OK; });
    E("no neighbor <ip> route-map <m> <dir>", BGP, (c, a) => { const n = nb(c, a.ip); if (n) delete n[/^in/.test(a.dir) ? "rmIn" : "rmOut"]; c.s.touch(); return OK; });
    E("neighbor <ip> prefix-list <m> <dir>", BGP, (c, a) => { const n = nb(c, a.ip); if (!n) return nbErr; n[/^in/.test(a.dir) ? "prefixIn" : "prefixOut"] = a.m; c.s.touch(); return OK; });
    E("no neighbor <ip> prefix-list <m> <dir>", BGP, (c, a) => { const n = nb(c, a.ip); if (n) delete n[/^in/.test(a.dir) ? "prefixIn" : "prefixOut"]; c.s.touch(); return OK; });
    E("neighbor <ip> shutdown", BGP, (c, a) => { const n = nb(c, a.ip); if (!n) return nbErr; n.shutdown = true; c.s.touch(); return OK; });
    E("no neighbor <ip> shutdown", BGP, (c, a) => { const n = nb(c, a.ip); if (n) n.shutdown = false; c.s.touch(); return OK; });
    E("neighbor <ip> description <d...>", BGP, (c, a) => { const n = nb(c, a.ip); if (!n) return nbErr; n.desc = a.d; return OK; });
    E("neighbor <ip> activate|send-community|soft-reconfiguration|timers|maximum-prefix|default-originate <x...>", BGP, (c, a) => (nb(c, a.ip) ? OK : nbErr));
    E("neighbor <ip> activate", BGP, (c, a) => (nb(c, a.ip) ? OK : nbErr));
    E("no neighbor <ip>", BGP, (c, a) => { delete c.D.bgp.neighbors[a.ip]; c.s.touch(); return OK; });
    E("address-family ipv4 <x?>", BGP, (c) => { c.s.mode = "af"; return OK; });
    E("exit-address-family", ["af"], (c) => { c.s.mode = "bgp"; return OK; });
    E("network <n> mask <m>", BGP, (c, a) => { const x = parseNet(a.n, a.m); if (!x) return "% Invalid input detected at '^' marker."; c.D.bgp.networks.push({ ip: n2ip(netOf(x.ip, x.len)), len: x.len }); c.s.touch(); return OK; });
    E("network <n>", BGP, (c, a) => { const x = N.cidr(a.n) || (isIp(a.n) ? { ip: a.n, len: ((a.n.split(".")[0] | 0) < 128 ? 8 : (a.n.split(".")[0] | 0) < 192 ? 16 : 24) } : null); if (!x) return "% Invalid input detected at '^' marker."; c.D.bgp.networks.push({ ip: n2ip(netOf(x.ip, x.len)), len: x.len }); c.s.touch(); return OK; });
    E("no network <n> <x...>", BGP, (c, a) => { const x = N.cidr(a.n) || { ip: a.n }; c.D.bgp.networks = c.D.bgp.networks.filter((q) => q.ip !== x.ip); c.s.touch(); return OK; });
    E("no network <n>", BGP, (c, a) => { const x = N.cidr(a.n) || { ip: a.n }; c.D.bgp.networks = c.D.bgp.networks.filter((q) => q.ip !== x.ip); c.s.touch(); return OK; });
    E("redistribute <p> <o1?> <o2?>", BGP, (c, a) => { const p = a.p.toLowerCase(); const k = /^con/.test(p) ? "connected" : /^st/.test(p) ? "static" : /^ospf/.test(p) ? "ospf" : null; if (!k) return "% Invalid input detected at '^' marker."; c.D.bgp.redist = c.D.bgp.redist || {}; c.D.bgp.redist[k] = true; c.s.touch(); return OK; });
    E("no redistribute <p> <o1?> <o2?>", BGP, (c, a) => { const p = a.p.toLowerCase(); const k = /^con/.test(p) ? "connected" : /^st/.test(p) ? "static" : "ospf"; if (c.D.bgp.redist) c.D.bgp.redist[k] = false; c.s.touch(); return OK; });

    // --- generic
    E("exit", ALLCFG, (c) => { const m = c.s.mode; c.s.mode = m === "af" ? "bgp" : m === "config" ? "priv" : "config"; return OK; });
    E("end", ALLCFG, (c) => { c.s.mode = "priv"; return OK; });
    E("exit-address-family", ["af"], (c) => { c.s.mode = "bgp"; return OK; });
    E("do <x...>", ALLCFG, () => OK);
    E("no <x...>", ALLCFG, () => "% Invalid input detected at '^' marker.");
    E("end", ["priv"], () => OK);
    return compile(T);
    function addPrefix(c, name, seq, action, pfx, opts) {
      if (!/^(permit|deny)$/.test(action)) return "% Invalid input detected at '^' marker."; const x = N.cidr(pfx); if (!x) return "% Invalid input detected at '^' marker.";
      const e = { seq, action, pfx: x.ip, len: x.len }; for (let k = 0; k < opts.length; k += 2) { if (opts[k] === "ge" && opts[k + 1]) e.ge = +opts[k + 1]; else if (opts[k] === "le" && opts[k + 1]) e.le = +opts[k + 1]; }
      const list = (c.D.prefixLists[name] = (c.D.prefixLists[name] || []).filter((q) => q.seq !== seq)); list.push(e); c.s.touch(); return OK;
    }
    function addAcl(c, name, w) {
      // w: [action, proto, src..., dst..., (eq port)]
      const action = w[0].toLowerCase(), proto = w[1].toLowerCase(); let k = 2;
      if (!/^(ip|icmp|tcp|udp)$/.test(proto)) return "% Invalid input detected at '^' marker.";
      const spec = () => { const t = w[k++]; if (t === undefined) return null; if (t === "any") return "any"; if (t === "host") { const h = w[k++]; return isIp(h) ? { host: h } : null; } if (isIp(t) && isIp(w[k])) { const l = wildLen(w[k++]); return l === null ? null : { ip: t, len: l }; } const cc = N.cidr(t); return cc ? { ip: cc.ip, len: cc.len } : null; };
      const src = spec(), dst = spec(); if (!src || !dst) return "% Invalid input detected at '^' marker.";
      let port = null; if (w[k] === "eq" && w[k + 1]) port = /^\d+$/.test(w[k + 1]) ? +w[k + 1] : ({ ssh: 22, telnet: 23, www: 80, http: 80, https: 443, domain: 53, bgp: 179 })[w[k + 1]] || null;
      c.D.acls[name].push({ action, proto, src, dst, port }); c.s.touch(); return OK;
    }
  }
  const TABLE = build();

  const PROMPT = { user: ">", priv: "#", config: "(config)#", if: "(config-if)#", ospf: "(config-router)#", bgp: "(config-router)#", af: "(config-router-af)#", vlan: "(config-vlan)#", rmap: "(config-route-map)#", acl: "(config-ext-nacl)#" };
  Session.prototype.prompt = function () {
    const D = this.d(); if (this.style === "linux") return null;
    let m = PROMPT[this.mode];
    if (this.style === "eos") { const eos = { if: `(config-if-${short(this.ctx.ifc || "")})#`, ospf: "(config-router-ospf)#", bgp: "(config-router-bgp)#", af: "(config-router-bgp-af)#", vlan: `(config-vlan-${this.ctx.vlan})#`, rmap: "(config-route-map)#", acl: "(config-acl)#" }; if (eos[this.mode]) m = eos[this.mode]; }
    if (this.style === "nxos") { const nx = { if: "(config-if)#", ospf: "(config-router)#", bgp: "(config-router)#", af: "(config-router-af)#" }; if (nx[this.mode]) m = nx[this.mode]; if (this.mode === "user") m = ">"; }
    return D.hostname + m;
  };
  Session.prototype.runIos = function (line) {
    const s = this, D = s.d(), prompt = s.prompt(); s.cmds++; s.history.push(line);
    let text = line.trim(); if (!text) return { out: "", prompt };
    let words = text.split(/\s+/), modes = [s.mode];
    if (words[0].toLowerCase() === "do" && s.mode !== "user" && s.mode !== "priv") { words = words.slice(1); modes = ["priv"]; text = words.join(" "); if (!words.length) return { out: "% Incomplete command.", prompt }; }
    if (words[0].toLowerCase() === "?" || /\?$/.test(text)) return { out: "% Context help is not available in this simulator. Use the commands you know or try 'show ?' style guesses.", prompt };
    const R = () => s.R();
    const lazy = { s, D, d: s.dev, net: s.net, style: s.style, prompt, line: text, get R() { return R(); } };
    let dd = dispatch(TABLE, modes, words, prompt.length, s.style);
    if (dd.hit) { let out = dd.hit.e.run(lazy, dd.hit.r.a, text); return { out: out || "", prompt: s.prompt() }; }
    if (dd.ambiguous) return { out: `% Ambiguous command:  "${dd.ambiguous}"`, prompt };
    if (dd.incomplete) return { out: "% Incomplete command.", prompt };
    return { out: caretErr(s.style, prompt, line, words, Math.min(dd.fail || 0, words.length - 1)), prompt };
  };
  Session.prototype.run = function (line) { if (this.style === "linux") return this.runLinux(line); if (this.style === "junos") return this.runJunos(line); return this.runIos(line); };

  const api = { reachText, traceText, TABLE, mac, vlanList };
  root.Netios = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
