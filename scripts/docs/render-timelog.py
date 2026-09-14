"""Draw bilingual time-accounting figures from the historical TIMELOG totals.

OpenCV draws shapes; Pillow renders English and Ukrainian text. These are
reported, rounded human-time totals, not a new measurement of session duration.
Run: uv run --with opencv-python-headless --with pillow scripts/docs/render-timelog.py
"""
from pathlib import Path
import re

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
FONT = next(path for path in [
    Path('/System/Library/Fonts/Supplemental/Arial.ttf'),
    Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'),
] if path.exists())

# Read the reported totals, rather than silently adding rounded daily entries.
rows = [line for line in (ROOT / 'submission_ukr/TIMELOG.md').read_text().splitlines() if line.startswith('|')]
def hours(label):
    row = next(line for line in rows if label in line)
    return float(re.search(r'(\d+(?:\.\d+)?)\s*год', row).group(1))

part_a = hours('Частина A')
part_b = hours('Частина B')
total = hours('Разом')
assert abs(part_a + part_b - total) < 0.01, 'Reported part totals do not match the total.'

for language in ['en', 'uk']:
    def label(english, ukrainian):
        return ukrainian if language == 'uk' else english

    canvas = np.full((840, 1600, 3), (247, 250, 248), dtype=np.uint8)
    captions = []
    def text(x, y, value, size=28):
        captions.append((x, y, value, size))

    text(55, 35, label('EVERSTAKE / HUMAN TIME', 'EVERSTAKE / ЧАС ЛЮДИНИ'), 22)
    text(55, 90, label(f'{total:.1f} hours reported in total', f'{total:.1f} год заявлено загалом'), 48)
    text(55, 165, label('11–13 September 2026. Historical, rounded figures from TIMELOG.',
                         '11–13 вересня 2026. Історичні округлені дані з TIMELOG.'), 29)

    left, top, width = 55, 260, 1490
    split = left + round(width * part_a / total)
    cv2.rectangle(canvas, (left, top), (split, top + 120), (182, 237, 217), -1)
    cv2.rectangle(canvas, (split, top), (left + width, top + 120), (220, 211, 181), -1)
    text(80, 300, label(f'Part A · {part_a:.1f} h', f'Частина A · {part_a:.1f} год'), 36)
    text(55, 415, label(f'Part B: process redesign · {part_b:.1f} h',
                        f'Частина B: зміна процесу · {part_b:.1f} год'), 32)
    text(55, 470, label('Human time includes briefing, reading, review and checking the demo.',
                        'Час людини включає постановку задач, читання, рев’ю та перевірку демо.'), 28)

    cv2.rectangle(canvas, (55, 545), (1545, 700), (232, 234, 233), -1)
    text(80, 572, label('Background agent work is recorded separately.',
                        'Фонову роботу агентів наведено окремо.'), 32)
    text(80, 630, label('It is not added to human hours. Parallel runs do not multiply human time.',
                        'Її не додано до часу людини. Паралельні запуски не множать людські години.'), 27)
    text(55, 752, label('Reported accounting convention; not a new timer or independently audited timesheet.',
                        'Заявлений спосіб обліку, а не новий замір чи незалежно перевірений табель.'), 26)

    rendered = Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB))
    drawing = ImageDraw.Draw(rendered)
    for x, y, value, size in captions:
        font = ImageFont.truetype(str(FONT), size)
        bounds = drawing.textbbox((x, y), value, font=font)
        assert bounds[2] < 1570 and bounds[3] < 820, (value, bounds)
        drawing.text((x, y), value, font=font, fill='#203a39')
    output = ROOT / 'docs/images' / f'timelog-{language}.png'
    assert cv2.imwrite(str(output), cv2.cvtColor(np.array(rendered), cv2.COLOR_RGB2BGR))
    print(output)
