/* Codetasks: network-automation coding exercises. Each task has a precise statement, visible
   examples, generators for hidden tests (so answers cannot be hard-coded), and a model solution
   in Python and JavaScript. The hidden-test expectations come from the JavaScript model solution. */
(function (root) {
  "use strict";
  const ri = (r, a, b) => a + Math.floor(r() * (b - a + 1)), pick = (r, l) => l[Math.floor(r() * l.length)];
  const ipS = (r) => `${ri(r, 1, 223)}.${ri(r, 0, 255)}.${ri(r, 0, 255)}.${ri(r, 1, 254)}`;
  const T = [];
  const add = (t) => T.push(t);

  add({
    id: "expand-vlans", title: "Expand a VLAN list", level: 1, topic: "Parsing",
    names: { py: "expand_vlans", js: "expandVlans" }, args: "spec",
    statement: "A switch config line lists VLANs as a comma separated string such as \"10,20-23,30\". Each item is a single number or an inclusive range \"a-b\" (a <= b). Spaces may surround any item or number. Return the VLAN IDs as a sorted list of unique integers.",
    examples: [{ args: ["10,20-23,30"], out: [10, 20, 21, 22, 23, 30] }, { args: ["5, 3-4, 4"], out: [3, 4, 5] }],
    edge: [["1"], ["7-7"], [" 100 - 102 , 100 "], ["4094,1-2"]],
    gen: (r) => { const n = ri(r, 1, 6), it = []; for (let i = 0; i < n; i++) { const a = ri(r, 1, 60); it.push(r() < 0.5 ? String(a) : `${a}${r() < 0.5 ? " - " : "-"}${a + ri(r, 0, 6)}`); } return [it.join(r() < 0.5 ? "," : " , ")]; },
    hints: ["Split on commas, then trim each piece.", "A piece containing '-' is a range; remember the end is included.", "Put everything in a set, then sort."],
    starter: { py: "def expand_vlans(spec):\n    # return a sorted list of unique VLAN ids\n    pass\n", js: "function expandVlans(spec) {\n  // return a sorted array of unique VLAN ids\n}\n" },
    sol: { py: "def expand_vlans(spec):\n    out = set()\n    for part in spec.split(','):\n        part = part.strip()\n        if '-' in part:\n            a, b = [int(x) for x in part.split('-')]\n            out.update(range(a, b + 1))\n        else:\n            out.add(int(part))\n    return sorted(out)\n",
      js: "function expandVlans(spec) {\n  const out = new Set();\n  for (let part of spec.split(',')) {\n    part = part.trim();\n    if (part.includes('-')) { const [a, b] = part.split('-').map((x) => parseInt(x.trim(), 10)); for (let v = a; v <= b; v++) out.add(v); }\n    else out.add(parseInt(part, 10));\n  }\n  return [...out].sort((x, y) => x - y);\n}\n" },
  });

  add({
    id: "compress-vlans", title: "Compress a VLAN list", level: 1, topic: "Parsing",
    names: { py: "compress_vlans", js: "compressVlans" }, args: "vlans",
    statement: "Given a list of VLAN IDs (any order, duplicates possible), return the compact string a switch would print: sort and de-duplicate, join runs of two or more consecutive numbers as \"a-b\", list single VLANs on their own, separate items with commas and no spaces. An empty list gives an empty string.",
    examples: [{ args: [[10, 11, 12, 20, 30, 31]], out: "10-12,20,30-31" }, { args: [[5, 3, 4, 4]], out: "3-5" }, { args: [[]], out: "" }],
    edge: [[[1]], [[2, 1]], [[100, 98, 99, 97, 50]]],
    gen: (r) => { const n = ri(r, 0, 14), l = []; for (let i = 0; i < n; i++) l.push(ri(r, 1, 30)); return [l]; },
    hints: ["Sort and de-duplicate first.", "Walk through the list and extend the current run while the next number is previous + 1.", "A run of length 1 is printed as a single number, longer runs as start-end."],
    starter: { py: "def compress_vlans(vlans):\n    pass\n", js: "function compressVlans(vlans) {\n}\n" },
    sol: { py: "def compress_vlans(vlans):\n    v = sorted(set(vlans))\n    out = []\n    i = 0\n    while i < len(v):\n        j = i\n        while j + 1 < len(v) and v[j + 1] == v[j] + 1:\n            j += 1\n        out.append(str(v[i]) if i == j else f'{v[i]}-{v[j]}')\n        i = j + 1\n    return ','.join(out)\n",
      js: "function compressVlans(vlans) {\n  const v = [...new Set(vlans)].sort((a, b) => a - b), out = [];\n  let i = 0;\n  while (i < v.length) { let j = i; while (j + 1 < v.length && v[j + 1] === v[j] + 1) j++; out.push(i === j ? String(v[i]) : v[i] + '-' + v[j]); i = j + 1; }\n  return out.join(',');\n}\n" },
  });

  add({
    id: "mask-info", title: "Netmask to prefix and wildcard", level: 1, topic: "Addressing",
    names: { py: "mask_info", js: "maskInfo" }, args: "mask",
    statement: "Given a dotted IPv4 netmask, return a dictionary {\"prefix\": <prefix length>, \"wildcard\": <wildcard mask>}. If the mask is not contiguous (ones followed by zeros), return None (null in JavaScript).",
    examples: [{ args: ["255.255.255.0"], out: { prefix: 24, wildcard: "0.0.0.255" } }, { args: ["255.0.255.0"], out: null }],
    edge: [["0.0.0.0"], ["255.255.255.255"], ["255.255.255.252"], ["255.255.254.255"]],
    gen: (r) => { if (r() < 0.25) return [`${pick(r, [255, 254, 128, 0, 192])}.${pick(r, [255, 0, 240])}.${pick(r, [255, 0, 128])}.${pick(r, [0, 255, 248])}`]; const n = ri(r, 0, 32), m = n === 0 ? 0 : (0xFFFFFFFF << (32 - n)) >>> 0; return [[m >>> 24, (m >>> 16) & 255, (m >>> 8) & 255, m & 255].join(".")]; },
    hints: ["Turn the four octets into one 32-bit integer.", "A contiguous mask is ones followed by zeros: the inverted value plus one is a power of two (or zero).", "The wildcard is the bitwise inverse of the mask, written as dotted octets."],
    starter: { py: "def mask_info(mask):\n    pass\n", js: "function maskInfo(mask) {\n}\n" },
    sol: { py: "def mask_info(mask):\n    o = [int(x) for x in mask.split('.')]\n    m = (o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]\n    inv = (~m) & 0xFFFFFFFF\n    if inv & (inv + 1):\n        return None\n    w = [(inv >> s) & 255 for s in (24, 16, 8, 0)]\n    return {'prefix': bin(m).count('1'), 'wildcard': '.'.join(str(x) for x in w)}\n",
      js: "function maskInfo(mask) {\n  const o = mask.split('.').map(Number), m = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0, inv = (~m) >>> 0;\n  if ((inv & (inv + 1)) >>> 0) return null;\n  let c = 0; for (let b = 0; b < 32; b++) if ((m >>> b) & 1) c++;\n  return { prefix: c, wildcard: [(inv >>> 24) & 255, (inv >>> 16) & 255, (inv >>> 8) & 255, inv & 255].join('.') };\n}\n" },
  });

  add({
    id: "parse-if-brief", title: "Parse 'show ip interface brief'", level: 2, topic: "Parsing",
    names: { py: "parse_if_brief", js: "parseIfBrief" }, args: "text",
    statement: "Parse the output of Cisco IOS \"show ip interface brief\" (a header line, then one row per interface; blank lines may appear). Columns: Interface, IP-Address, OK?, Method, Status, Protocol. The Status can be one word (up, down) or two words (administratively down); Protocol is always the last word. Return a list of dictionaries in the order of the rows: {\"name\", \"ip\", \"status\", \"protocol\"}. The IP is None (null) when the address column says unassigned.",
    examples: [{ args: ["Interface              IP-Address      OK? Method Status                Protocol\nGigabitEthernet0/0     10.0.0.1        YES manual up                    up\nGigabitEthernet0/1     unassigned      YES unset  administratively down down"], out: [{ name: "GigabitEthernet0/0", ip: "10.0.0.1", status: "up", protocol: "up" }, { name: "GigabitEthernet0/1", ip: null, status: "administratively down", protocol: "down" }] }],
    edge: [["Interface IP-Address OK? Method Status Protocol\n"], ["Interface IP-Address OK? Method Status Protocol\n\nLoopback0 1.1.1.1 YES manual up up\n\n"]],
    gen: (r) => { const L = ["Interface              IP-Address      OK? Method Status                Protocol"], n = ri(r, 0, 6); for (let i = 0; i < n; i++) { const nm = pick(r, ["GigabitEthernet0/", "Loopback", "Vlan", "TenGigabitEthernet1/0/"]) + ri(r, 0, 20), ip = r() < 0.3 ? "unassigned" : ipS(r), st = r() < 0.3 ? "administratively down" : pick(r, ["up", "down"]), pr = pick(r, ["up", "down"]); L.push(`${nm.padEnd(22)} ${ip.padEnd(15)} YES ${pick(r, ["manual", "unset", "DHCP"]).padEnd(6)} ${st.padEnd(21)} ${pr}`); if (r() < 0.2) L.push(""); } return [L.join("\n")]; },
    hints: ["Skip the header and empty lines.", "Split each row on whitespace: the first token is the name, the second the IP, the last the protocol.", "Status is everything between the Method column (token 4) and the last token, joined with a space."],
    starter: { py: "def parse_if_brief(text):\n    pass\n", js: "function parseIfBrief(text) {\n}\n" },
    sol: { py: "def parse_if_brief(text):\n    out = []\n    for line in text.splitlines():\n        t = line.split()\n        if not t or t[0] == 'Interface':\n            continue\n        out.append({'name': t[0], 'ip': None if t[1] == 'unassigned' else t[1], 'status': ' '.join(t[4:-1]), 'protocol': t[-1]})\n    return out\n",
      js: "function parseIfBrief(text) {\n  const out = [];\n  for (const line of text.split('\\n')) {\n    const t = line.trim().split(/\\s+/);\n    if (!t[0] || t[0] === 'Interface') continue;\n    out.push({ name: t[0], ip: t[1] === 'unassigned' ? null : t[1], status: t.slice(4, -1).join(' '), protocol: t[t.length - 1] });\n  }\n  return out;\n}\n" },
  });

  add({
    id: "summarize", title: "Route summarisation", level: 3, topic: "Addressing",
    names: { py: "summarize", js: "summarize" }, args: "prefixes",
    statement: "Given a list of IPv4 prefixes in CIDR notation (host bits are always zero), return the smallest equivalent list of prefixes: (1) remove duplicates and prefixes already covered by a shorter prefix in the list, (2) repeatedly merge two sibling prefixes (same length, same parent, e.g. 10.0.0.0/25 and 10.0.0.128/25) into their parent (10.0.0.0/24). Return the result sorted by network address, then prefix length.",
    examples: [{ args: [["10.0.0.0/25", "10.0.0.128/25", "10.0.1.0/24"]], out: ["10.0.0.0/23"] }, { args: [["192.168.0.0/24", "192.168.0.64/26", "192.168.0.0/24"]], out: ["192.168.0.0/24"] }],
    edge: [[[]], [["0.0.0.0/0", "10.0.0.0/8"]], [["10.0.0.0/32", "10.0.0.1/32", "10.0.0.2/31"]]],
    gen: (r) => { const n = ri(r, 1, 10), l = [], base = ri(r, 0, 3) * 64; for (let i = 0; i < n; i++) { const len = ri(r, 24, 30), size = 1 << (32 - len), idx = ri(r, 0, Math.floor(256 / size) - 1); l.push(`10.${ri(r, 0, 1)}.${r() < 0.5 ? 0 : 1}.${idx * size}/${len}`.replace(/^10\.(\d)\.(\d)/, (m, a, b) => `10.${a}.${b}`)); } return [l]; },
    hints: ["Convert each prefix to (network integer, length).", "Drop prefixes contained in another one first; then loop: if two neighbours have the same length and the lower one is aligned to the parent size, merge them.", "Repeat until nothing merges, then sort by (network, length) and print back as dotted CIDR."],
    starter: { py: "def summarize(prefixes):\n    pass\n", js: "function summarize(prefixes) {\n}\n" },
    sol: { py: "def summarize(prefixes):\n    def parse(p):\n        a, l = p.split('/')\n        o = [int(x) for x in a.split('.')]\n        return (o[0] << 24 | o[1] << 16 | o[2] << 8 | o[3], int(l))\n    def fmt(n, l):\n        return '.'.join(str((n >> s) & 255) for s in (24, 16, 8, 0)) + '/' + str(l)\n    items = sorted(set(parse(p) for p in prefixes), key=lambda x: (x[0], x[1]))\n    def covered(a, b):\n        size = 1 << (32 - b[1])\n        return b[1] < a[1] and b[0] <= a[0] < b[0] + size\n    items = [a for a in items if not any(covered(a, b) for b in items)]\n    changed = True\n    while changed:\n        changed = False\n        s = set(items)\n        for n, l in sorted(s):\n            if l == 0:\n                continue\n            size = 1 << (32 - l)\n            if n % (size * 2) == 0 and (n + size, l) in s:\n                s.discard((n, l)); s.discard((n + size, l)); s.add((n, l - 1))\n                changed = True\n                break\n        items = sorted(s)\n        items = [a for a in items if not any(covered(a, b) for b in items)]\n    return [fmt(n, l) for n, l in sorted(items)]\n",
      js: "function summarize(prefixes) {\n  const parse = (p) => { const [a, l] = p.split('/'), o = a.split('.').map(Number); return [((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0, +l]; };\n  const fmt = (n, l) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.') + '/' + l;\n  const key = (x) => x[0] * 64 + x[1];\n  const uniq = (l) => { const m = new Map(); l.forEach((x) => m.set(x[0] + '/' + x[1], x)); return [...m.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]); };\n  const covered = (a, b) => b[1] < a[1] && b[0] <= a[0] && a[0] < b[0] + Math.pow(2, 32 - b[1]);\n  const strip = (l) => l.filter((a) => !l.some((b) => covered(a, b)));\n  let items = strip(uniq(prefixes.map(parse))), changed = true;\n  while (changed) {\n    changed = false;\n    const s = new Set(items.map((x) => x[0] + '/' + x[1]));\n    for (const [n, l] of items) {\n      if (l === 0) continue;\n      const size = Math.pow(2, 32 - l);\n      if (n % (size * 2) === 0 && s.has((n + size) + '/' + l)) { items = items.filter((x) => !(x[1] === l && (x[0] === n || x[0] === n + size))); items.push([n, l - 1]); items = strip(uniq(items)); changed = true; break; }\n    }\n  }\n  return uniq(items).map(([n, l]) => fmt(n, l));\n}\n" },
  });

  add({
    id: "lpm", title: "Longest-prefix match", level: 2, topic: "Routing",
    names: { py: "longest_prefix_match", js: "longestPrefixMatch" }, args: "table, ip",
    statement: "A routing table is a list of [prefix, nexthop] pairs (prefix in CIDR notation, host bits zero, 0.0.0.0/0 is the default route). Return the next hop of the most specific (longest) prefix that contains the IPv4 address ip, or None (null) if no prefix matches. If the same prefix appears twice, the first entry wins.",
    examples: [{ args: [[["10.0.0.0/8", "A"], ["10.1.0.0/16", "B"], ["0.0.0.0/0", "D"]], "10.1.2.3"], out: "B" }, { args: [[["10.0.0.0/8", "A"]], "11.0.0.1"], out: null }],
    edge: [[[], "1.1.1.1"], [[["0.0.0.0/0", "X"]], "255.255.255.255"], [[["10.0.0.0/24", "A"], ["10.0.0.0/24", "B"]], "10.0.0.7"]],
    gen: (r) => { const t = [], n = ri(r, 0, 7); for (let i = 0; i < n; i++) { const len = pick(r, [0, 8, 16, 24, 28, 32]), a = [10, ri(r, 0, 2), ri(r, 0, 3), ri(r, 0, 255)]; const m = len === 0 ? 0 : (0xFFFFFFFF << (32 - len)) >>> 0, v = (((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) & m) >>> 0; t.push([[v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".") + "/" + len, "N" + i]); } return [t, `10.${ri(r, 0, 2)}.${ri(r, 0, 3)}.${ri(r, 0, 255)}`]; },
    hints: ["Convert addresses to integers and compare using the prefix mask.", "Keep the best match so far and replace it only with a longer prefix.", "Use a strict 'longer than' test so that an earlier duplicate wins."],
    starter: { py: "def longest_prefix_match(table, ip):\n    pass\n", js: "function longestPrefixMatch(table, ip) {\n}\n" },
    sol: { py: "def longest_prefix_match(table, ip):\n    def num(a):\n        o = [int(x) for x in a.split('.')]\n        return o[0] << 24 | o[1] << 16 | o[2] << 8 | o[3]\n    x = num(ip)\n    best, blen = None, -1\n    for p, nh in table:\n        a, l = p.split('/')\n        l = int(l)\n        m = 0 if l == 0 else (0xFFFFFFFF << (32 - l)) & 0xFFFFFFFF\n        if (x & m) == (num(a) & m) and l > blen:\n            best, blen = nh, l\n    return best\n",
      js: "function longestPrefixMatch(table, ip) {\n  const num = (a) => { const o = a.split('.').map(Number); return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0; };\n  const x = num(ip); let best = null, blen = -1;\n  for (const [p, nh] of table) { const [a, ls] = p.split('/'), l = +ls, m = l === 0 ? 0 : (0xFFFFFFFF << (32 - l)) >>> 0; if (((x & m) >>> 0) === ((num(a) & m) >>> 0) && l > blen) { best = nh; blen = l; } }\n  return best;\n}\n" },
  });

  add({
    id: "bgp-down", title: "Find BGP neighbours that are down", level: 2, topic: "Parsing",
    names: { py: "down_neighbors", js: "downNeighbors" }, args: "text",
    statement: "Parse the neighbour table of \"show ip bgp summary\". A neighbour line starts with an IPv4 address; all other lines are ignored. The last column is State/PfxRcd: if it is an integer the session is Established, anything else (Idle, Active, Connect, \"Idle (Admin)\") means the neighbour is down. Return the addresses of the down neighbours as a list of strings, sorted numerically by address.",
    examples: [{ args: ["Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd\n10.0.0.2        4 65002      10      12        5    0    0 00:05:01        3\n10.0.0.10       4 65003       0       0        1    0    0 never    Active"], out: ["10.0.0.10"] }],
    edge: [[""], ["10.0.0.9 4 65001 0 0 1 0 0 never Idle (Admin)\n10.0.0.1 4 65001 0 0 1 0 0 never Idle"]],
    gen: (r) => { const L = ["BGP router identifier 1.1.1.1, local AS number 65000", "Neighbor        V    AS MsgRcvd MsgSent   TblVer  InQ OutQ Up/Down  State/PfxRcd"], n = ri(r, 0, 8); for (let i = 0; i < n; i++) { const st = r() < 0.5 ? String(ri(r, 0, 99)) : pick(r, ["Idle", "Active", "Connect", "Idle (Admin)"]); L.push(`10.${ri(r, 0, 3)}.${ri(r, 0, 9)}.${ri(r, 1, 250)}  4 ${65000 + ri(r, 1, 9)} ${ri(r, 0, 99)} ${ri(r, 0, 99)} 5 0 0 ${st === "Active" ? "never" : "00:05:01"} ${st}`); } return [L.join("\n")]; },
    hints: ["Only lines whose first token looks like an IPv4 address are neighbours.", "The state is the part after the 8th column; test whether the last token is all digits.", "Sort by the four numeric octets, not as strings."],
    starter: { py: "def down_neighbors(text):\n    pass\n", js: "function downNeighbors(text) {\n}\n" },
    sol: { py: "import re\n\ndef down_neighbors(text):\n    out = []\n    for line in text.splitlines():\n        t = line.split()\n        if t and re.fullmatch(r'\\d+\\.\\d+\\.\\d+\\.\\d+', t[0]) and not t[-1].isdigit():\n            out.append(t[0])\n    return sorted(set(out), key=lambda a: [int(x) for x in a.split('.')])\n",
      js: "function downNeighbors(text) {\n  const out = new Set();\n  for (const line of text.split('\\n')) { const t = line.trim().split(/\\s+/); if (/^\\d+\\.\\d+\\.\\d+\\.\\d+$/.test(t[0]) && !/^\\d+$/.test(t[t.length - 1])) out.add(t[0]); }\n  const key = (a) => a.split('.').map(Number);\n  return [...out].sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; });\n}\n" },
  });

  add({
    id: "config-diff", title: "Configuration diff", level: 1, topic: "Automation",
    names: { py: "config_diff", js: "configDiff" }, args: "old, new",
    statement: "old and new are lists of configuration lines. Ignore blank lines, lines that are only \"!\" and leading/trailing spaces. Return {\"added\": [...], \"removed\": [...]}: the lines present in new but not in old (in the order of new) and the lines present in old but not in new (in the order of old). A line appears at most once in each result.",
    examples: [{ args: [["hostname R1", "ntp server 1.1.1.1", "!"], ["hostname R1", "ntp server 2.2.2.2"]], out: { added: ["ntp server 2.2.2.2"], removed: ["ntp server 1.1.1.1"] } }],
    edge: [[[], []], [["a", "a", " b "], ["b", "c", "c"]]],
    gen: (r) => { const pool = ["hostname R1", "ntp server 1.1.1.1", "snmp-server community x", "logging host 10.0.0.1", "ip ssh version 2", "no ip http server", "!", "", "  banner motd x "]; const mk = () => { const n = ri(r, 0, 7), l = []; for (let i = 0; i < n; i++) l.push(pick(r, pool)); return l; }; return [mk(), mk()]; },
    hints: ["Normalise both lists first: strip, drop empty lines and '!'.", "Use a set of the other side for fast membership tests.", "Keep the original order and skip lines you already added."],
    starter: { py: "def config_diff(old, new):\n    pass\n", js: "function configDiff(old, nw) {\n}\n" },
    sol: { py: "def config_diff(old, new):\n    def norm(l):\n        return [x.strip() for x in l if x.strip() and x.strip() != '!']\n    o, n = norm(old), norm(new)\n    def uniq(l):\n        s = []\n        for x in l:\n            if x not in s:\n                s.append(x)\n        return s\n    return {'added': uniq([x for x in n if x not in set(o)]), 'removed': uniq([x for x in o if x not in set(n)])}\n",
      js: "function configDiff(old, nw) {\n  const norm = (l) => l.map((x) => x.trim()).filter((x) => x && x !== '!');\n  const o = norm(old), n = norm(nw), so = new Set(o), sn = new Set(n);\n  const uniq = (l) => [...new Set(l)];\n  return { added: uniq(n.filter((x) => !so.has(x))), removed: uniq(o.filter((x) => !sn.has(x))) };\n}\n" },
  });

  add({
    id: "acl", title: "Evaluate an ACL", level: 2, topic: "Security",
    names: { py: "acl_permits", js: "aclPermits" }, args: "acl, pkt",
    statement: "An ACL is a list of entries [action, proto, src, dst, port]: action is \"permit\" or \"deny\"; proto is \"ip\", \"tcp\", \"udp\" or \"icmp\" (\"ip\" matches every protocol); src and dst are a CIDR prefix or \"any\"; port is an integer or None (null). The packet is a dictionary {\"proto\", \"src\", \"dst\", \"port\"} with plain IPv4 addresses (port is None for icmp). Entries are checked top to bottom, the first match decides. An entry with a port matches only when the packet's port equals it. If nothing matches the packet is denied (implicit deny). Return True if the packet is permitted.",
    examples: [{ args: [[["deny", "tcp", "any", "10.0.0.0/24", 23], ["permit", "ip", "any", "any", null]], { proto: "tcp", src: "1.1.1.1", dst: "10.0.0.5", port: 23 }], out: false }, { args: [[["permit", "tcp", "192.168.0.0/16", "any", 80]], { proto: "tcp", src: "192.168.1.1", dst: "8.8.8.8", port: 80 }], out: true }],
    edge: [[[], { proto: "icmp", src: "1.1.1.1", dst: "2.2.2.2", port: null }], [[["permit", "udp", "any", "any", 53]], { proto: "tcp", src: "1.1.1.1", dst: "2.2.2.2", port: 53 }]],
    gen: (r) => { const n = ri(r, 0, 5), acl = []; for (let i = 0; i < n; i++) { const pr = pick(r, ["ip", "tcp", "udp", "icmp"]); acl.push([pick(r, ["permit", "deny"]), pr, r() < 0.4 ? "any" : `10.${ri(r, 0, 1)}.0.0/${pick(r, [8, 16, 24])}`, r() < 0.4 ? "any" : `10.${ri(r, 0, 1)}.${ri(r, 0, 2)}.0/${pick(r, [16, 24])}`, (pr === "tcp" || pr === "udp") && r() < 0.6 ? pick(r, [22, 53, 80, 443]) : null]); } const pr = pick(r, ["tcp", "udp", "icmp"]); return [acl, { proto: pr, src: `10.${ri(r, 0, 1)}.${ri(r, 0, 2)}.${ri(r, 1, 9)}`, dst: `10.${ri(r, 0, 1)}.${ri(r, 0, 2)}.${ri(r, 1, 9)}`, port: pr === "icmp" ? null : pick(r, [22, 53, 80, 443]) }]; },
    hints: ["Write a helper that tests whether an address is inside a CIDR or the word 'any'.", "An entry matches when proto matches (ip matches all), src and dst match, and (port is None or equals the packet port).", "Return on the first matching entry; after the loop return False."],
    starter: { py: "def acl_permits(acl, pkt):\n    pass\n", js: "function aclPermits(acl, pkt) {\n}\n" },
    sol: { py: "def acl_permits(acl, pkt):\n    def num(a):\n        o = [int(x) for x in a.split('.')]\n        return o[0] << 24 | o[1] << 16 | o[2] << 8 | o[3]\n    def inside(ip, c):\n        if c == 'any':\n            return True\n        a, l = c.split('/')\n        l = int(l)\n        m = 0 if l == 0 else (0xFFFFFFFF << (32 - l)) & 0xFFFFFFFF\n        return (num(ip) & m) == (num(a) & m)\n    for action, proto, src, dst, port in acl:\n        if proto != 'ip' and proto != pkt['proto']:\n            continue\n        if not inside(pkt['src'], src) or not inside(pkt['dst'], dst):\n            continue\n        if port is not None and port != pkt['port']:\n            continue\n        return action == 'permit'\n    return False\n",
      js: "function aclPermits(acl, pkt) {\n  const num = (a) => { const o = a.split('.').map(Number); return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0; };\n  const inside = (ip, c) => { if (c === 'any') return true; const [a, ls] = c.split('/'), l = +ls, m = l === 0 ? 0 : (0xFFFFFFFF << (32 - l)) >>> 0; return ((num(ip) & m) >>> 0) === ((num(a) & m) >>> 0); };\n  for (const [action, proto, src, dst, port] of acl) {\n    if (proto !== 'ip' && proto !== pkt.proto) continue;\n    if (!inside(pkt.src, src) || !inside(pkt.dst, dst)) continue;\n    if (port !== null && port !== pkt.port) continue;\n    return action === 'permit';\n  }\n  return false;\n}\n" },
  });

  add({
    id: "shortest-path", title: "Shortest path (SPF)", level: 3, topic: "Routing",
    names: { py: "shortest_path", js: "shortestPath" }, args: "graph, src, dst",
    statement: "graph maps every node to a dictionary {neighbour: cost} with positive integer costs (links are listed in both directions). Return [total_cost, path] where path is the list of nodes from src to dst. If several paths have the same minimal cost, return the one that is smaller when the path lists are compared lexicographically (node names compared as strings). If dst cannot be reached, return None (null). If src == dst the answer is [0, [src]].",
    examples: [{ args: [{ A: { B: 1, C: 1 }, B: { A: 1, D: 1 }, C: { A: 1, D: 1 }, D: { B: 1, C: 1 } }, "A", "D"], out: [2, ["A", "B", "D"]] }],
    edge: [[{ A: {} }, "A", "A"], [{ A: {}, B: {} }, "A", "B"]],
    gen: (r) => { const nodes = "ABCDEFGH".slice(0, ri(r, 3, 8)).split(""), g = {}; nodes.forEach((n) => (g[n] = {})); for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (r() < 0.4) { const c = ri(r, 1, 4); g[nodes[i]][nodes[j]] = c; g[nodes[j]][nodes[i]] = c; } return [g, pick(r, nodes), pick(r, nodes)]; },
    hints: ["This is Dijkstra's algorithm; keep a priority queue of (cost, path).", "If you store the whole path in the queue entry and compare (cost, path) tuples, ties resolve lexicographically for free.", "Stop when you pop the destination; skip nodes you have already finalised."],
    starter: { py: "def shortest_path(graph, src, dst):\n    pass\n", js: "function shortestPath(graph, src, dst) {\n}\n" },
    sol: { py: "import heapq\n\ndef shortest_path(graph, src, dst):\n    heap = [(0, [src])]\n    done = set()\n    while heap:\n        cost, path = heapq.heappop(heap)\n        node = path[-1]\n        if node in done:\n            continue\n        if node == dst:\n            return [cost, path]\n        done.add(node)\n        for nb, c in graph.get(node, {}).items():\n            if nb not in done:\n                heapq.heappush(heap, (cost + c, path + [nb]))\n    return None\n",
      js: "function shortestPath(graph, src, dst) {\n  const less = (a, b) => { if (a[0] !== b[0]) return a[0] < b[0]; const x = a[1], y = b[1]; for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i]; return x.length < y.length; };\n  let heap = [[0, [src]]]; const done = new Set();\n  while (heap.length) {\n    let bi = 0; for (let i = 1; i < heap.length; i++) if (less(heap[i], heap[bi])) bi = i;\n    const [cost, path] = heap.splice(bi, 1)[0], node = path[path.length - 1];\n    if (done.has(node)) continue;\n    if (node === dst) return [cost, path];\n    done.add(node);\n    for (const [nb, c] of Object.entries(graph[node] || {})) if (!done.has(nb)) heap.push([cost + c, path.concat(nb)]);\n  }\n  return null;\n}\n" },
  });

  add({
    id: "flaps", title: "Find flapping interfaces in a log", level: 2, topic: "Troubleshooting",
    names: { py: "flapping", js: "flapping" }, args: "logs, threshold",
    statement: "logs is a list of syslog lines. Lines of the form \"... %LINK-3-UPDOWN: Interface <name>, changed state to down|up\" report link changes; other lines are noise. Count the \"down\" events per interface. Return the interface names whose count is at least threshold, sorted by count (highest first), then by name.",
    examples: [{ args: [["Nov 22 10:00:01 R1 %LINK-3-UPDOWN: Interface Gi0/1, changed state to down", "Nov 22 10:00:05 R1 %LINK-3-UPDOWN: Interface Gi0/1, changed state to up", "Nov 22 10:01:00 R1 %LINK-3-UPDOWN: Interface Gi0/1, changed state to down", "Nov 22 10:02:00 R1 %OSPF-5-ADJCHG: Process 1, Nbr 2.2.2.2 on Gi0/0 from FULL to DOWN"], 2], out: ["Gi0/1"] }],
    edge: [[[], 1], [["x %LINK-3-UPDOWN: Interface Gi0/2, changed state to down"], 1]],
    gen: (r) => { const n = ri(r, 0, 16), L = []; for (let i = 0; i < n; i++) { const t = r(); L.push(t < 0.8 ? `Nov 22 10:${String(ri(r, 0, 59)).padStart(2, "0")}:00 R1 %LINK-3-UPDOWN: Interface ${pick(r, ["Gi0/0", "Gi0/1", "Gi0/2", "Te1/0/1"])}, changed state to ${pick(r, ["down", "up", "down"])}` : `Nov 22 10:00:00 R1 %SYS-5-CONFIG_I: Configured from console`); } return [L, ri(r, 1, 3)]; },
    hints: ["A regular expression with a capture group for the interface name and one for up/down is the cleanest way.", "Count only the 'down' events in a dictionary.", "Sort with a key of (-count, name)."],
    starter: { py: "def flapping(logs, threshold):\n    pass\n", js: "function flapping(logs, threshold) {\n}\n" },
    sol: { py: "import re\n\ndef flapping(logs, threshold):\n    c = {}\n    for line in logs:\n        m = re.search(r'%LINK-3-UPDOWN: Interface (\\S+), changed state to (down|up)', line)\n        if m and m.group(2) == 'down':\n            c[m.group(1)] = c.get(m.group(1), 0) + 1\n    return [k for k, v in sorted(c.items(), key=lambda kv: (-kv[1], kv[0])) if v >= threshold]\n",
      js: "function flapping(logs, threshold) {\n  const c = {};\n  for (const line of logs) { const m = line.match(/%LINK-3-UPDOWN: Interface (\\S+), changed state to (down|up)/); if (m && m[2] === 'down') c[m[1]] = (c[m[1]] || 0) + 1; }\n  return Object.entries(c).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).filter((e) => e[1] >= threshold).map((e) => e[0]);\n}\n" },
  });

  add({
    id: "dr", title: "OSPF DR/BDR election", level: 2, topic: "Routing",
    names: { py: "dr_election", js: "drElection" }, args: "routers",
    statement: "routers is a list of [router_id, priority] on one broadcast segment (router_id is a dotted IPv4 string, priority an integer 0-255). Routers with priority 0 cannot be DR or BDR. Among the others the DR is the one with the highest priority; ties are broken by the numerically highest router ID. The BDR is the second best by the same rule. Return [dr, bdr]; use None (null) for a missing role.",
    examples: [{ args: [[["1.1.1.1", 1], ["2.2.2.2", 1], ["3.3.3.3", 0]]], out: ["2.2.2.2", "1.1.1.1"] }, { args: [[["10.0.0.9", 5], ["9.9.9.9", 5]]], out: ["10.0.0.9", "9.9.9.9"] }],
    edge: [[[]], [[["1.1.1.1", 0]]], [[["1.1.1.1", 3]]]],
    gen: (r) => { const n = ri(r, 0, 6), l = []; for (let i = 0; i < n; i++) l.push([`${ri(r, 1, 12)}.${ri(r, 0, 3)}.0.${ri(r, 1, 9)}`, pick(r, [0, 1, 1, 5, 100])]); return [l]; },
    hints: ["Filter out priority 0 first.", "Sort by (priority, numeric router id) descending; compare the id as four integers, not as a string.", "Take the first two entries; pad with None."],
    starter: { py: "def dr_election(routers):\n    pass\n", js: "function drElection(routers) {\n}\n" },
    sol: { py: "def dr_election(routers):\n    el = [(p, [int(x) for x in rid.split('.')], rid) for rid, p in routers if p > 0]\n    el.sort(key=lambda t: (t[0], t[1]), reverse=True)\n    ids = [t[2] for t in el]\n    return [ids[0] if len(ids) > 0 else None, ids[1] if len(ids) > 1 else None]\n",
      js: "function drElection(routers) {\n  const el = routers.filter((r) => r[1] > 0).map((r) => [r[1], r[0].split('.').map(Number), r[0]]);\n  el.sort((a, b) => { if (a[0] !== b[0]) return b[0] - a[0]; for (let i = 0; i < 4; i++) if (a[1][i] !== b[1][i]) return b[1][i] - a[1][i]; return 0; });\n  return [el.length > 0 ? el[0][2] : null, el.length > 1 ? el[1][2] : null];\n}\n" },
  });

  add({
    id: "vlsm", title: "VLSM address plan", level: 3, topic: "Addressing",
    names: { py: "vlsm", js: "vlsm" }, args: "base, needs",
    statement: "base is an IPv4 network in CIDR notation (aligned, host bits zero) and needs is a list of required host counts. Allocate the subnets largest first (for equal needs keep the original order). Each subnet is the smallest power-of-two block that holds need + 2 addresses (network and broadcast), but never smaller than /30. Place each block at the next address that is aligned to its size, starting at the beginning of base and moving forward without gaps beyond alignment. Return a list of {\"need\": n, \"network\": \"a.b.c.d/len\"} in allocation order. If the allocations do not fit in base, return None (null).",
    examples: [{ args: ["192.168.1.0/24", [50, 20, 2]], out: [{ need: 50, network: "192.168.1.0/26" }, { need: 20, network: "192.168.1.64/27" }, { need: 2, network: "192.168.1.96/30" }] }],
    edge: [["10.0.0.0/30", [2]], ["10.0.0.0/30", [3]], ["10.0.0.0/29", []]],
    gen: (r) => { const n = ri(r, 0, 5), l = []; for (let i = 0; i < n; i++) l.push(ri(r, 1, 70)); return [`10.${ri(r, 0, 5)}.${ri(r, 0, 3) * 64}.0/${pick(r, [24, 24, 25, 23])}`.replace(/\.(\d+)\.(\d+)\.0\/23$/, (m, a, b) => `.${a}.${(b >> 1) << 1}.0/23`), l]; },
    hints: ["Sort needs descending with a stable sort.", "Block size = smallest power of two >= need + 2, at least 4. Prefix length = 32 - log2(size).", "Keep a running offset; round it up to a multiple of the block size before placing; fail if offset + size exceeds the size of base."],
    starter: { py: "def vlsm(base, needs):\n    pass\n", js: "function vlsm(base, needs) {\n}\n" },
    sol: { py: "def vlsm(base, needs):\n    addr, plen = base.split('/')\n    o = [int(x) for x in addr.split('.')]\n    start = o[0] << 24 | o[1] << 16 | o[2] << 8 | o[3]\n    total = 1 << (32 - int(plen))\n    order = sorted(range(len(needs)), key=lambda i: (-needs[i], i))\n    off = 0\n    out = []\n    for i in order:\n        size = 4\n        while size < needs[i] + 2:\n            size *= 2\n        off = -(-off // size) * size\n        if off + size > total:\n            return None\n        n = start + off\n        bits = size.bit_length() - 1\n        out.append({'need': needs[i], 'network': '.'.join(str((n >> s) & 255) for s in (24, 16, 8, 0)) + '/' + str(32 - bits)})\n        off += size\n    return out\n",
      js: "function vlsm(base, needs) {\n  const [addr, pl] = base.split('/'), o = addr.split('.').map(Number), start = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0, total = Math.pow(2, 32 - +pl);\n  const order = needs.map((n, i) => i).sort((a, b) => needs[b] - needs[a] || a - b);\n  let off = 0; const out = [];\n  for (const i of order) {\n    let size = 4; while (size < needs[i] + 2) size *= 2;\n    off = Math.ceil(off / size) * size;\n    if (off + size > total) return null;\n    const n = start + off, bits = Math.log2(size);\n    out.push({ need: needs[i], network: [24, 16, 8, 0].map((s) => Math.floor(n / Math.pow(2, s)) % 256).join('.') + '/' + (32 - bits) });\n    off += size;\n  }\n  return out;\n}\n" },
  });

  add({
    id: "junos-set", title: "Junos set-lines to a tree", level: 2, topic: "Automation",
    names: { py: "parse_junos_set", js: "parseJunosSet" }, args: "lines",
    statement: "Convert Junos 'set' commands to a nested dictionary: every word after \"set\" is one nesting level, and the last word maps to an empty dictionary. Lines that do not start with \"set \" are ignored. Words are separated by single spaces. Commands that share a prefix share the same branch.",
    examples: [{ args: [["set interfaces ge-0/0/0 unit 0", "set interfaces lo0 unit 0", "set system host-name R1"]], out: { interfaces: { "ge-0/0/0": { unit: { 0: {} } }, lo0: { unit: { 0: {} } } }, system: { "host-name": { R1: {} } } } }],
    edge: [[[]], [["delete foo", "set a", "set a b", "set a"]]],
    gen: (r) => { const n = ri(r, 0, 7), l = [], W = ["interfaces", "protocols", "ospf", "area", "0", "interface", "ge-0/0/0", "lo0", "unit", "bgp", "group", "A"]; for (let i = 0; i < n; i++) { const k = ri(r, 1, 5), w = []; for (let j = 0; j < k; j++) w.push(pick(r, W)); l.push((r() < 0.9 ? "set " : "delete ") + w.join(" ")); } return [l]; },
    hints: ["Start with an empty dict; for each line walk down the words.", "At each level create the child dict if it does not exist (setdefault in Python).", "Skip lines whose first word is not 'set'."],
    starter: { py: "def parse_junos_set(lines):\n    pass\n", js: "function parseJunosSet(lines) {\n}\n" },
    sol: { py: "def parse_junos_set(lines):\n    tree = {}\n    for line in lines:\n        w = line.split(' ')\n        if w[0] != 'set' or len(w) < 2:\n            continue\n        node = tree\n        for word in w[1:]:\n            node = node.setdefault(word, {})\n    return tree\n",
      js: "function parseJunosSet(lines) {\n  const tree = {};\n  for (const line of lines) {\n    const w = line.split(' ');\n    if (w[0] !== 'set' || w.length < 2) continue;\n    let node = tree;\n    for (const word of w.slice(1)) { if (!Object.prototype.hasOwnProperty.call(node, word)) node[word] = {}; node = node[word]; }\n  }\n  return tree;\n}\n" },
  });

  // ---- helpers used by the runner and the UI
  function cmp(a, b) { return stable(a) === stable(b); }
  function stable(v) { if (v === undefined) return "null"; if (v === null || typeof v !== "object") return JSON.stringify(v); if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]"; return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}"; }
  function rngOf(seed) { let a = seed >>> 0 || 1; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function refFn(task) { return new Function(task.sol.js + "\nreturn " + task.names.js + ";")(); }
  // hidden tests: edge cases + random inputs, expected values from the JavaScript model solution
  function hiddenCases(task, seed, n) {
    const f = refFn(task), r = rngOf(seed), cases = [];
    const push = (args, kind) => { const copy = JSON.parse(JSON.stringify(args)); let exp; try { exp = f(...JSON.parse(JSON.stringify(args))); } catch (e) { return; } cases.push({ args: copy, expected: exp === undefined ? null : JSON.parse(JSON.stringify(exp)), kind }); };
    (task.edge || []).forEach((a) => push(a, "edge"));
    for (let i = 0; i < (n || 10); i++) push(task.gen(r), "random");
    return cases;
  }
  function visibleCases(task) { return task.examples.map((e) => ({ args: JSON.parse(JSON.stringify(e.args)), expected: e.out, kind: "example" })); }
  const api = { TASKS: T, cmp, stable, hiddenCases, visibleCases, refFn, rngOf, byId: (id) => T.find((t) => t.id === id) };
  root.Codetasks = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
