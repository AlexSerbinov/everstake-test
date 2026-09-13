#!/usr/bin/env python3
"""Render README diagrams locally with OpenCV geometry and Pillow typography.

Run: uv run --with opencv-python-headless==5.0.0.93 --with pillow==12.3.0 scripts/docs/render-diagrams.py
Python is a documentation tool only; it is not an application dependency.
"""
from pathlib import Path
import os
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs/images"
OUT.mkdir(parents=True, exist_ok=True)
INK = "#182B3A"
MUTED = "#526574"
COLORS = {"code": "#DDF3ED", "model": "#E9E2FA", "store": "#DBEBFC", "note": "#FFF0C6", "error": "#FAE1DD"}


def font(size, bold=False):
    candidates = [
        os.getenv("DIAGRAM_FONT_BOLD" if bold else "DIAGRAM_FONT", ""),
        f"/System/Library/Fonts/Supplemental/Arial{' Bold' if bold else ''}.ttf",
        f"/usr/share/fonts/truetype/dejavu/DejaVuSans{'-Bold' if bold else ''}.ttf",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


def bgr(color):
    return tuple(int(color[i:i+2], 16) for i in (5, 3, 1))


class Diagram:
    def __init__(self, number, title, subtitle):
        self.canvas = np.full((940, 1600, 3), bgr("#F8FAFB"), dtype=np.uint8)
        self.labels = []
        self.text(52, 34, f"EVERSTATE / SYSTEM NOTES                                      {number} / 03", 19, MUTED, True)
        self.text(52, 83, title, 45, INK, True)
        self.text(54, 146, subtitle, 23, MUTED)
        cv2.line(self.canvas, (54, 198), (1546, 198), bgr("#D8E1E7"), 2, cv2.LINE_AA)

    def text(self, x, y, text, size=24, color=INK, bold=False, max_width=None):
        self.labels.append((x, y, text, size, color, bold, max_width))

    def rect(self, x, y, w, h, color, radius=20):
        c = bgr(color)
        cv2.rectangle(self.canvas, (x+radius, y), (x+w-radius, y+h), c, -1)
        cv2.rectangle(self.canvas, (x, y+radius), (x+w, y+h-radius), c, -1)
        for cx, cy in [(x+radius,y+radius),(x+w-radius,y+radius),(x+radius,y+h-radius),(x+w-radius,y+h-radius)]:
            cv2.circle(self.canvas, (cx,cy), radius,c,-1,cv2.LINE_AA)

    def card(self, x, y, w, h, kind, title, lines):
        self.rect(x+2,y+5,w,h,"#E6EBEF")
        self.rect(x,y,w,h,COLORS[kind])
        self.text(x+23,y+19,title,25,INK,True,w-46)
        for i,line in enumerate(lines):
            self.text(x+23,y+65+i*32,line,21,INK,False,w-46)
        assert 65+(len(lines)-1)*32+29 <= h, title

    def arrow(self, points, label=None, at=None, color=MUTED):
        points = np.array(points, dtype=np.int32)
        cv2.polylines(self.canvas,[points],False,bgr(color),3,cv2.LINE_AA)
        a,b=points[-2],points[-1]
        length=float(np.linalg.norm(b-a))
        start=b+(a-b)*min(24/length,1)
        cv2.arrowedLine(self.canvas,tuple(start.astype(int)),tuple(b),bgr(color),3,cv2.LINE_AA,tipLength=0.6)
        if label:
            self.text(*at,label,21,color,True)

    def footer(self, note):
        self.text(54,829,note,23,INK,True,1490)
        x=54
        for kind,label in [("code","Deterministic code"),("model","Model step"),("store","Stored evidence"),("note","Decision / limit")]:
            self.rect(x,888,16,16,COLORS[kind],4)
            self.text(x+26,884,label,19,MUTED)
            x+=350

    def save(self, name):
        im=Image.fromarray(cv2.cvtColor(self.canvas,cv2.COLOR_BGR2RGB))
        draw=ImageDraw.Draw(im)
        for x,y,text,size,color,bold,width in self.labels:
            face=font(size,bold)
            box=draw.textbbox((x,y),text,font=face)
            if width is not None:
                assert box[2]-x <= width, f"Text overflow: {text}"
            assert box[2] < 1590 and box[3] < 940, text
            draw.text((x,y),text,font=face,fill=color)
        output=OUT/name
        cv2.imwrite(str(output),cv2.cvtColor(np.array(im),cv2.COLOR_RGB2BGR),[cv2.IMWRITE_PNG_COMPRESSION,9])
        print(f"{output.relative_to(ROOT)}: 1600 x 940, {output.stat().st_size:,} bytes")


def corpus():
    d=Diagram("01","From public sources to searchable evidence","Collect once. Preserve provenance. Reuse the same preparation rules on refresh.")
    d.card(54,250,320,180,"note","Configured sources",["Seed URLs + allowed roots","Publisher, authority, reason","Limits per source"])
    d.card(440,250,320,180,"code","Crawl + extract",["robots.txt + host throttling","Text, tables, source dates","Rejected URLs get reasons"])
    d.card(826,250,320,180,"code","Sanitize + group",["Strip AI-directed sentences","Keep a removal audit","Group exact / near copies"])
    d.arrow([(374,335),(440,335)])
    d.arrow([(760,335),(826,335)])
    d.card(1212,250,334,180,"code","Chunk text",["Preserve section context","Keep duplicate provenance","Collapse exact copies only"])
    d.arrow([(1146,335),(1212,335)])
    d.card(54,526,450,216,"model","Video path",["Screen publisher + relevance","Soniox: timed speaker turns","Gemini: speaker / role review","Only eligible testimony is indexed"])
    d.arrow([(504,628),(605,628),(605,476),(985,476),(985,430)],"accepted text",(660,444))
    d.card(1212,526,334,180,"model","Embed chunks",["OpenAI embeddings","Reuse cached vectors","Meter provider usage"])
    d.arrow([(1379,430),(1379,526)])
    d.card(700,570,410,180,"store","SQLite corpus",["Snapshots + dates + URLs","FTS5 chunks + vectors","Version + duplicate groups"])
    d.arrow([(1212,635),(1110,635)])
    d.footer("A downloaded page is evidence of what was observed, not proof that every claim is current.")
    d.save("01-corpus.png")


def answer():
    d=Diagram("02","From a question to a checked answer","The agent researches inside the saved corpus. Code controls what can be returned.")
    d.card(54,257,290,170,"note","Question",["Fact or timeline","Same research route","No fixed answer table"])
    d.card(405,257,350,170,"code","Hybrid retrieval",["FTS5 + vector similarity","Bounded evidence window","URLs, dates, exact passages"])
    d.card(820,257,335,170,"model","Research loop",["search / read / calculate","Compare dates and scope","Propose claims + citations"])
    d.card(1218,257,328,170,"code","Structural checks",["Known evidence IDs","Numbers in cited text","Supported as-of dates"])
    for a,b in [(344,405),(755,820),(1155,1218)]: d.arrow([(a,335),(b,335)])
    d.arrow([(980,257),(980,219),(580,219),(580,257)],"more evidence",(641,221))
    d.card(1126,526,420,180,"model","Support + conflict review",["Retrieve newer / exception passages","Check meaning, scope, currentness","Reject unsupported drafts"])
    d.arrow([(1380,427),(1380,526)])
    d.arrow([(1126,574),(1078,574),(1078,472),(989,472),(989,427)],"repair",(1002,439))
    d.card(607,526,421,180,"code","Answer + source cards",["Value, date, specific source","Trust breakdown after checks pass","Actual events + itemized cost"])
    d.arrow([(1126,650),(1028,650)],"pass",(1048,615))
    d.card(54,526,445,215,"error","Two different outcomes",["Missing evidence: no reliable answer","Provider / limit failure: error","Neither is a supported factual answer","Both remain visible in evaluation"])
    d.footer("Trust Score explains the evidence. It cannot override a failed check or guarantee factual truth.")
    d.save("02-answer.png")


def refresh():
    d=Diagram("03","Refresh safely. Activate only a complete version.","One refresh worker prepares a staged version; activation is a separate, guarded step.")
    d.card(54,264,320,180,"note","Operator trigger",["One source / all / due","Or resume a failed job","No unattended cron enabled"])
    d.card(440,264,345,180,"store","Staging database",["Durable job + prior snapshot","Crawl, clean, group, chunk","Reuse compatible cache"])
    d.card(850,264,330,180,"model","Prepare vectors",["Embed missing chunks","Keep text + vectors aligned","Record calls and failures"])
    d.card(1246,264,300,180,"code","Validate",["Required work complete","Baseline still matches","Ready to activate?"])
    for a,b in [(374,440),(785,850),(1180,1246)]:d.arrow([(a,348),(b,348)])
    d.card(1090,571,456,180,"code","Atomic activation",["Text + vectors + version together","Transaction commits the new corpus","Future questions use the new version"])
    d.arrow([(1400,444),(1400,571)],"success",(1420,484))
    d.card(515,571,453,180,"error","Failed or stale job",["Keep the serving corpus intact","Retain staged work for diagnosis","Resume with the recorded job ID"])
    d.arrow([(1290,444),(1290,500),(755,500),(755,571)],"failure",(948,464))
    d.arrow([(515,659),(408,659),(408,483),(610,483),(610,444)],"resume",(422,619))
    d.card(54,571,290,180,"store","Serving corpus",["Last activated version","Failed work stays staged","Known state for readers"])
    d.arrow([(1318,751),(1318,791),(199,791),(199,751)])
    d.footer("Refresh changes the corpus. A new evaluation run is needed to measure quality on that new version.")
    d.save("03-refresh.png")


if __name__ == "__main__":
    start=time.perf_counter()
    corpus()
    answer()
    refresh()
    print(f"Render elapsed: {time.perf_counter()-start:.3f}s")
