#!/usr/bin/env python3
"""Draw repository reading guides with the existing OpenCV/Pillow primitives.

Run from the repository root with the dependencies documented in docs/images/README.md.
These diagrams show responsibilities, not measured outcomes or separate services.
"""
import importlib.util
from pathlib import Path
import sys

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    'diagram_style', Path(__file__).with_name('render-diagrams.py'))
style = importlib.util.module_from_spec(spec)
spec.loader.exec_module(style)


def repository():
    d = style.Drawing('folder-repository', 'Where should I start reading?',
                      'Choose a question first. Each folder has one place in the explanation.', 1020)
    d.paper(60, 260, 450, 185, '1. See the submission',
            ['README, REPORT, PROCESS', 'EVAL and COST', 'What was built and measured'], style.GREEN)
    d.box(600, 260, 435, 185, '2. Follow the code',
          ['src/ - server and evidence', 'web/ - browser interface', 'assistant/ - model inputs'], style.BLUE)
    d.paper(1120, 260, 420, 185, '3. Check a saved run',
            ['artifacts/ - saved results', 'eval/ - evaluation questions', 'YouTube Markdown transcripts'], style.YELLOW)
    d.arrow([(510, 350), (600, 350)])
    d.arrow([(1035, 350), (1120, 350)])
    d.box(60, 585, 450, 180, 'Run or maintain it',
          ['package.json - local commands', 'deploy/ - container setup', 'scripts/ - operator tools'], style.GREEN)
    d.box(600, 585, 435, 180, 'Understand a decision',
          ['docs/ - guides and diagrams', 'Walkthrough for live changes', 'Links back to actual files'], style.BLUE)
    d.paper(1120, 585, 420, 180, 'Read development history',
            ['docs/review-logs/ - checks', 'docs/plan/ - original plans', 'Historical notes are dated'], style.YELLOW)
    d.line([(820, 445), (820, 585)], style.MUTED, dashed=True)
    d.footer('The root is the hand-in. Folder READMEs are the map beneath it.',
             'History explains development; it is not a second runtime or a new evaluation.')
    d.save()


def youtube():
    d = style.Drawing('folder-youtube', 'From a video to usable evidence',
                      'Keep the full conversation readable. Admit only eligible testimony to search.', 1020)
    d.paper(60, 265, 335, 180, '1. Transcribe',
            ['Soniox transcript', 'Speaker labels', 'Timestamped dialogue'], style.BLUE)
    d.box(450, 265, 335, 180, '2. Review speakers',
          ['Names and roles', 'Dialogue-based identity', 'Uncertain stays unknown'], style.PURPLE)
    d.box(840, 265, 335, 180, '3. Select testimony',
          ['Named company speaker', 'Eligible statement', 'No rejected intervals'], style.YELLOW)
    d.database(1240, 260, 295, 205, '4. Index',
               ['Text and vectors', 'Source timestamps'])
    for left, right in [(395, 450), (785, 840), (1175, 1240)]:
        d.arrow([(left, 355), (right, 355)])
    d.paper(100, 610, 530, 180, 'Keep readable Markdown',
            ['transcripts/ - original dialogue', 'reviewed/ - speaker-reviewed text', 'Open the catalogue, then a recording'], style.BLUE)
    d.box(840, 610, 630, 180, 'Excluded from factual search',
          ['Unknown identities, host questions and third parties', 'Needs-review recordings and rejected assertions', 'Exclusion does not erase the full readable transcript'], style.RED)
    d.arrow([(225, 445), (225, 610)])
    d.arrow([(1005, 445), (1005, 610)], style.MUTED, dashed=True)
    d.footer('A readable transcript and an accepted source are different things.',
             'Speaker review can be wrong. Attribution is not proof that a statement is current or true.')
    d.save()


def search():
    d = style.Drawing('folder-search', 'How the researcher finds evidence',
                      'All passages come from the stored corpus. Ranking finds candidates for later checks.', 1020)
    d.box(60, 365, 320, 150, 'Question', ['Words to search for', 'Meaning to compare'], style.GREEN)
    d.box(480, 245, 410, 175, 'Word search - SQLite FTS',
          ['Find matching saved text', 'No provider call required'], style.BLUE)
    d.box(480, 510, 410, 175, 'Meaning search - vectors',
          ['Embed the question', 'Compare compatible vectors', 'Record the embedding cost'], style.PURPLE)
    d.box(1020, 320, 515, 180, 'Combine and diversify',
          ['Merge positions in both ranked lists', 'Limit repeated content groups', 'Keep room for relevant newer pages'], style.YELLOW)
    d.box(1020, 615, 515, 175, 'Research and answer checks',
          ['Read, compare dates and authority', 'Validate citations and claim support'], style.GREEN)
    d.arrow([(380, 405), (420, 405), (420, 325), (480, 325)])
    d.arrow([(380, 475), (420, 475), (420, 595), (480, 595)])
    d.arrow([(890, 325), (960, 325), (960, 365), (1020, 365)])
    d.arrow([(890, 595), (960, 595), (960, 445), (1020, 445)])
    d.arrow([(1275, 500), (1275, 615)])
    d.footer('High similarity is a reason to inspect a passage, not to believe it.',
             'With no stored vectors, word search still works. Incompatible vector models are an error.')
    d.save()


def costs():
    d = style.Drawing('folder-costs', 'Follow a cost from request to receipt',
                      'A run describes the task. Each provider attempt is recorded before it is sent.', 1020)
    d.box(60, 270, 335, 175, 'Run',
          ['Question, refresh or index', 'May contain child runs', 'One root groups the task'], style.GREEN)
    d.box(470, 270, 450, 175, 'Provider attempt',
          ['Reserve budget, then send', 'Save usage, outcome and price', 'A retry creates another row'], style.PURPLE)
    d.paper(1040, 270, 490, 175, 'Receipt',
            ['Collect child attempts once', 'Sum known charges', 'Count unknown charges separately'], style.BLUE)
    d.arrow([(395, 355), (470, 355)])
    d.arrow([(920, 355), (1040, 355)])
    d.box(60, 610, 560, 175, 'No usage returned?',
          ['Cost remains unknown, not zero', 'A timeout may still be billed', 'A reservation is not a measured charge'], style.YELLOW)
    d.box(800, 610, 730, 175, 'Cost per question or update',
          ['Average only completed runs with no unknown charges', 'Keep failed and unpriced calls in the total ledger', 'Label the 50x index scenario as a forecast'], style.GREEN)
    d.arrow([(555, 445), (555, 530), (340, 530), (340, 610)], style.MUTED, dashed=True)
    d.arrow([(1285, 445), (1285, 610)])
    d.footer('The ledger records spending even when a task fails.',
             'Calculated usage costs are not automatically the provider invoice or total project cost.')
    d.save()


if __name__ == '__main__':
    repository()
    youtube()
    search()
    costs()
