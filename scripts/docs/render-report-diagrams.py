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
    t = s.t
    agent = json.loads((ROOT/'artifacts/evaluation/agent-cdf52dda.json').read_text())
    baseline = json.loads((ROOT/'artifacts/evaluation/mcp-core-v2.json').read_text())
    assert agent['corpusVersion'] == 'corpus-664b2e73d71f'
    d = s.Drawing('report-results', t('Latest full runs: coverage and cost', 'Останні повні прогони: якість і ціна'),
                  t('core-v2: 20 questions · Different evidence and verification budgets',
                    'core-v2: 20 запитань · Різні джерела та бюджети перевірки'), 650)
    d.text(55, 230, t('METHOD', 'МЕТОД'), 20, s.MUTED, True)
    d.text(470, 230, t('PASSED / 20', 'ПРОЙДЕНО / 20'), 20, s.MUTED, True)
    d.text(1290, 230, t('MEAN / QUERY', 'СЕРЕДНЄ / ЗАПИТ'), 20, s.MUTED, True)
    for y, label, run, fill in [(290, t('Research agent', 'Агент-дослідник'), agent, s.GREEN),
                                 (395, t('Captured MCP context', 'Збережений MCP-контекст'), baseline, s.BLUE)]:
        summary = run['summary']
        assert summary['total'] == summary['assessed'] == 20
        d.text(55, y+12, label, 29, bold=True, width=400)
        for i in range(20):
            d.rect(470+i*31, y, 25, 55, fill if i<summary['passed'] else s.RED, r=5, stroke=False)
        d.text(1120, y+12, f"{summary['passed']}/20", 29, bold=True)
        d.text(1290, y+12, f"${summary['knownCostUsd']/20:.6f}", 29, bold=True)
    d.footer(t('Invented-fact cases: agent 1, MCP 0. Separate agent recheck: 2/2 passed.',
               'Випадки вигаданих фактів: агент 1, MCP 0. Окрема повторна перевірка: 2/2.'),
             t('Rechecks do not replace full-run results. Captured MCP context is not autonomous tool selection.',
               'Повтори не замінюють повного прогону. MCP-контекст — не автономний вибір інструментів.'))
    d.save()


if __name__ == '__main__':
    for language in ('en', 'uk'):
        s.LANG = language
        boundaries()
        results()
