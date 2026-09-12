# Spec: agentic answer layer + live pipeline stream (claude-work)

Shared contract for two parallel workstreams (backend agent loop, frontend). Both must follow it exactly so they meet in the middle.

## Goal

Replace "one retrieval → one prompt" with a small **tool-using agent** that knows its tools and rules, decides what to call, and streams every step to the UI so a human watches the pipeline work ("thinking → searching corpus → reading fact ledger → checking live page → verifying citations → answer"). Existing guarantees stay: only cited sources, as-of date, two "I don't know" gates, instruction stripping, live-page rule.

## Backend (src/ask/agent.ts, src/server/main.ts)

### Endpoints
- `POST /ask` `{question}` → final `AskResult` JSON (unchanged shape + new `steps[]`).
- `POST /ask/stream` `{question}` → `text/event-stream`. Events are JSON lines, `event: <type>` + `data: {...}`:

```
event: stage       data: {"id":"plan","label":"Planning the search","status":"start"|"done"|"skip","ms":123,"detail":{...}}
event: tool_call   data: {"step":2,"tool":"search_corpus","args":{"query":"CEO Everstake","min_year":null},"label":"Searching 2 138 chunks"}
event: tool_result data: {"step":2,"tool":"search_corpus","summary":"14 chunks, best score 0.031","ms":41,"items":[{"n":1,"title":"…","url":"…","date":"2026-09-11","score":0.031}]}
event: note        data: {"text":"Two sources disagree on the CEO; preferring the live company page (2026-09-11) over the 2025 announcement."}
event: final       data: <AskResult>
event: error       data: {"message":"…"}
```
Stage ids, in order (a stage may be skipped): `plan`, `search`, `facts`, `live`, `read`, `answer`, `verify`. `search`/`facts`/`live`/`read` may repeat (the agent loops, max 6 tool calls).

### Tools the agent can call (Gemini function calling; JSON schemas in `src/ask/tools.ts`)
| tool | args | what it does | returns |
|---|---|---|---|
| `search_corpus` | `query`, optional `min_year`, `tiers[]`, `domains[]`, `k` | existing hybrid retrieval + ranking (`retrieve()`), same trace numbers | numbered sources (chunks with url/date/tier/text) |
| `fact_history` | `key` | full ledger for a key, value-diverse, with as_of + url | rows |
| `get_document` | `doc_id` or `url` | full indexed text + metadata (aliases, instructions removed) | document |
| `fetch_live_page` | `url` (allow-list: `everstake.com`, `docs.everstake.com`, `github.com/everstake`; robots respected; 1 h cache in a `live_cache` table) | fetch + extract now, mark `live_page_as_of=today` | extracted text + date |
| `everstake_live_data` | `tool` ∈ {`get_chains`,`get_uptime_metrics`,`get_company_profile`} | calls Everstake's own MCP at `https://mcp.everstake.com` (JSON-RPC) — for *live* numbers only; results are labelled "live, Everstake MCP, not part of the corpus" | data |
| `finish` | `status`, `mode`, `answer`, `as_of`, `citations[]`, `confidence` | ends the loop; validated by the same gates | — |

Rules live in `prompts/agent.md` (system prompt) and are the *only* place the agent learns about tools' purpose, order and caveats; `agents/orchestrator.md` documents it for humans. Max 6 tool calls, then forced `finish`. Every tool call/result is also stored in `questions_log.response.steps` so the non-stream endpoint and the eval see the same trace.

### Guarantees (unchanged, enforced in code, not prompt)
- Sources handed to the model are tagged data (`<source id>`), instruction sentences already stripped at index time.
- `finish.citations` ⊆ sources actually returned by tools during this run, otherwise → `no_reliable_answer` (gate 2).
- No tool results → gate 1.
- Live MCP numbers can be cited only with the label "live, Everstake MCP"; they never override corpus facts about history.
- Provider error → `gate: model_error`.

### Config
`config/kb.yaml` gets `agent: { max_steps: 6, live_fetch_allow: [...], live_cache_minutes: 60, mcp_url: https://mcp.everstake.com }`. Model = `models.answer` (currently `gemini-3.8-flash`); the Gemini function-calling call lives in `src/llm.ts` (`completeWithTools`).

## Frontend (public/)

Single-page, no build, dark/light. Layout inspired by the Codex version's simplicity: **one centred input**, nothing else above the fold until you ask. On submit:

1. A **pipeline panel** appears under the input: a vertical list of steps that fill in live from the SSE stream — each step has an icon, label, elapsed ms, and an expandable detail (e.g. the 14 sources found with score bars; the fact rows; "live page fetched"). Running step pulses; done steps get a check; skipped steps are dimmed. Notes appear as small italic lines between steps.
2. When `final` arrives: the **answer card** slides in above the pipeline (status badge, as-of, confidence, cost), citations `[n]` clickable → source cards in a right column on wide screens, stacked on narrow.
3. Pipeline panel collapses to a one-line summary ("7 steps · 3 tools · 4.2 s · $0.011") that re-expands on click.

Keep the other views (facts timeline, corpus, instructions, eval, settings) but move them behind a small "Explore ▾" menu so the first screen is only the question. Typography: one display font for the question/answer, system font for chrome; a single accent; three tier colours; motion ≤ 250 ms; nothing bounces. The page must look intentional on a shared screen at 1280 px.

`app.js` consumes `/ask/stream` via `fetch` + `ReadableStream` (not `EventSource`, because it is POST). Fallback: if the stream fails, call `/ask`.

## Documentation to update
- `agents/orchestrator.md` — role, tools, order, limits.
- `prompts/agent.md` — the system prompt (rules for choosing tools, when to fetch live, when to stop, how to abstain).
- `README.md` — the pipeline drawing with the stream events.
- `REPORT.md` §2 — one paragraph "agentic layer" + why it is still explainable.
