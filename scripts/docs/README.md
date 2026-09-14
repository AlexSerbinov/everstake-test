# Documentation renderers

Python drawing scripts generate the README illustrations from explicit layouts and labels. OpenCV draws the shapes and Pillow renders the text, so diagrams can be revised without a drawing account or model call.

See the [image guide](../../docs/images/README.md) for the shared style and dependencies. `render-folder-guides.py` produces the three English folder diagrams using the same drawing primitives.

`render-report-diagrams.py` produces the English and Ukrainian report figures, with evaluation numbers loaded from saved runs.

The selected submission is pinned in `assistant/config/evaluation-submission.json`. `submission-data.py` validates and calculates its 16/20 pass count and 92.75/100 rubric mean from saved answers. Run `uv run --with opencv-python-headless --with pillow scripts/docs/render-evaluation-comparison.py` to rebuild both README evaluation graphs. Legacy diagram commands use the same renderer. `npm run check` verifies the headline in both READMEs, both REPORTs, both EVAL versions, DEFENCE and MCP comparison against these answers.

`render-reading-guides.py` draws the repository reading map using the same OpenCV/Pillow style. These diagrams explain responsibilities; they do not contain new measurements.

`render-timelog.py` draws English and Ukrainian time-accounting figures from the reported Part A, Part B and overall totals in `submission_ukr/TIMELOG.md`. It preserves the distinction between human time and autonomous agent work; it does not measure new work.
