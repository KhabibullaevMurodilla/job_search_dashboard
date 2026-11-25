/* Designcases: vendor-neutral design and architecture cases with a scored rubric.
   Each case has decisions (single or multiple choice, every option explained), concepts a good
   written justification mentions, and a reference design. Grading is deterministic. */
(function (root) {
  "use strict";
  // helpers keep the data short: o(id, text, points, why)
  const o = (id, text, pts, why) => ({ id, text, pts, why });
  const S = (id, q, options) => ({ id, q, kind: "single", options });
  const M = (id, q, options) => ({ id, q, kind: "multi", options });
  const K = (id, label, words) => ({ id, label, words });

  const CASES = [
    // ------------------------------------------------------------------ level 1
    { id: "campus-vlans", level: 1, topic: "Switching", title: "Campus access layer: VLANs and gateways",
      brief: "A 300-person office has staff PCs, VoIP phones, printers, guest Wi-Fi and building cameras on one flat /22. Broadcasts are heavy and guests can reach printers. Design the access layer.",
      decisions: [
        S("seg", "How do you segment?", [o("a", "One VLAN per function (staff, voice, printers, guest, cameras), each with its own subnet", 2, "Separate broadcast domains and a point where policy can be applied."), o("b", "One VLAN per floor, mixing all device types", 0, "Shrinks broadcast domains but keeps guests next to printers."), o("c", "Keep one VLAN and use port security to block guests", 0, "Port security limits MAC addresses; it is not segmentation.")]),
        S("gw", "Where do the VLAN gateways live?", [o("a", "On the distribution/core pair, with a first-hop redundancy protocol or MLAG anycast", 2, "Inter-VLAN traffic crosses one policy point and the gateway survives a switch failure."), o("b", "On every access switch, with no redundancy protocol", 1, "Routed access is valid, but without a plan for addressing and failure it is not what was asked."), o("c", "On a single firewall in the corner of the room", 0, "A single point of failure for all inter-VLAN traffic.")]),
        M("sec", "Which controls belong in the design?", [o("a", "ACL or firewall policy: guests may reach only the internet", 1, "Segmentation without policy is only cosmetic."), o("b", "BPDU guard and root guard on edge ports", 1, "Protects the spanning tree from rogue switches."), o("c", "DHCP snooping and dynamic ARP inspection on user VLANs", 1, "Stops rogue DHCP servers and ARP spoofing."), o("d", "Allow all VLANs on all trunks for flexibility", -1, "Widens the failure domain; prune to what is needed."), o("e", "Use VLAN 1 as the management VLAN for everything", -1, "The default VLAN is a poor choice for management and user traffic.")]),
      ],
      concepts: [K("bd", "smaller broadcast domains", ["broadcast"]), K("pol", "policy between segments (ACL or firewall)", ["acl", "firewall", "policy"]), K("fhrp", "gateway redundancy (HSRP, VRRP, MLAG, anycast)", ["hsrp", "vrrp", "mlag", "anycast", "redundan"]), K("stp", "spanning tree protection (BPDU guard, root guard)", ["bpdu", "root guard", "spanning"]), K("prune", "pruned trunks", ["prun", "allowed vlan"])],
      model: "One VLAN and subnet per function; gateways on a redundant distribution pair; ACL or firewall policy so guests reach only the internet; BPDU guard, DHCP snooping and DAI on edge ports; trunks carry only the VLANs they need." },

    { id: "addr-plan", level: 1, topic: "Addressing", title: "Addressing plan for three sites",
      brief: "Three offices (about 400, 120 and 60 hosts) join a head office with 1,000 hosts. Growth of 50 percent is expected in five years. You have 10.0.0.0/8. The WAN will run OSPF or BGP and routing tables must stay small.",
      decisions: [
        S("blocks", "How do you allocate space?", [o("a", "One aligned block per site sized for growth (for example /21 for head office, /22, /24 and /25 for the sites), carved from a contiguous parent so each site summarises to one route", 2, "Aligned blocks summarise cleanly and leave room."), o("b", "Assign subnets in the order requests arrive from anywhere in 10.0.0.0/8", 0, "Scattered prefixes cannot be summarised."), o("c", "Give every site a /16 to be safe", 1, "Summarises, but wastes space and makes later plans harder.")]),
        S("p2p", "Router-to-router links?", [o("a", "/31 (or /30) from a dedicated infrastructure block", 2, "Saves space and keeps infrastructure addresses apart from users."), o("b", "/24 per link", 0, "Wasteful.")]),
        M("extra", "Which practices do you add?", [o("a", "Loopback /32 per router from a separate block, used as router ID and management address", 1, "Stable addresses that do not depend on a link."), o("b", "Document the plan in a source of truth (IPAM)", 1, "Plans drift without a record."), o("c", "Use overlapping private ranges at each site and NAT between them", -1, "Avoidable complexity."), o("d", "Reserve a growth block per site, unallocated", 1, "Lets a site grow without renumbering.")]),
      ],
      concepts: [K("sum", "summarisation", ["summar", "aggregate"]), K("grow", "growth headroom", ["growth", "headroom", "reserve", "spare"]), K("loop", "loopbacks", ["loopback"]), K("ipam", "a recorded plan (IPAM)", ["ipam", "source of truth", "document"]), K("p2p", "/31 or /30 point-to-point links", ["/31", "/30", "point-to-point"])],
      model: "Aligned blocks per site from one parent (for example 10.1.0.0/21 for head office, then a /22, a /24 and a /25 for the sites, each sized for 50 percent growth), a separate block for /31 links and /32 loopbacks, growth reserved and everything recorded in IPAM so each site advertises one summary." },

    { id: "redundant-uplinks", level: 1, topic: "Switching", title: "Redundant uplinks without loops",
      brief: "An access switch has two uplinks to two distribution switches. The customer wants both links used and the network to survive any one switch or link failure.",
      decisions: [
        S("how", "What do you choose?", [o("a", "A LAG to a pair of switches that present as one (MLAG / virtual chassis / stacking), with LACP", 2, "Both links forward and no spanning-tree block."), o("b", "Plain spanning tree on two separate trunks", 1, "Safe, but one uplink is blocked per VLAN unless you load-balance VLANs by hand."), o("c", "Disable spanning tree and connect both links as they are", 0, "A loop will melt the network.")]),
        S("lacp", "Bundle mode?", [o("a", "LACP (active on both ends)", 2, "Negotiated, detects misconfigured members."), o("b", "Static 'on' mode", 0, "No negotiation: a one-sided mistake can black-hole traffic.")]),
        M("keep", "What else do you keep?", [o("a", "Spanning tree still enabled as a safety net", 1, "A mistake elsewhere must not become a loop."), o("b", "Deterministic root bridge on the distribution layer", 1, "Stops a random access switch becoming root."), o("c", "Run UDLD or link-fault detection on fibre", 1, "Catches one-way links."), o("d", "Set every port to portfast, including trunks", -1, "Portfast is for edge ports only.")]),
      ],
      concepts: [K("lacp", "LACP", ["lacp", "802.3ad", "port-channel", "lag"]), K("mlag", "multi-chassis aggregation", ["mlag", "vpc", "virtual chassis", "stack"]), K("stp", "spanning tree kept as protection", ["spanning", "stp", "rstp"]), K("root", "deliberate root bridge", ["root"])],
      model: "MLAG/virtual-chassis distribution pair, an LACP bundle from the access switch, spanning tree left on with the distribution pair as root, portfast only on edge ports." },

    // ------------------------------------------------------------------ level 2
    { id: "ospf-areas", level: 2, topic: "Routing", title: "OSPF areas for a growing WAN",
      brief: "A regional company has 40 sites on one OSPF area 0. Every site flap triggers SPF on all routers, and small branch routers run out of memory. Redesign.",
      decisions: [
        S("areas", "Structure?", [o("a", "Backbone area 0 for the core; one non-backbone area per region, each connected to area 0 by ABRs", 2, "Limits flooding and SPF to the area."), o("b", "Put each branch in its own area", 0, "Too many areas and ABRs; the backbone becomes the hub of everything."), o("c", "Keep one area and raise the SPF timers", 1, "Treats the symptom only.")]),
        S("sum", "On the ABRs?", [o("a", "Summarise each region's prefixes into area 0 (area range)", 2, "A flap inside a region no longer reaches the backbone."), o("b", "No summarisation, so every route is visible everywhere", 0, "Defeats the purpose of areas.")]),
        S("stub", "Branch areas?", [o("a", "Totally stubby (or stub) areas with a default route from the ABR", 2, "Removes external and inter-area detail from small routers."), o("b", "Normal areas with full tables", 0, "That is the memory problem again.")]),
        M("more", "Which additions help?", [o("a", "Loopback router IDs", 1, "Stable IDs."), o("b", "BFD for fast failure detection", 1, "Faster than hello timers; use with care on flappy links."), o("c", "Prefix-suppression or passive interfaces on user LANs", 1, "Fewer adjacencies and LSAs."), o("d", "Virtual links to join areas wherever needed", -1, "A workaround, not a design.")]),
      ],
      concepts: [K("abr", "ABRs and area 0", ["abr", "area 0", "backbone"]), K("sum", "summarisation at area borders", ["summar", "area range"]), K("stub", "stub or totally stubby areas", ["stub"]), K("spf", "limiting flooding and SPF scope", ["spf", "flood", "lsa"]), K("bfd", "BFD or tuned timers", ["bfd", "timer"])],
      model: "Area 0 core, regional areas behind ABRs that summarise, totally stubby branch areas with a default route, loopback IDs, passive user LANs and BFD." },

    { id: "dual-isp", level: 2, topic: "Routing", title: "Dual-ISP internet edge",
      brief: "A company has two internet providers and a /24 of its own provider-independent address space. It wants resilience and prefers ISP A for outbound traffic.",
      decisions: [
        S("proto", "How do you connect?", [o("a", "eBGP to both providers, advertising your /24 to both", 2, "Your address space follows you whichever provider is up."), o("b", "Two default routes with different metrics and NAT to each provider's own addresses", 1, "Works for outbound only and breaks inbound reachability of your own prefix."), o("c", "Static routes only", 0, "No failover for inbound.")]),
        S("out", "Prefer ISP A outbound?", [o("a", "Set higher local-preference on routes learned from ISP A", 2, "Local-pref is the standard outbound control inside the AS."), o("b", "Prepend your AS on routes from ISP A", 0, "AS-path prepending influences how others reach you, not your outbound choice."), o("c", "Lower the MED you send to ISP A", 0, "MED is sent to the neighbour AS for inbound influence and not used for your own outbound.")]),
        M("safe", "Which protections are needed?", [o("a", "Filter inbound: accept only the default or sane prefixes, and reject your own prefixes and bogons", 1, "Stops route leaks into you."), o("b", "Filter outbound: advertise only your /24", 1, "Avoids becoming a transit between your providers."), o("c", "Max-prefix limit on each session", 1, "Contains a provider mistake."), o("d", "Advertise everything you learn from ISP A to ISP B", -1, "That makes you a transit network.")]),
      ],
      concepts: [K("ebgp", "eBGP to both providers", ["ebgp", "bgp"]), K("lp", "local-preference for outbound", ["local-pref", "local pref", "localpref"]), K("transit", "not becoming transit", ["transit", "outbound filter", "prefix-list", "prefix list"]), K("bogon", "inbound filtering", ["bogon", "inbound filter", "reject"]), K("maxp", "max-prefix", ["max-prefix", "maximum-prefix", "max prefix"])],
      model: "eBGP to both ISPs, announce only the /24, accept default or filtered routes, local-preference 200 on ISP A, max-prefix and prefix filters in both directions so the company never becomes transit." },

    { id: "edge-fw", level: 2, topic: "Security", title: "Where firewalls and NAT go",
      brief: "A company is moving a web application from one server to two servers behind a load balancer. There is an internet edge, a user LAN and a server network. Decide the placement of policy and NAT.",
      decisions: [
        S("zones", "Zone design?", [o("a", "Separate zones for internet, DMZ (load balancer and web tier), internal servers and users, with policy between each", 2, "Least privilege between tiers."), o("b", "Put the web servers on the user LAN with a host firewall only", 0, "No network separation."), o("c", "One flat server network, firewall only at the internet edge", 1, "Better than nothing but a compromise moves sideways freely.")]),
        S("nat", "Where is NAT?", [o("a", "Destination NAT for the application's public address at the edge firewall; source NAT for user internet access", 2, "NAT only where the address change is needed."), o("b", "NAT between every pair of zones", 0, "Complicates troubleshooting and logging.")]),
        M("ha", "Resilience and visibility?", [o("a", "Firewall pair in active/standby or active/active with state sync", 1, "Sessions survive failover."), o("b", "Log accepted and dropped flows to a central collector", 1, "Evidence for incidents."), o("c", "Rules written 'any any' to start and tightened later", -1, "Later rarely comes.")]),
      ],
      concepts: [K("dmz", "DMZ or tiered zones", ["dmz", "zone", "tier"]), K("lp", "least privilege between zones", ["least privilege", "deny", "default-deny", "default deny"]), K("ha", "firewall high availability with state sync", ["high availability", "failover", "state sync", "standby", "active/active", "active-active"]), K("log", "central logging", ["log", "siem", "collector"]), K("nat", "NAT only where needed", ["dnat", "snat", "nat"])],
      model: "Zones for internet, DMZ, app servers and users, default-deny between zones, destination NAT for the published service and source NAT for users, firewalls in HA with state sync and central logs." },

    // ------------------------------------------------------------------ level 3
    { id: "leafspine-size", level: 3, topic: "Data centre", title: "Leaf-spine sizing and oversubscription",
      brief: "A data centre needs 48 racks, each with 40 servers at 25 Gb/s. Leaf switches have 48 x 25G ports and 8 x 100G uplinks; spine switches have 32 x 100G ports. Target oversubscription at the leaf is 3:1 or better.",
      decisions: [
        S("over", "Leaf oversubscription with all 8 uplinks used and 40 server ports?", [o("a", "1000 G down : 800 G up = 1.25:1", 2, "40 x 25G = 1000G, 8 x 100G = 800G."), o("b", "5:1", 0, "Check the arithmetic: 1000G over 800G."), o("c", "Non-blocking 1:1", 0, "Server capacity (1000G) is larger than uplink capacity (800G), so it cannot be 1:1.")]),
        S("spines", "Every leaf has 8 uplinks and a spine has 32 ports. How do you build the spine layer for 48 leaves?", [o("a", "8 spines, one link from every leaf to every spine", 0, "Each spine would need 48 leaf ports, but it has only 32."), o("b", "Two pods of 24 leaves, each pod with 8 spines (24 ports to leaves, 8 left for uplinks), joined by a super-spine layer", 2, "24 + 8 = 32 ports per spine, and any leaf reaches any other through the super-spine."), o("c", "4 spines with two links from each leaf to each spine", 0, "Each spine would need 96 leaf ports.")]),
        M("good", "Which design choices are sound?", [o("a", "Equal-cost multipath across all uplinks", 1, "Uses every spine path."), o("b", "Same ASN scheme and addressing pattern on every leaf, scripted", 1, "Repeatable builds."), o("c", "Connect leaf to leaf for shortcuts", -1, "Breaks the predictable two-hop path."), o("d", "Size for current need only and re-cable when needed", -1, "Cabling is the expensive part: plan the final scale.")]),
      ],
      concepts: [K("ecmp", "ECMP", ["ecmp", "equal-cost", "equal cost"]), K("over", "oversubscription ratio calculation", ["oversub", "1.25", "ratio"]), K("pod", "pods or super-spine for scale", ["pod", "super-spine", "superspine", "5-stage", "five-stage"]), K("auto", "repeatable, scripted pattern", ["script", "template", "automat", "repeat"]), K("plan", "plan for final scale", ["scale", "growth", "future"])],
      model: "Oversubscription is 1000G:800G = 1.25:1. With 48 leaves x 8 uplinks and 32-port spines you need 384 spine ports, so use pods (leaf and spine groups) joined by a super-spine, or larger spines, and keep the wiring pattern identical and scripted." },

    { id: "bgp-policy", level: 3, topic: "Routing", title: "BGP policy with communities",
      brief: "A service provider has customers, peers and upstream transit. It must stop leaks (peer routes announced to another peer or transit) and let customers influence local preference with communities.",
      decisions: [
        S("tag", "How do you stop leaks?", [o("a", "Tag routes on ingress by relationship (customer, peer, transit) with communities, and on egress export to peers and transit only routes tagged customer or own", 2, "Valley-free routing by policy."), o("b", "Trust neighbours to send only valid prefixes", 0, "Mistakes and attacks happen."), o("c", "Use only AS-path filters on egress", 1, "Helps, but is hard to maintain and miss-prone.")]),
        S("lp", "Preference order inbound?", [o("a", "Customer over peer over transit (highest local-pref to customer)", 2, "Customers pay, so their traffic goes over their link; transit costs money."), o("b", "Transit over customer", 0, "Cost and policy are reversed.")]),
        M("tools", "What strengthens the edge?", [o("a", "Prefix lists built from IRR/RPKI data for customers", 1, "Only accept what they own."), o("b", "RPKI origin validation, reject invalid", 1, "Stops many hijacks."), o("c", "Max-prefix limits", 1, "Contains accidents."), o("d", "Accept any prefix length from customers", -1, "Allows deaggregation and more specifics than intended.")]),
      ],
      concepts: [K("comm", "communities for tagging", ["communit"]), K("valley", "no leak between peers and transit", ["leak", "valley", "transit"]), K("lp", "local-pref by relationship", ["local-pref", "local pref", "localpref"]), K("rpki", "RPKI or IRR filtering", ["rpki", "irr", "roa"]), K("maxp", "max-prefix", ["max-prefix", "maximum-prefix", "max prefix"])],
      model: "Ingress tagging by relationship, local-pref customer > peer > transit, egress to peers and transit only for customer and own routes, customer prefix-lists from IRR, RPKI invalid rejected, max-prefix on every session." },

    { id: "fast-converge", level: 3, topic: "Routing", title: "Fast convergence without instability",
      brief: "A bank's WAN takes 40 seconds to recover from a link failure. The target is under one second for single failures without flapping on noisy links.",
      decisions: [
        S("detect", "Failure detection?", [o("a", "BFD on routed links, with timers tuned to the link quality, plus carrier-delay or dampening on flaky links", 2, "Sub-second detection that does not amplify noise."), o("b", "Lower OSPF dead interval to 1 second everywhere", 1, "Works but is heavy on CPUs and fragile."), o("c", "Wait for the hello timers", 0, "That is the 40 seconds.")]),
        S("repair", "Repair?", [o("a", "ECMP plus fast-reroute (IP FRR / LFA or BGP PIC) so a backup is pre-installed", 2, "Forwarding switches in milliseconds before the control plane converges."), o("b", "Only rely on a full SPF and RIB recomputation", 0, "Slow at scale.")]),
        M("safe", "Which stability controls?", [o("a", "SPF and LSA throttling with exponential backoff", 1, "Stops a storm during a flap."), o("b", "Interface dampening on unstable links", 1, "Keeps a bad link out until it is stable."), o("c", "Graceful restart or NSF for planned control-plane events", 1, "Keeps forwarding during a supervisor switch-over."), o("d", "Set every timer to its minimum", -1, "Instability and CPU load.")]),
      ],
      concepts: [K("bfd", "BFD", ["bfd"]), K("frr", "pre-computed backup (LFA, FRR, PIC)", ["lfa", "frr", "fast reroute", "fast-reroute", "pic"]), K("ecmp", "ECMP", ["ecmp", "equal-cost", "equal cost"]), K("throttle", "SPF throttling or dampening", ["throttl", "dampen", "backoff"]), K("gr", "graceful restart", ["graceful", "nsf"])],
      model: "BFD with tuned timers, ECMP plus LFA/PIC pre-installed backups, SPF/LSA throttling, dampening for flapping links, graceful restart for planned events." },

    // ------------------------------------------------------------------ level 4
    { id: "evpn-irb", level: 4, topic: "Data centre", title: "EVPN-VXLAN: symmetric or asymmetric IRB",
      brief: "A multi-tenant fabric has 60 leaves, 200 VLANs and 40 tenants. Tenants must be isolated at layer 3. Hosts move between racks.",
      decisions: [
        S("irb", "Routing model?", [o("a", "Symmetric IRB: a VRF per tenant with an L3 VNI, so each leaf carries only the VLANs it hosts", 2, "Scales: no leaf needs every VLAN."), o("b", "Asymmetric IRB: every VLAN and SVI on every leaf", 0, "Works in small fabrics but every leaf must learn every MAC and VLAN."), o("c", "Route on an external firewall for every inter-VLAN flow", 1, "Valid for a compliance reason, but a bottleneck and hairpin.")]),
        S("gw", "Default gateway?", [o("a", "Distributed anycast gateway with the same IP and MAC on every leaf", 2, "Hosts keep their gateway when they move."), o("b", "VRRP per VLAN", 0, "Unneeded state and hairpinning.")]),
        S("rt", "Prefix routes?", [o("a", "EVPN type-5 for external and tenant prefixes; type-2 for host MAC/IP", 2, "Right route types for each job."), o("b", "Redistribute everything into the underlay", 0, "Loses tenant isolation.")]),
        M("keep", "Operational needs?", [o("a", "ARP suppression", 1, "Cuts ARP flooding across the fabric."), o("b", "Route-reflector or eBGP design for the overlay", 1, "Avoids a full mesh of sessions."), o("c", "Unique route-targets per tenant", 1, "Keeps tenants apart."), o("d", "One route-target for all tenants", -1, "Leaks routes between tenants.")]),
      ],
      concepts: [K("sym", "symmetric IRB", ["symmetric"]), K("l3vni", "L3 VNI per VRF", ["l3vni", "l3 vni", "vrf"]), K("any", "anycast gateway", ["anycast"]), K("t5", "type-5 routes", ["type-5", "type 5", "route-type 5"]), K("rt", "per-tenant route targets", ["route-target", "route target", "route-targets"])],
      model: "Symmetric IRB with a VRF and L3 VNI per tenant, distributed anycast gateway, type-2 for hosts and type-5 for prefixes, per-tenant route-targets, ARP suppression and route reflectors or eBGP on the spines." },

    { id: "multihoming", level: 4, topic: "Data centre", title: "Dual-homing servers: MLAG or EVPN ESI",
      brief: "Servers connect to two leaves with LACP. The fabric is EVPN-VXLAN with multiple vendors. Decide how the dual-homing is built and what to protect.",
      decisions: [
        S("how", "Which technique?", [o("a", "EVPN multihoming (ESI/ES-LAG) where all the leaf vendors support it, otherwise MLAG pairs with a shared VTEP", 2, "Standards-based where it is supported, vendor MLAG where it is not."), o("b", "Active/standby NIC teaming without LACP in every case", 1, "Safe but uses half the bandwidth."), o("c", "Connect each server to one leaf and accept the risk", 0, "Loses the server on a leaf failure.")]),
        S("split", "Failure of the leaf's uplinks to the spines while its server links stay up?", [o("a", "Track the uplinks so the server ports shut or withdraw, forcing traffic to the healthy leaf", 2, "Avoids black-holing."), o("b", "Nothing is needed", 0, "Traffic goes to a leaf with no way out.")]),
        M("risk", "What must be designed?", [o("a", "Designated forwarder election for BUM traffic", 1, "One leaf forwards flooded traffic to the segment."), o("b", "Split-horizon filtering so flooded traffic does not loop back", 1, "Loop prevention for multihomed segments."), o("c", "Same LACP system ID on both leaves", 1, "The server sees one logical partner."), o("d", "Different VLAN-to-VNI mappings per leaf", -1, "The pair must agree.")]),
      ],
      concepts: [K("esi", "ESI or MLAG", ["esi", "mlag", "es-lag", "multihom"]), K("df", "designated forwarder", ["designated forwarder", "df"]), K("sh", "split horizon", ["split horizon", "split-horizon"]), K("track", "uplink tracking", ["track", "uplink fail", "withdraw"]), K("lacp", "shared LACP identity", ["lacp", "system id", "system-id"])],
      model: "ESI multihoming (or MLAG with a shared anycast VTEP where vendors differ), the same LACP system ID, DF election, split-horizon and uplink tracking so a leaf with no spine path stops attracting traffic." },

    { id: "net-automation", level: 4, topic: "Automation", title: "Safe network automation architecture",
      brief: "A team of six manages 400 devices from three vendors with SSH and copy-paste. Two outages came from typos. Design an automation platform that is safe to adopt.",
      decisions: [
        S("truth", "What is the source of truth?", [o("a", "Structured intent in version control (and an IPAM/DCIM for inventory); configs are generated from it", 2, "Intent first; device config is an output."), o("b", "The running configs, scraped nightly", 1, "Records what exists but cannot say what should exist."), o("c", "A shared spreadsheet", 0, "No validation, no history.")]),
        S("change", "How is a change delivered?", [o("a", "Pull request, automated checks (lint, schema, simulation), approval, canary rollout to a few devices, health check, then the rest, with automatic rollback", 2, "Gates catch errors before they reach the fleet."), o("b", "Run the script on all devices at once", 0, "One bug becomes a global outage."), o("c", "Run per device by hand with a checklist", 1, "Slow and error-prone but safe per device.")]),
        M("prin", "Which principles matter?", [o("a", "Idempotent tasks: running twice changes nothing the second time", 1, "Safe to retry."), o("b", "Dry run and diff before commit (for example commit-confirm or candidate config)", 1, "See the change before it lands."), o("c", "Vendor-neutral data model with per-vendor templates", 1, "One model, many outputs."), o("d", "Store device passwords in the repository", -1, "Use a secrets manager."), o("e", "Give the pipeline permanent full admin on every device", -1, "Scope credentials and log every action.")]),
      ],
      concepts: [K("sot", "source of truth", ["source of truth", "intent", "ipam", "netbox"]), K("vcs", "version control and review", ["git", "pull request", "version control", "review"]), K("canary", "canary rollout", ["canary", "staged", "phased"]), K("idem", "idempotency", ["idempot"]), K("rb", "rollback or commit-confirm", ["rollback", "roll back", "commit confirm", "commit-confirm", "revert"]), K("sec", "secrets and scoped access", ["secret", "vault", "least privilege", "scoped"])],
      model: "Intent in Git plus an inventory, templates generate vendor configs, CI validates and simulates, reviewed merge, canary rollout with health checks and automatic rollback, idempotent tasks, secrets in a vault and scoped, logged credentials." },

    // ------------------------------------------------------------------ level 5
    { id: "multisite-dci", level: 5, topic: "Data centre", title: "Multi-site data-centre interconnect and failure domains",
      brief: "Three data centres each run an EVPN-VXLAN fabric. Some applications need layer-2 adjacency between sites, most do not. A failure in one site must not take down the others.",
      decisions: [
        S("model", "Interconnect model?", [o("a", "Separate fabrics (own underlay and overlay AS) joined by border gateways with EVPN multi-site; stretch only the VLANs that need it, route the rest", 2, "Each site is its own failure domain; stretch is the exception."), o("b", "One giant stretched fabric across all sites", 0, "One control-plane or flooding fault hits every site."), o("c", "Layer-2 over a dark-fibre trunk and spanning tree", 0, "A spanning-tree event crosses all sites.")]),
        S("flood", "BUM traffic across sites?", [o("a", "Contain it: ARP suppression, no unknown-unicast flooding between sites, rate limits at the border gateways", 2, "Prevents a broadcast storm from spreading."), o("b", "Flood everywhere for simplicity", 0, "Storms travel.")]),
        S("dgw", "For stretched subnets, where do hosts exit?", [o("a", "Local exit through the anycast gateway at the nearest site, with host routes (type-2/5) so return traffic comes back to the right site", 2, "Avoids tromboning over the interconnect."), o("b", "Always exit at the primary site", 0, "Latency and a failure dependency.")]),
        M("sec", "What else?", [o("a", "Encrypt the interconnect (MACsec or IPsec) if leased capacity is shared", 1, "Protects data on third-party links."), o("b", "Per-site limits for MAC and route counts", 1, "Contains a leak or loop."), o("c", "Active-active quorum of the controller or source of truth across sites", 1, "Operations survive a site loss."), o("d", "Share one route-target space blindly between sites", -1, "Needs a plan or tenants leak.")]),
      ],
      concepts: [K("fd", "failure domains", ["failure domain", "blast radius", "isolat"]), K("ms", "multi-site or border gateways", ["multi-site", "multisite", "border gateway", "bgw"]), K("bum", "controlling BUM and ARP", ["bum", "arp suppress", "flood", "storm"]), K("local", "local exit, no tromboning", ["local exit", "tromb", "hairpin"]), K("enc", "encryption of shared links", ["macsec", "ipsec", "encrypt"])],
      model: "Independent fabrics with border gateways (EVPN multi-site), stretch only what needs it, contain BUM and ARP, local exit with host routes, limits on MAC and route counts, encrypted links and a controller or source of truth that survives a site loss." },

    { id: "migrate-evpn", level: 5, topic: "Data centre", title: "Zero-downtime migration to an EVPN fabric",
      brief: "A production data centre runs a spanning-tree, VLAN-based network with a pair of core switches. You must migrate 500 servers to a new EVPN-VXLAN fabric without a maintenance window that stops the business.",
      decisions: [
        S("plan", "Approach?", [o("a", "Build the new fabric in parallel, extend the old VLANs into it at layer 2 through a pair of redundant transition links, migrate workloads in small groups, move gateways last, then retire the old core", 2, "Reversible at every step."), o("b", "Big-bang cutover on a weekend", 0, "No rollback if something is wrong."), o("c", "Migrate gateways first, then the servers", 1, "Moves the risky part before the workloads can follow.")]),
        S("loop", "The transition links?", [o("a", "A single, controlled attachment point (MLAG pair or one border pair) with spanning-tree boundaries understood and tested", 2, "More than one attachment point makes a loop."), o("b", "Many links between old and new for redundancy", 0, "Many layer-2 interconnects invite a loop.")]),
        M("check", "Before each wave?", [o("a", "Pre-checks: baseline state, ARP/MAC counts and path tests recorded", 1, "You can prove nothing broke."), o("b", "A tested rollback per wave, with a time limit to decide", 1, "A plan to go back, written before the change."), o("c", "Change freeze on unrelated work", 1, "Fewer variables."), o("d", "Migrate the most critical systems first to prove it works", -1, "Start with low-risk workloads.")]),
      ],
      concepts: [K("par", "parallel build", ["parallel", "side by side", "side-by-side"]), K("wave", "small waves", ["wave", "small group", "phase", "batch"]), K("rb", "rollback", ["rollback", "roll back", "revert", "back out"]), K("loop", "avoiding layer-2 loops", ["loop", "single attach", "spanning"]), K("base", "baseline and verification", ["baseline", "verify", "pre-check", "precheck", "validate"]), K("gw", "gateways moved last", ["gateway"])],
      model: "Parallel fabric, one controlled L2 attachment, workloads in waves from low to high risk with baselines and a tested rollback each time, gateways moved last, old core retired when empty." },

    { id: "incident-redesign", level: 5, topic: "Troubleshooting", title: "After the outage: redesign for blast radius",
      brief: "A routing change on one WAN edge router withdrew a summary and sent traffic of twelve sites into a black hole for 90 minutes. Monitoring showed green because the interfaces were up. What do you change?",
      decisions: [
        S("mon", "Monitoring?", [o("a", "Monitor service outcomes (synthetic probes between sites, path and route-count checks), not only interface state", 2, "Detects black holes that look healthy."), o("b", "Shorten SNMP polling to 10 seconds", 0, "Faster polling of the wrong thing."), o("c", "Add more interface alerts", 0, "Interfaces were up.")]),
        S("change", "Change safety?", [o("a", "Pre-change validation (route and policy diff, simulation), staged rollout and automatic rollback if probes fail", 2, "Stops a bad change from becoming an outage."), o("b", "Ban changes during business hours", 1, "Reduces exposure but does not make changes safe.")]),
        S("design", "Design to limit blast radius?", [o("a", "Avoid single summaries as the only path: dual-origin the summary, add a floating/backup route with a worse metric, and split sites across edge pairs", 2, "A failure of one router no longer isolates every site."), o("b", "Keep the single summary but alert faster", 0, "The black hole still exists.")]),
        M("process", "Process?", [o("a", "Blameless post-incident review with action items tracked to closure", 1, "Learning, not blame."), o("b", "Maintain a runbook for the failure with tested steps", 1, "Faster recovery next time."), o("c", "Punish the engineer who made the change", -1, "Drives errors out of sight.")]),
      ],
      concepts: [K("syn", "synthetic probes", ["synthetic", "probe", "ping mesh", "end-to-end", "end to end"]), K("pre", "pre-change validation", ["validat", "simulat", "diff", "pre-change"]), K("rb", "automatic rollback", ["rollback", "roll back", "revert"]), K("blast", "blast radius", ["blast", "failure domain", "isolat"]), K("pir", "blameless review", ["blameless", "post-incident", "post incident", "review"]), K("redund", "redundant origin of the summary", ["dual", "backup", "redundan", "floating"])],
      model: "End-to-end synthetic monitoring, pre-change validation and staged rollout with automatic rollback, no single summary origin (a backup route with a worse metric, sites split across edge pairs) and a blameless review with tracked actions." },
  ];

  // ---- grading
  function maxOf(d) { return d.kind === "single" ? Math.max.apply(null, d.options.map((x) => x.pts)) : d.options.filter((x) => x.pts > 0).reduce((n, x) => n + x.pts, 0); }
  function gradeDecision(d, pick) {
    const picks = d.kind === "single" ? (pick ? [pick] : []) : Array.isArray(pick) ? pick : [];
    const sel = d.options.filter((x) => picks.indexOf(x.id) >= 0);
    const raw = sel.reduce((n, x) => n + x.pts, 0), max = maxOf(d), got = Math.max(0, Math.min(max, raw));
    return { id: d.id, got, max, picked: sel.map((x) => x.id), full: got === max && (d.kind === "single" || sel.every((x) => x.pts > 0)) };
  }
  // a short term must stand alone as a word (so "ha" never matches "that"); a longer one may be the start of a word ("summar" for "summarise")
  function hasWord(low, w) { const t = w.trim(); if (!t) return false; const e = t.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&"); return new RegExp("(^|[^a-z0-9])" + e + (t.length <= 4 ? "s?($|[^a-z0-9])" : ""), "i").test(low); }
  function grade(c, answer) {
    const a = answer || {}, picks = a.picks || {}, text = String(a.text || "").trim();
    const ds = c.decisions.map((d) => gradeDecision(d, picks[d.id]));
    const got = ds.reduce((n, x) => n + x.got, 0), max = ds.reduce((n, x) => n + x.max, 0), dPct = max ? Math.round((100 * got) / max) : 0;
    const low = text.toLowerCase(), cs = c.concepts.map((k) => ({ id: k.id, label: k.label, hit: low.length > 0 && k.words.some((w) => hasWord(low, w)) }));
    const cPct = Math.round((100 * cs.filter((k) => k.hit).length) / c.concepts.length);
    const words = text ? text.split(/\s+/).length : 0, useText = words >= 25;
    const total = useText ? Math.round(0.7 * dPct + 0.3 * cPct) : dPct;
    const answered = c.decisions.every((d) => (d.kind === "single" ? !!picks[d.id] : true));
    return { decisions: ds, concepts: cs, dPct, cPct, total, useText, answered, pass: answered && total >= 70 };
  }
  const byId = (id) => CASES.find((c) => c.id === id);
  const api = { CASES, grade, byId, maxOf, hasWord };
  root.Designcases = api; if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : globalThis);
