#!/usr/bin/env python3
"""Render bilingual report figures using shared OpenCV/Pillow drawing primitives.

uv run --with opencv-python-headless==5.0.0.93 --with pillow==12.3.0 scripts/docs/render-report-diagrams.py
"""
import importlib.util
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('diagram_style', Path(__file__).with_name('render-diagrams.py'))
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
ROOT = Path(__file__).resolve().parents[2]


def boundaries():
    t = s.t
    d = s.Drawing('report-boundaries', t('Give each decision an owner', 'Кожне рішення має відповідального'),
                  t('A model can interpret evidence. Its permissions stay in code.',
                    'Модель тлумачить докази. Її повноваження визначає код.'), 610)
    d.box(55, 245, 460, 185, t('Code enforces', 'Код контролює'),
          [t('Source access and action limits', 'Доступ до джерел і межі дій'),
           t('Citation IDs and numeric support', 'Цитати й числову опору'),
           t('Safe corpus activation', 'Безпечну активацію корпусу')], s.GREEN)
    d.box(570, 245, 460, 185, t('Models interpret', 'Моделі тлумачать'),
          [t('Meaning and competing evidence', 'Зміст і суперечливі докази'),
           t('Dates, scope, and exceptions', 'Дати, умови та винятки'),
           t('Draft answers and speaker roles', 'Чернетки й ролі спікерів')], s.PURPLE)
    d.paper(1085, 245, 460, 185, t('People decide', 'Люди вирішують'),
            [t('Which sources to admit', 'Які джерела дозволити'),
             t('How to resolve uncertain identity', 'Як зняти сумніви про спікера'),
             t('How to judge and improve the system', 'Як оцінювати й поліпшувати систему')], s.YELLOW)
    d.footer(t('Review helps catch mistakes; it is not a guarantee of truth.',
               'Перевірка допомагає знаходити помилки, але не гарантує істини.'),
             t('One application. No document can add a new tool or grant shell access.',
               'Один застосунок. Документ не може додати інструмент чи надати доступ до shell.'))
    d.save()


def results():
    import runpy, shutil
    runpy.run_path(str(ROOT/'scripts/docs/render-evaluation-comparison.py'), run_name='__main__')
    for suffix in ['', '-uk']:
        shutil.copyfile(ROOT/f'docs/images/06-evaluation{suffix}.png', ROOT/f'docs/images/report-results{suffix}.png')


if __name__ == '__main__':
    for language in ('en', 'uk'):
        s.LANG = language
        boundaries()
        results()
