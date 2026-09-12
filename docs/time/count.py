#!/usr/bin/env python3
"""Hands-on time from events.csv.

Rule: two events less than GAP apart belong to one block; a block lasts from its first to
its last event; a block with one event counts MIN. Time when only agents were running
(no events) is not counted — it appears in TIME.md in its own column. Usage:
    python3 docs/time/count.py [events.csv]
"""
import csv, sys, datetime as dt

GAP, MIN = dt.timedelta(minutes=10), dt.timedelta(minutes=5)
TZ = dt.timezone(dt.timedelta(hours=2))  # Europe/Madrid, CEST
path = sys.argv[1] if len(sys.argv) > 1 else __file__.rsplit("/", 1)[0] + "/events.csv"

rows = list(csv.DictReader(open(path)))
times = sorted(dt.datetime.fromisoformat(r["timestamp_utc"].replace("Z", "+00:00")) for r in rows)
blocks, start, last = [], times[0], times[0]
for t in times[1:]:
    if t - last <= GAP: last = t
    else: blocks.append((start, last)); start = last = t
blocks.append((start, last))

total = dt.timedelta()
print(f"{'block (Europe/Madrid)':<28}{'events':>7}{'minutes':>9}")
for s, e in blocks:
    d = max(e - s, MIN); total += d
    n = sum(1 for t in times if s <= t <= e)
    print(f"{s.astimezone(TZ):%Y-%m-%d %H:%M}–{e.astimezone(TZ):%H:%M}{n:>9}{d.total_seconds()/60:>9.0f}")
print(f"\nevents {len(times)}  blocks {len(blocks)}  hands-on total {total.total_seconds()/3600:.1f} h")
