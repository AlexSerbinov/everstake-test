# Read the YouTube material

**[Open the 18 reviewed transcripts](reviewed/README.md)** to read full conversations with speaker names, roles and clickable video timestamps. No local setup or API key is needed: GitHub renders the Markdown files directly.

| I want to… | Open this | What it contains |
| --- | --- | --- |
| Read a conversation with names and roles | [Reviewed transcripts](reviewed/README.md) | Full dialogue, including turns excluded from search. |
| See the original anonymous speaker labels | [Original transcripts](transcripts/README.md) | 12 saved text exports before speaker attribution. |
| Check which videos were considered | [Inventory](inventory.json) | Discovered video metadata. |
| Check which videos were selected for processing | [Selected batch](selected-batch-2026-09-13.json) | The saved selection for that processing run. |
| Check review status and eligible turn counts | [Review manifest](reviewed/manifest.json) | One record per reviewed recording, with export paths. |
| Inspect the text accepted from those reviews | [Evidence documents](reviewed/documents.json) | Selected testimony prepared for indexing; not the complete dialogue. |
| Check what processing cost | [YouTube cost records](../costs/YouTube/README.md) | Saved transcription and speaker-review usage. |
| Understand how the selection works | [YouTube guide](../../docs/youtube/README.md) | The rules, code and limitations behind these files. |

The files are saved evidence from past runs. A transcript's presence here does not prove it is active in today's database. A `needs_review` recording is readable but stays out of the factual index. Upload dates identify publication, not necessarily recording time or current employment.
