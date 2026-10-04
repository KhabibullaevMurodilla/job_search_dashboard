#!/usr/bin/env python3
"""Export the UK sponsor register job-radar already loads server-side, as a
static JSON file the public dashboard can fetch same-origin.

Why this exists: the client-side dashboard runs entirely in a visitor's
browser with no backend, so it cannot call gov.uk directly -- that site sets
no CORS header allowing cross-origin fetch from a github.io page, and a
browser blocks the request before it ever reaches the network. GitHub
Actions has no such restriction (it isn't a browser), so the register is
fetched here, server-side, once per scan, and published as a plain JSON
file next to roles.json. The dashboard then fetches *that* -- same origin,
no CORS issue -- instead of the real register.

Same [name, rating, route] tuple shape sponsor-check's Chrome extension
already uses for its own cache, so web/lib/scoring.js's entriesToObjects()
reads this file with no translation step.
"""
from __future__ import annotations

import json
from pathlib import Path

from jobradar.sponsor_check import load_registers


def main() -> int:
    registers = load_registers()
    out = {
        reg.country: [[e.name, e.rating or "", e.route or ""] for e in reg.entries]
        for reg in registers
    }
    dest = Path("out/registers.json")
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    total = sum(len(v) for v in out.values())
    print(f"wrote {dest}: {len(out)} register(s), {total} entries total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
