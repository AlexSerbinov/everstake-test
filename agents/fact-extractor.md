---
name: fact-extractor
model: claude-haiku-4-5
prompt: prompts/extract_facts.md
stage: facts
invoked_by: src/index/facts.ts (npm run facts)
---

# Fact extractor

**Job.** Read one canonical document and emit checkable facts from a closed vocabulary of keys (`networks_supported`, `delegators`, `ceo`, `certifications`, …), each with a verbatim quote, an `as_of` date when the text states one, a confidence, and flags (e.g. `malformed_number`).

**Why a cheap model.** ~440 documents × ~1.5k tokens. This is annotation, not reasoning; Haiku 4.5 is 5× cheaper than Opus and the output is validated by a schema and by regex number checks in code.

**What the code adds after the model.** Keys outside the vocabulary are dropped; `as_of` falls back to the document's publication date; numbers that look corrupted (`735,,,,`) are flagged and excluded from answers; every row keeps its `doc_id` so the ledger is always traceable to a URL.

**Result.** The fact ledger (`facts` table, `/api/facts`, UI tab *Facts*): one row per (document, key). Sorted by date it becomes the timeline used for synthesis questions and the primary path for factual lookups.
