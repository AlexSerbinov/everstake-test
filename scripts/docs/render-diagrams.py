#!/usr/bin/env python3
"""Render the bilingual README diagrams; Python is a documentation dependency only.

uv run --with opencv-python-headless==5.0.0.93 --with pillow==12.3.0 scripts/docs/render-diagrams.py
"""
from pathlib import Path
import json
import os
import time

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/images'
INK = '#182B3A'
MUTED = '#526574'
COLORS = {'source': '#DBEBFC', 'process': '#E9E2FA', 'result': '#DDF3ED'}
WIDTH, HEIGHT = 1600, 660


def font(size, bold=False):
    candidates = [
        os.getenv('DIAGRAM_FONT_BOLD' if bold else 'DIAGRAM_FONT', ''),
        f"/System/Library/Fonts/Supplemental/Arial{' Bold' if bold else ''}.ttf",
        f"/usr/share/fonts/truetype/dejavu/DejaVuSans{'-Bold' if bold else ''}.ttf",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return ImageFont.truetype(candidate, size)
    raise RuntimeError('Set DIAGRAM_FONT and DIAGRAM_FONT_BOLD to fonts with Latin and Cyrillic glyphs.')


def bgr(color):
    return tuple(int(color[i:i + 2], 16) for i in (5, 3, 1))


class Diagram:
    def __init__(self):
        self.canvas = np.full((HEIGHT, WIDTH, 3), bgr('#F8FAFB'), dtype=np.uint8)
        self.labels = []

    def text(self, x, y, text, size, color=INK, bold=False, width=1490):
        self.labels.append((x, y, text, size, color, bold, width))

    def rect(self, x, y, w, h, color, radius=22):
        c = bgr(color)
        cv2.rectangle(self.canvas, (x + radius, y), (x + w - radius, y + h), c, -1)
        cv2.rectangle(self.canvas, (x, y + radius), (x + w, y + h - radius), c, -1)
        for cx, cy in [(x + radius, y + radius), (x + w - radius, y + radius),
                       (x + radius, y + h - radius), (x + w - radius, y + h - radius)]:
            cv2.circle(self.canvas, (cx, cy), radius, c, -1, cv2.LINE_AA)

    def card(self, x, number, kind, title, lines):
        self.rect(x + 2, 250, 440, 220, '#E6EBEF')
        self.rect(x, 245, 440, 220, COLORS[kind])
        self.text(x + 27, 267, number, 22, MUTED, True, 380)
        self.text(x + 27, 309, title, 31, INK, True, 386)
        assert len(lines) <= 2, title
        for i, line in enumerate(lines):
            self.text(x + 27, 371 + i * 39, line, 27, INK, False, 386)

    def arrow(self, start, end):
        cv2.arrowedLine(self.canvas, (start, 355), (end, 355), bgr(MUTED), 4,
                        cv2.LINE_AA, tipLength=0.22)

    def save(self, output):
        im = Image.fromarray(cv2.cvtColor(self.canvas, cv2.COLOR_BGR2RGB))
        draw = ImageDraw.Draw(im)
        for x, y, text, size, color, bold, width in self.labels:
            face = font(size, bold)
            box = draw.textbbox((x, y), text, font=face)
            assert box[2] - x <= width, f'Text overflow: {text}'
            assert box[2] < WIDTH - 25 and box[3] < HEIGHT - 20, text
            draw.text((x, y), text, font=face, fill=color)
        OUT.mkdir(parents=True, exist_ok=True)
        path = OUT / output
        success = cv2.imwrite(str(path), cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR),
                              [cv2.IMWRITE_PNG_COMPRESSION, 9])
        assert success, path
        print(f'{path.relative_to(ROOT)}: {WIDTH} x {HEIGHT}, {path.stat().st_size:,} bytes')


def render(language, entry):
    d = Diagram()
    d.text(54, 35, 'EVERSTATE / KNOWLEDGE BASE', 20, MUTED, True)
    d.text(54, 90, entry['title'], 46, INK, True)
    d.text(54, 159, entry['subtitle'], 28, MUTED)
    for i, (x, kind, card) in enumerate(zip([54, 580, 1106], COLORS, entry['cards']), 1):
        d.card(x, f'0{i}', kind, card['title'], card['lines'])
    d.arrow(494, 578)
    d.arrow(1020, 1104)
    d.text(54, 535, entry['takeaway'], 30, INK, True)
    d.text(54, 585, entry['note'], 25, MUTED)
    suffix = '' if language == 'en' else f'-{language}'
    d.save(f"{entry['file']}{suffix}.png")


if __name__ == '__main__':
    start = time.perf_counter()
    copy = json.loads(Path(__file__).with_name('diagram-copy.json').read_text())
    for language, entries in copy.items():
        for entry in entries:
            render(language, entry)
    print(f'Render elapsed: {time.perf_counter() - start:.3f}s')
