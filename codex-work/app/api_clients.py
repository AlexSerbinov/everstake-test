"""Every outbound call to a paid model API, and the cost ledger that tracks them.

Pipeline position: used from both halves. `embed` serves indexing and query-time
retrieval; `create_agent_response` drives each turn of the tool loop in `app/agent.py`;
`generate_json` is the legacy single-shot RAG path kept as an alternate evaluation path.

Two things are centralised here on purpose:

* **Cost.** The assignment carries a hard $5 budget, so *every* paid call appends an
  event to `data/run-costs.jsonl` at the moment it happens. Totalling the ledger is the
  only way the figures in REPORT.md can be checked rather than believed.
* **Retries.** One place decides what is worth retrying, so a transient 429 during a
  776k-token index build does not throw the build away.

Written on `urllib` rather than `requests`/an SDK to keep `requirements.txt` down to
beautifulsoup4 + cryptography, which is a reviewable dependency list.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

from .accounting import price_usd, record_provider_step
from .config import COST_LOG, PRICE_TABLE, PRICE_TABLE_COPIED_AT

# List prices in USD per million tokens, copied from the providers' public pricing pages
# at the time of the run (September 2026) and quoted in REPORT.md. Hard-coded rather than
# fetched: the cost ledger must stay reproducible after prices change, so a past run's
# recorded cost keeps meaning what it meant when it was written.
EMBEDDING_MODEL = "text-embedding-3-small"
GENERATION_MODEL = "gemini-3.8-flash"
CHEAP_MODEL = "gemini-3.5-flash-lite"

# HTTP statuses worth trying again: 429 is rate limiting and the 5xx set is the provider
# failing transiently. Everything else (401, 400, 404) is a bug in this code or a bad key
# and will fail identically on a retry, so it is raised immediately.
RETRYABLE_STATUS_CODES = {429, 500, 502, 503, 504}

# Four attempts with 1s, 2s, 4s backoff between them. Long enough to ride out a rate-limit
# window during a bulk embedding run, short enough that a live user request fails visibly
# rather than hanging. Hand-tuned; no measurement backs the exact value.
DEFAULT_RETRIES = 4

# Generous because a bulk embedding batch is genuinely slow, and a truncated request would
# be billed without returning anything.
REQUEST_TIMEOUT_SECONDS = 90

# Upstream error bodies are truncated before being raised: they can be long, and the whole
# message may end up in a log.
ERROR_DETAIL_CHARS = 500

# Embedding width. 512 instead of the model's native 1536 because the corpus is small
# enough that the shorter vector loses nothing measurable while cutting index size and
# the cost of every similarity scan to a third.
EMBEDDING_DIMENSIONS = 512

# Near-zero temperature: this system is graded on repeatability, and a creative
# rephrasing of a cited number is a defect, not variety.
GENERATION_TEMPERATURE = 0.1

# Output ceilings. The legacy path returns one JSON answer object; an agent turn returns
# at most one tool call plus short reasoning, so it needs less. Both are also a cost
# guard — output tokens are the expensive ones (4x input for the agent model).
GEMINI_MAX_OUTPUT_TOKENS = 1200
AGENT_MAX_OUTPUT_TOKENS = 900

# Cost is stored to 10 decimals because a single embedding call can cost a few
# millionths of a dollar, and rounding those to cents would total to zero.
COST_DECIMAL_PLACES = 10


def _post_json(url: str, payload: dict, headers: dict[str, str],
               retries: int = DEFAULT_RETRIES) -> dict:
    """POST JSON and return the parsed response, retrying only what is worth retrying.

    The backoff is `2 ** attempt` seconds — 1, 2, 4 — which is exponential without
    jitter. Jitter would matter with many concurrent clients; here there is one process,
    so the extra machinery would be unexplainable complexity.
    """
    body = json.dumps(payload).encode()
    for attempt in range(retries):
        request = urllib.request.Request(
            url,
            data=body,
            headers={"Content-Type": "application/json", **headers},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            if error.code not in RETRYABLE_STATUS_CODES or attempt == retries - 1:
                raise RuntimeError(
                    f"API request failed ({error.code}): {detail[:ERROR_DETAIL_CHARS]}"
                ) from error
            time.sleep(2 ** attempt)
    # Unreachable while retries >= 1; present so the function has no implicit `None`
    # return path for a caller that passes retries=0.
    raise RuntimeError("API request failed")


def record_cost(operation: str, model: str, input_tokens: int, output_tokens: int,
                usd: float, metadata: dict | None = None, cached_input_tokens: int = 0) -> None:
    """Append one spend event to the ledger.

    Append-only JSONL so concurrent writers cannot lose each other's lines and no run can
    quietly revise an earlier figure. `operation` is what makes the ledger useful after
    the fact: it separates indexing from evaluation from live queries, which is how the
    per-query average in REPORT.md is derived.
    """
    COST_LOG.parent.mkdir(parents=True, exist_ok=True)
    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "operation": operation,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cached_input_tokens": cached_input_tokens,
        "cost_usd": round(usd, COST_DECIMAL_PLACES),
        "provider": PRICE_TABLE[model]["provider"],
        "price_copied_at": PRICE_TABLE_COPIED_AT,
        "metadata": metadata or {},
    }
    with COST_LOG.open("a") as handle:
        handle.write(json.dumps(event) + "\n")


def embed(texts: list[str], operation: str = "query_embedding") -> tuple[list[list[float]], dict]:
    """Turn text into vectors for indexing or for a query.

    Takes a list rather than a single string because the index build embeds in batches,
    and per-item calls would multiply the request overhead across ~776k tokens.
    """
    model = EMBEDDING_MODEL
    wall_start, cpu_start = time.perf_counter(), time.process_time()
    response = _post_json(
        "https://api.openai.com/v1/embeddings",
        {"model": model, "input": texts, "dimensions": EMBEDDING_DIMENSIONS},
        {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
    )
    wall_ms = (time.perf_counter() - wall_start) * 1000
    cpu_ms = (time.process_time() - cpu_start) * 1000
    tokens = int(response.get("usage", {}).get("total_tokens", 0))
    cost = price_usd(model, tokens, 0)
    record_cost(operation, model, tokens, 0, cost, {"items": len(texts)})
    record_provider_step(operation, model, tokens, 0, 0, wall_ms, cpu_ms,
                         {"items": len(texts)})
    # The API does not promise response order, and every embedding is about to be paired
    # positionally with its chunk — a silent reorder would attach each vector to the
    # wrong text, which no test would catch and every retrieval would suffer from.
    ordered = sorted(response["data"], key=lambda item: item["index"])
    return [item["embedding"] for item in ordered], {
        "input_tokens": tokens,
        "cost_usd": cost,
        "model": model,
    }


def generate_json(prompt: str, operation: str = "answer") -> tuple[dict[str, Any], dict]:
    """Single-shot grounded answer — the legacy baseline path, not the deployed one.

    Kept so the first RAG attempt described in REPORT.md can be re-run and compared
    against the agent path. The model id comes from `GEMINI_MODEL` so a comparison run
    can change it without touching code.
    """
    model = os.getenv("GEMINI_MODEL", GENERATION_MODEL)
    key = os.environ["GEMINI_API_KEY"]
    wall_start, cpu_start = time.perf_counter(), time.process_time()
    response = _post_json(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
        {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {
                "temperature": GENERATION_TEMPERATURE,
                # Forcing a JSON mime type is what lets the caller parse the reply
                # instead of scraping fields out of prose.
                "responseMimeType": "application/json",
                "maxOutputTokens": GEMINI_MAX_OUTPUT_TOKENS,
            },
        },
        {},
    )
    wall_ms = (time.perf_counter() - wall_start) * 1000
    cpu_ms = (time.process_time() - cpu_start) * 1000
    usage = response.get("usageMetadata", {})
    input_tokens = int(usage.get("promptTokenCount", 0))
    output_tokens = int(usage.get("candidatesTokenCount", 0)) + int(usage.get("thoughtsTokenCount", 0))
    cached_tokens = int(usage.get("cachedContentTokenCount", 0))
    cost = price_usd(model, input_tokens, output_tokens, cached_tokens)
    metadata = {"thought_tokens": int(usage.get("thoughtsTokenCount", 0))}
    record_cost(operation, model, input_tokens, output_tokens, cost, metadata, cached_tokens)
    record_provider_step(operation, model, input_tokens, output_tokens, cached_tokens,
                         wall_ms, cpu_ms, metadata)
    raw = response["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(raw), {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": cost,
        "model": model,
    }


def create_agent_response(instructions: str, inputs: list[dict], tools: list[dict],
                          tool_choice: str | dict = "auto") -> tuple[dict[str, Any], dict]:
    """Run one Gemini function-calling turn and normalize its output for agent.py.

    One turn per call, with the whole conversation passed back in `inputs`, because the
    loop's turn budget is enforced in `app/agent.py` — a self-driving agent API would put
    that limit on the provider's side where it cannot be audited.
    """
    model = os.getenv("AGENT_MODEL", GENERATION_MODEL)
    declarations = [_gemini_declaration(spec) for spec in tools]
    function_mode = "ANY" if tool_choice == "required" else "AUTO"
    wall_start, cpu_start = time.perf_counter(), time.process_time()
    response = _post_json(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
        {
            "systemInstruction": {"parts": [{"text": instructions}]},
            "contents": inputs,
            "tools": [{"functionDeclarations": declarations}],
            "toolConfig": {"functionCallingConfig": {"mode": function_mode}},
            # No thinkingConfig is sent. In particular, Lite rejects the old
            # thinkingBudget field; omitting the object is the documented off path.
            "generationConfig": {
                "temperature": GENERATION_TEMPERATURE,
                "maxOutputTokens": AGENT_MAX_OUTPUT_TOKENS,
            },
        },
        {"x-goog-api-key": os.environ["GEMINI_API_KEY"]},
    )
    wall_ms = (time.perf_counter() - wall_start) * 1000
    cpu_ms = (time.process_time() - cpu_start) * 1000
    usage = response.get("usageMetadata", {})
    input_tokens = int(usage.get("promptTokenCount", 0))
    thought_tokens = int(usage.get("thoughtsTokenCount", 0))
    output_tokens = int(usage.get("candidatesTokenCount", 0)) + thought_tokens
    cached_tokens = int(usage.get("cachedContentTokenCount", 0))
    cost = price_usd(model, input_tokens, output_tokens, cached_tokens)
    metadata = {"thought_tokens": thought_tokens}
    record_cost("agent_turn", model, input_tokens, output_tokens, cost, metadata, cached_tokens)
    record_provider_step("Model turn", model, input_tokens, output_tokens, cached_tokens,
                         wall_ms, cpu_ms, metadata)
    content = response["candidates"][0]["content"]
    normalized = {
        "output": [
            {
                "type": "function_call",
                "name": part["functionCall"]["name"],
                "arguments": json.dumps(part["functionCall"].get("args", {})),
                "call_id": part["functionCall"].get("id", part["functionCall"]["name"]),
            }
            for part in content.get("parts", []) if "functionCall" in part
        ],
        # Preserve every raw part, including Gemini 3 thoughtSignature, and return it
        # unchanged in the next request. Omitting that signature causes a 400.
        "_content": content,
    }
    return normalized, {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cached_input_tokens": cached_tokens,
        "cost_usd": round(cost, COST_DECIMAL_PLACES),
        "model": model,
    }


def _gemini_declaration(spec: dict) -> dict:
    """Translate the small OpenAI-style declarations on disk to Gemini's schema."""
    return {
        "name": spec["name"],
        "description": spec["description"],
        "parameters": _gemini_schema(spec["parameters"]),
    }


def _gemini_schema(schema: dict) -> dict:
    """Drop OpenAI-only keywords and express nullable scalar types for Gemini."""
    converted: dict[str, Any] = {}
    for key, value in schema.items():
        if key in {"additionalProperties", "strict"}:
            continue
        if key == "type" and isinstance(value, list):
            non_null = [item for item in value if item != "null"]
            converted["type"] = non_null[0]
            converted["nullable"] = "null" in value
        elif key == "properties":
            converted[key] = {name: _gemini_schema(child) for name, child in value.items()}
        elif key == "items":
            converted[key] = _gemini_schema(value)
        else:
            converted[key] = value
    return converted
