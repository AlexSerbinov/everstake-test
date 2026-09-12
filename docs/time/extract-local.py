#!/usr/bin/env python3
"""Build events.csv from two local sources that are NOT in the repository.

  1. Claude Code session transcripts of this project (one JSON line per event); we keep
     the timestamp of every prompt the human typed or dictated. Agent turns are ignored.
  2. VoiceInk, the dictation app: every voice prompt has a timestamp and a duration.
     Dictations for other projects are dropped by an explicit allow-list of time windows
     (the app has no project tag), see WINDOWS.

Only timestamps leave this script — no prompt text, no transcripts. Run on the author's
machine; reviewers use the committed events.csv with count.py.
"""
import csv, glob, json, os, sqlite3, datetime as dt

OUT = os.path.join(os.path.dirname(__file__), "events.csv")
TZ = dt.timezone(dt.timedelta(hours=2))          # Europe/Madrid, CEST
TRANSCRIPTS = os.path.expanduser("~/.claude/projects/-Users-serbinov-Desktop-projects-personal-everstake-test/*.jsonl")
VOICEINK = os.path.expanduser("~/Library/Application Support/com.prakashjoshipax.VoiceInk/default.store")
APPLE_EPOCH = 978307200

# Local-time windows of work on this assignment. Events outside them are not counted:
# dictations for other projects (the app has no project tag) and the odd stray message.
# Reviewed by hand.
WINDOWS = [
    ("2026-09-11 19:20", "2026-09-11 23:59"),
    ("2026-09-12 11:30", "2026-09-12 11:45"),
    ("2026-09-12 12:40", "2026-09-12 12:44"),
    ("2026-09-12 14:15", "2026-09-12 16:10"),
    ("2026-09-12 16:20", "2026-09-12 23:59"),
]

def in_window(t):
    s = t.astimezone(TZ).strftime("%Y-%m-%d %H:%M")
    return any(a <= s <= b for a, b in WINDOWS)

events = []
for path in glob.glob(TRANSCRIPTS):
    for line in open(path):
        try: o = json.loads(line)
        except ValueError: continue
        if o.get("type") != "user" or o.get("isSidechain"): continue
        c = o.get("message", {}).get("content")
        text = c if isinstance(c, str) else (c[0].get("text", "") if isinstance(c, list) and c and c[0].get("type") == "text" else None)
        # Lines that start with a tag are the harness talking (background-task notifications,
        # system reminders, slash-command echoes), not the human. Counting them would credit
        # the human with time when only agents were running — the exact mistake this avoids.
        if text is not None and not text.lstrip().startswith("<"):
            t = dt.datetime.fromisoformat(o["timestamp"].replace("Z", "+00:00"))
            if in_window(t):
                events.append((t, "claude-code", ""))

db = sqlite3.connect(f"file:{VOICEINK}?mode=ro", uri=True)
for ts, dur in db.execute("select ZTIMESTAMP, ZDURATION from ZTRANSCRIPTION where ZTIMESTAMP + ? >= ?", (APPLE_EPOCH, 1789000000 - 10**6)):
    t = dt.datetime.fromtimestamp(ts + APPLE_EPOCH, dt.timezone.utc)
    if in_window(t):
        events.append((t, "voiceink", str(int(dur or 0))))

events.sort()
with open(OUT, "w", newline="") as f:
    w = csv.writer(f); w.writerow(["timestamp_utc", "source", "dictation_seconds"])
    for t, src, d in events: w.writerow([t.strftime("%Y-%m-%dT%H:%M:%SZ"), src, d])
print(f"{len(events)} events → {OUT}")
