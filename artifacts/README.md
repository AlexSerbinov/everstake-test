# Saved results you can inspect

Start with the readable files below. JSON files preserve the same runs for tools; their run IDs connect costs, answers and reports. These are saved snapshots, not a fresh run of the current code.

| I want to inspect… | Open | What it proves |
|---|---|---|
| A video transcript with names and timestamps | [YouTube recordings](youtube/reviewed/README.md) | What was said and which turns the review admitted |
| The original anonymous transcript | [Raw transcripts](youtube/transcripts/README.md) | Text before speaker review |
| Answers from an evaluation | [Evaluation runs](evaluation/README.md) | Outcomes on the stated questions and corpus |
| The MCP comparison | [MCP runs](mcp/README.md) | Recorded comparison results and available costs |
| Collection and exclusions | [Corpus records](corpus/README.md) | Coverage and exclusion evidence for a saved collection |
| API spending | [Cost ledger](costs/README.md) | Known usage costs and explicitly unknown charges |
| The interface | [Demo captures](demo/README.md) | Appearance at capture time |
| Supporting investigations | [Research records](research/README.md) | Evidence behind a particular investigation |

![How saved evidence supports the reports](../docs/images/folder-evidence.png)

The live SQLite database belongs in ignored `data/`. Editing an artifact does not update that database or re-run an evaluation. Read the root [EVAL](../EVAL.md) and [COST](../COST.md) for the interpretation and measurement boundaries.
