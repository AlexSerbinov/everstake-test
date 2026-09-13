# README visuals

The [English README](../../README.md) and [Ukrainian README](../../README.uk.md) tell the same story. Each diagram has three large steps, short labels and one takeaway. Implementation detail stays in the surrounding prose and linked guides.

| Story | English | Ukrainian |
|---|---|---|
| Build the source library | [Corpus](01-corpus.png) | [Бібліотека джерел](01-corpus-uk.png) |
| Find an answer with evidence | [Answer](02-answer.png) | [Відповідь із доказами](02-answer-uk.png) |
| Handle instructions inside sources | [Protection](03-protection.png) | [Захист](03-protection-uk.png) |

## Regenerate

From the repository root:

```sh
uv run --with opencv-python-headless==5.0.0.93 --with pillow==12.3.0 scripts/docs/render-diagrams.py
```

The command writes six **1600 × 660** PNGs. It needs Python and `uv`, uses no model API and is not part of the TypeScript runtime. [diagram-copy.json](../../scripts/docs/diagram-copy.json) holds both languages; [render-diagrams.py](../../scripts/docs/render-diagrams.py) holds the shared layout. OpenCV draws shapes and arrows; Pillow draws text.

The three colors indicate position in the story: input, processing and result. They do not label entire boxes as code-only or model-only. Every diagram has matching prose and descriptive alt text in both READMEs.

Text-width and image-bound assertions stop rendering on overflow. The renderer uses Arial on macOS or DejaVu Sans on Linux; both need Latin and Cyrillic glyphs. Set `DIAGRAM_FONT` and `DIAGRAM_FONT_BOLD` to explicit font paths for consistent typography. Inspect output after changing a font. The opaque light background preserves contrast in GitHub dark mode.

## Demo screenshot

[demo-ask.png](demo-ask.png) is a real 1440 × 1000 capture of the [hosted Ask page](https://everstate-knowledge-base.89-167-19-222.sslip.io/#ask), taken on 13 September 2026. It shows the question form, not a newly measured answer. The image renderer does not overwrite this screenshot. Both READMEs link it to the live page so readers can see later design changes.

The visual style was inspired by the author's [LiquidityScan README](https://github.com/AlexSerbinov/LiquidityScan). Content was simplified for a first-time reader; diagrams describe the actual application rather than the old prototype plans.
