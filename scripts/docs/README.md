# Documentation renderers

Python drawing scripts generate the README illustrations from explicit layouts and labels. OpenCV draws the shapes and Pillow renders the text, so diagrams can be revised without a drawing account or model call.

See the [image guide](../../docs/images/README.md) for the shared style and dependencies. `render-folder-guides.py` produces the three English folder diagrams using the same drawing primitives.

`render-report-diagrams.py` produces the English and Ukrainian report figures, with evaluation numbers loaded from saved runs.
