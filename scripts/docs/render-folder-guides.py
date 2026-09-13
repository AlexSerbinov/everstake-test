#!/usr/bin/env python3
"""Render English folder guides with the shared OpenCV/Pillow diagram style.

uv run --with opencv-python-headless==5.0.0.93 --with pillow==12.3.0 scripts/docs/render-folder-guides.py
"""
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('diagram_style', Path(__file__).with_name('render-diagrams.py'))
style = importlib.util.module_from_spec(spec)
spec.loader.exec_module(style)
Drawing = style.Drawing


def agent():
    d = Drawing('folder-agent', 'What makes the researcher an agent?',
                'Configuration supplies guidance. TypeScript runs the loop and checks its actions.', 980)
    d.paper(65, 250, 390, 155, 'agents/researcher.yaml', ['Prompt and skill paths', 'Research / repair limits'], style.YELLOW)
    d.paper(65, 465, 390, 155, 'prompts/ + skills/', ['How to research', 'How to compare evidence'])
    d.box(590, 285, 430, 195, 'Research loop', ['Loads the configured text', 'Asks the model for an action', 'Stops at configured limits'], style.PURPLE)
    d.box(1120, 285, 405, 195, 'Actions in code', ['Search collected passages', 'Read evidence / calculate', 'Submit an answer'], style.GREEN)
    d.box(650, 650, 630, 150, 'Answer checks', ['Check citations and support; repair if possible', 'Return an answer or an abstention'], style.GREEN)
    d.arrow([(455, 327), (590, 327)])
    d.arrow([(455, 530), (535, 530), (535, 425), (590, 425)])
    d.arrow([(1020, 350), (1120, 350)])
    d.curve([(1320, 480), (1320, 575), (870, 575), (870, 480)])
    d.text(1090, 545, 'Evidence returns', 23, style.MUTED, background=style.BG)
    d.arrow([(740, 480), (740, 650)])
    d.text(600, 583, 'Draft answer', 23, style.MUTED, background=style.BG)
    d.note(65, 680, 440, 'No extra agent service', ['These files configure the same', 'application that handles a question.'])
    d.footer('The model proposes actions; the application implements them.',
             'Changing the YAML tool list alone does not create or authorize a new tool.')
    d.save()


def runtime():
    d = Drawing('folder-runtime', 'One application, clear responsibilities',
                'Folders separate jobs. They do not represent a fleet of deployed services.', 1030)
    d.box(65, 255, 340, 150, 'Browser · web/', ['Shows progress, answers,', 'sources and costs'], style.BLUE)
    d.rect(480, 235, 1055, 660, '#EDF2EB', stroke=False)
    d.text(510, 254, 'TYPESCRIPT SERVER · src/', 21, style.MUTED, True)
    d.box(530, 315, 390, 150, 'API + application', ['Accept requests', 'Connect feature modules'], style.GREEN)
    d.box(1055, 315, 425, 150, 'Answer research', ['Search, read, calculate', 'Check the proposed answer'], style.PURPLE)
    d.box(530, 545, 390, 150, 'Collection workflows', ['Crawl and prepare sources', 'Stage and activate updates'], style.GREEN)
    d.database(1070, 575, 350, 205, 'SQLite', ['Documents and passages', 'Runs and measurements'])
    d.box(65, 545, 340, 150, 'External providers', ['Model generation', 'Embeddings'], style.PURPLE)
    d.arrow([(405, 345), (530, 345)])
    d.arrow([(920, 380), (1055, 380)])
    d.arrow([(715, 465), (715, 545)])
    d.arrow([(920, 620), (1070, 620)])
    d.arrow([(1260, 465), (1260, 575)])
    d.text(1290, 505, 'Find evidence', 21, style.MUTED)
    d.line([(230, 545), (230, 490), (485, 490), (485, 840), (1470, 840), (1470, 465)], '#8570A7', dashed=True)
    d.line([(715, 695), (715, 840)], '#8570A7', dashed=True)
    d.text(750, 812, 'Provider clients serve research and indexing', 23, style.MUTED, background='#EDF2EB')
    d.footer('The UI presents results; server modules own evidence and checks.',
             'Simplified dependency map. Dashed line: external model access through src/providers/.')
    d.save()


def evidence():
    d = Drawing('folder-evidence', 'How to read the saved evidence',
                'A report summarizes a run. Artifacts let you inspect what that run actually produced.', 960)
    d.paper(65, 250, 420, 190, 'Collection records', ['corpus/ and youtube/', 'What was collected or excluded', 'Source and video provenance'], style.BLUE)
    d.paper(65, 525, 420, 190, 'Question set · eval/', ['What the evaluation asks', 'Includes negative cases', 'Test input, not source evidence'], style.YELLOW)
    d.box(615, 360, 350, 190, 'Recorded run', ['A specific corpus version', 'A specific answer mode', 'Its own run identifier'], style.PURPLE)
    d.paper(1090, 245, 430, 205, 'Evaluation records', ['evaluation/ and mcp/', 'Answers, errors and outcomes', 'Available usage measurements'], style.BLUE)
    d.paper(1090, 545, 430, 170, 'Reviewer reports', ['EVAL.md and COST.md', 'Interpretation and limitations'], style.GREEN)
    d.arrow([(485, 345), (545, 345), (545, 415), (615, 415)])
    d.arrow([(485, 610), (545, 610), (545, 485), (615, 485)])
    d.arrow([(965, 425), (1020, 425), (1020, 350), (1090, 350)])
    d.arrow([(1305, 450), (1305, 545)])
    d.note(595, 660, 380, 'demo/ screenshots', ['Show the interface at capture', 'time, not a fresh evaluation.'])
    d.footer('Keep the raw result and the written conclusion connected.',
             'Saved snapshots do not automatically describe the latest live application state.')
    d.save()


if __name__ == '__main__':
    agent()
    runtime()
    evidence()
