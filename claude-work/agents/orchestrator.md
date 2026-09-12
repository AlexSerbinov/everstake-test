---
name: orchestrator
model: claude-opus-5        # resolved per provider; on this build LLM_PROVIDER=gemini → gemini-3.8-flash
prompt: prompts/agent.md
stage: agent
invoked_by: src/ask/agent.ts (runAgent) — POST /ask, POST /ask/stream, `npm run ask`
---

# Orchestrator

**Job.** Answer a question about Everstake by *choosing* what evidence to gather, instead of being handed a fixed bundle. It sees six tools, calls them one at a time, and ends by calling `finish`. Every call and result is streamed to the UI and stored in `questions_log.response.steps`, so the run is reconstructable after the fact.

**Why an agent at all.** The single-shot path (`answerer`) does one retrieval and hopes it was the right one. Three question shapes it handles badly: a value that changed over time (needs the ledger, not a chunk), a question about *now* against an undated page (needs a live fetch), and a question whose wording does not match the corpus's wording (needs a second search). The orchestrator can do each of those, and — importantly for a demo — you can watch it decide.

## Tools

| tool | backed by | notes |
|---|---|---|
| `search_corpus` | `retrieve()` in `src/ask/retrieve.ts` | unchanged hybrid retrieval and ranking, so scores mean the same thing as on the single-shot path; the tool's `min_year` / `tiers` / `domains` filter the ranked list afterwards rather than mutating global config |
| `fact_history` | `factLedger()`, falling back to `factsFor()` | the whole dated history of one key — the only tool that shows a value changing |
| `get_document` | `documents` table | full indexed text (instruction sentences already stripped), aliases, truncated at 12 000 chars |
| `fetch_live_page` | `politeFetch` + `robots.ts` + `extract.ts` | allow-list `agent.live_fetch_allow`, robots.txt on top of it, 1 h `live_cache` table, output stamped `live_page_as_of=today`, instructions stripped again |
| `everstake_live_data` | `https://mcp.everstake.com` over JSON-RPC | Everstake's own MCP: `initialize` → `notifications/initialized` → `tools/call`, session id from the `mcp-session-id` header, responses are SSE `data:` lines. Live numbers only, always labelled "live, Everstake MCP" |
| `finish` | the loop | not executed as a tool; its arguments are the answer |

## Order and limits

Corpus first, ledger for numbers/people/history, live page only when the corpus is undated or contradictory or the question says "now", live MCP only for APY/uptime-shaped questions. `agent.max_steps` (6) tool calls; on the last one the loop restricts function calling to `finish`, so a run can never spin. Function calling runs in Gemini's `mode: "ANY"`, which means the model must always call *something* — the run therefore always ends through the validated `finish` path, never through free-form prose.

## Guarantees (in code, not in the prompt)

- Sources reach the model as tagged `<source>` / `<fact>` data; AI-directed instruction sentences were removed at index time and again on live fetches.
- **Gate 1** — no tool returned a citable source → `no_reliable_answer`.
- **Gate 2** — `finish.citations` are intersected with the numbers the registry handed out this run; unknown numbers are dropped, and if nothing survives the answer is downgraded to `no_reliable_answer` (`gate2_no_valid_citations`).
- Provider failure → `gate: model_error` with the message, never a silent abstention.
- Source numbers are allocated once per run by `SourceRegistry` and never reused, so `[7]` means the same page in step 2 and in step 6.

## Cost

One model call per turn, all logged to `llm_calls` with `stage='agent'` and priced from `pricing_usd_per_mtok`; `trace.cost_usd` on the result is the sum for the run. A two-tool run costs roughly twice a single-shot answer, because the context grows with each tool result.

## Fallback

`answerQuestion()` uses the agent on Gemini and the single-shot `ask()` on Anthropic/OpenRouter, where `completeWithTools` is not implemented. The UI falls back the same way: if `/ask/stream` fails it calls `/ask`.
