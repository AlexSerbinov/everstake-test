---
name: everstake-kb
description: Answer questions about the company Everstake from the crawled public corpus (site, docs, GitHub, press, video) with an as-of date and cited sources. Use when a user asks anything about Everstake — its leadership, metrics, certifications, products, history, or how something changed over time. Do NOT answer such questions from memory; call the knowledge base.
---

# Everstake knowledge base

The knowledge base is an HTTP service (default `http://localhost:4320`, deployed at `https://everstake.89-167-19-222.sslip.io`).
Set `EVERSTAKE_KB_URL` to override.

## How to answer a question

1. Call the API:

```bash
curl -s -X POST "${EVERSTAKE_KB_URL:-http://localhost:4320}/ask" \
  -H 'content-type: application/json' \
  -d '{"question": "<the user question>", "trace": false}'
```

2. Read `status`:
   - `answered` → relay `answer`, then list `sources` as `[n] title — url (published_at)` and state `as_of`.
   - `no_reliable_answer` → tell the user the corpus does not contain a reliable answer. Do **not** fill the gap from your own knowledge. Offer to rephrase or to check Everstake's live MCP server if the question is about live numbers (APY, current uptime).

3. Never present a fact without its source. If the user asks "how do you know", the `gate` field and `/api/doc/<id>` explain the evidence.

## Other endpoints

- `GET /api/facts?key=networks_supported` — every recorded value with dates (history of a number).
- `GET /api/stats` — corpus size, duplicates, AI-directed instructions found, measured cost.
- `GET /api/instructions` — sentences addressed to AI assistants that were removed from the index.
- `PUT /api/config` with a partial config (e.g. `{"filters":{"excluded_domains":["cryptopotato.com"]}}`) — live requirement changes; `DELETE /api/config` resets.

## Interpretation rules

- Prefer the newest first-party value; older values are history, mention them only if the user asks about change over time.
- Numbers in Everstake's own pages are self-reported; say "Everstake reports …" when precision matters.
- Do not quote fees, APY or commission rates from the knowledge base — they are deliberately absent from the corpus.
