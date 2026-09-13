# System diagrams

The root [README](../../README.md) carries the complete reader-facing explanation. These three diagrams provide visual entry points; detailed operating commands belong in [OPERATIONS.md](../OPERATIONS.md).

| Diagram | What it explains |
|---|---|
| [01 — Corpus](01-corpus.png) | Source admission, crawling, sanitation, duplicate grouping, video evidence and indexing |
| [02 — Answer](02-answer.png) | Corpus-only research, structural checks, support review, repair and distinct outcomes |
| [03 — Refresh](03-refresh.png) | Staging, validation, atomic activation and failed-job recovery |

## Regenerate

From the repository root, with Python and `uv` installed:

```sh
uv run --with opencv-python-headless==5.0.0.93 --with pillow==12.3.0 scripts/docs/render-diagrams.py
```

This installs isolated documentation dependencies and overwrites only the three PNGs. The application remains TypeScript-only. No image-generation API or model call is used.

[render-diagrams.py](../../scripts/docs/render-diagrams.py) is the editable source: OpenCV draws cards and connectors; Pillow renders text. Each image is 1600 × 940. Rendering asserts text width and image bounds, prints file sizes and reports elapsed rendering time. The drawings use an opaque light background so their contrast survives GitHub light and dark themes.

Colors have consistent meanings: green for deterministic code, purple for model steps, blue for stored state, yellow for configuration/limits, red for failure or non-answer outcomes. Hybrid retrieval includes a model-derived query embedding; green denotes the retrieval/ranking operation, not zero provider usage. Some boxes summarize several steps rather than representing a separate deployed service.

The renderer looks for Arial on macOS, then DejaVu Sans on Linux. Set `DIAGRAM_FONT` and `DIAGRAM_FONT_BOLD` to explicit font files for matching typography across machines. Font changes can alter line widths; inspect the output after regeneration. Byte-identical output across different fonts or dependency versions is not promised.

## Editorial rules

- Keep the main path readable left to right. Label repair/failure branches.
- Match mechanisms to current code; use plans and defence notes for explanation, not implementation claims.
- Keep measured counts out of the diagrams so a corpus refresh does not invalidate the artwork.
- Attach every reported metric to its run, corpus or ledger scope.
- Give each embedded image descriptive alt text and an equivalent prose explanation.
- Retain evaluation answers, accounting detail and Part B in their dedicated deliverables rather than copying them into several documents.

Visual reference: the author's [LiquidityScan README](https://github.com/AlexSerbinov/LiquidityScan) and supplied Miro screenshots. These diagrams are newly drawn for this application's actual flow. The saved application screenshot in the README is an existing demo artifact, not a new live test.

Task elapsed time and rendering measurements are recorded separately in [TIME.md](../TIME.md). Rendering time alone does not include research, layout design, writing or review.
