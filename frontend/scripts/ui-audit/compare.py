#!/usr/bin/env python3
"""Compare two sweep result folders. Usage: compare.py <before_dir> <after_dir>"""
import json, sys, collections
b, a = sys.argv[1], sys.argv[2]
def load(d):
    out = []
    for mode in ("public", "mocked"):
        try:
            for r in json.load(open(f"{d}/{mode}-results.json")):
                r["mode"] = mode; out.append(r)
        except FileNotFoundError:
            pass
    return out
def key(r): return (r["mode"], r["route"], r.get("scenario"), r["viewport"])
def metrics(rs):
    ok = [r for r in rs if "fatal" not in r]
    return {
        "combinations": len(rs), "fatal": len(rs) - len(ok),
        "horizontal_overflow": sum(1 for r in ok if r["docOverflow"] > 1),
        "elements_clipped_right": sum(1 for r in ok if r["clipped"]),
        "controls_under_24px": sum(r["smallCriticalCount"] for r in ok),
        "controls_without_name": sum(r["unnamedCount"] for r in ok),
        "pages_with_console_errors": sum(1 for r in ok if r["errors"]),
        "pages_without_h1": sum(1 for r in ok if r["viewport"] == "1366x768" and r["h1"] == 0),
        "distinct_titles": len({r["title"] for r in ok if r["viewport"] == "1366x768"}),
    }
B, A = load(b), load(a)
mb, ma = metrics(B), metrics(A)
print(f"{'metric':32}{'before':>8}{'after':>8}")
for k in mb: print(f"{k:32}{mb[k]:>8}{ma[k]:>8}")
print("\nRemaining horizontal overflow (after):")
for r in A:
    if r.get("docOverflow", 0) > 1: print(f"  {r['viewport']:10} {r['route']} {r.get('scenario') or ''} +{r['docOverflow']}px")
print("\nRemaining clipped-right elements (after):")
for r in A:
    for c in r.get("clipped", [])[:2]: print(f"  {r['viewport']:10} {r['route']} | {c}")
print("\nRemaining controls <24px, unique (after):")
seen = set()
for r in A:
    for s in r.get("smallCritical", []):
        lab = s.rsplit(" ", 1)[0]
        if lab not in seen: seen.add(lab); print(f"  {r['route']} | {s}")
print("\nRemaining unnamed controls, unique (after):")
seen = set()
for r in A:
    for s in r.get("unnamed", []):
        if (r['route'], s) not in seen: seen.add((r['route'], s)); print(f"  {r['route']} | {s}")
print("\nConsole/page errors (after), unique:")
seen = set()
for r in A:
    for e in r.get("errors", []):
        if e not in seen: seen.add(e); print(f"  {r['route']} | {e[:140]}")
