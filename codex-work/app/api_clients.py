from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import COST_LOG

EMBEDDING_PRICE_PER_MILLION = 0.02
GEMINI_INPUT_PRICE_PER_MILLION = 0.10
GEMINI_OUTPUT_PRICE_PER_MILLION = 0.40
AGENT_INPUT_PRICE_PER_MILLION = 0.40
AGENT_OUTPUT_PRICE_PER_MILLION = 1.60


def _post_json(url: str, payload: dict, headers: dict[str, str], retries: int = 4) -> dict:
    body = json.dumps(payload).encode()
    for attempt in range(retries):
        request = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json", **headers}, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=90) as response:
                return json.loads(response.read())
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", "replace")
            if error.code not in {429, 500, 502, 503, 504} or attempt == retries - 1:
                raise RuntimeError(f"API request failed ({error.code}): {detail[:500]}") from error
            time.sleep(2 ** attempt)
    raise RuntimeError("API request failed")


def record_cost(operation: str, model: str, input_tokens: int, output_tokens: int, usd: float, metadata: dict | None = None) -> None:
    COST_LOG.parent.mkdir(parents=True, exist_ok=True)
    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(), "operation": operation,
        "model": model, "input_tokens": input_tokens, "output_tokens": output_tokens,
        "cost_usd": round(usd, 10), "metadata": metadata or {},
    }
    with COST_LOG.open("a") as handle:
        handle.write(json.dumps(event) + "\n")


def embed(texts: list[str], operation: str = "query_embedding") -> tuple[list[list[float]], dict]:
    model = "text-embedding-3-small"
    response = _post_json(
        "https://api.openai.com/v1/embeddings",
        {"model": model, "input": texts, "dimensions": 512},
        {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
    )
    tokens = int(response.get("usage", {}).get("total_tokens", 0))
    cost = tokens / 1_000_000 * EMBEDDING_PRICE_PER_MILLION
    record_cost(operation, model, tokens, 0, cost, {"items": len(texts)})
    ordered = sorted(response["data"], key=lambda item: item["index"])
    return [item["embedding"] for item in ordered], {"input_tokens": tokens, "cost_usd": cost, "model": model}


def generate_json(prompt: str, operation: str = "answer") -> tuple[dict[str, Any], dict]:
    model = os.getenv("GEMINI_MODEL", "gemini-2.5-flash-lite")
    key = os.environ["GEMINI_API_KEY"]
    response = _post_json(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}",
        {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json", "maxOutputTokens": 1200},
        },
        {},
    )
    usage = response.get("usageMetadata", {})
    input_tokens = int(usage.get("promptTokenCount", 0))
    output_tokens = int(usage.get("candidatesTokenCount", 0))
    cost = input_tokens / 1_000_000 * GEMINI_INPUT_PRICE_PER_MILLION + output_tokens / 1_000_000 * GEMINI_OUTPUT_PRICE_PER_MILLION
    record_cost(operation, model, input_tokens, output_tokens, cost)
    raw = response["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(raw), {"input_tokens": input_tokens, "output_tokens": output_tokens, "cost_usd": cost, "model": model}


def create_agent_response(instructions: str, inputs: list[dict], tools: list[dict]) -> tuple[dict[str, Any], dict]:
    """Call the Responses API for one bounded agent turn."""
    model = os.getenv("AGENT_MODEL", "gpt-4.1-mini-2025-04-14")
    response = _post_json(
        "https://api.openai.com/v1/responses",
        {
            "model": model,
            "instructions": instructions,
            "input": inputs,
            "tools": tools,
            "tool_choice": "auto",
            "parallel_tool_calls": False,
            "max_output_tokens": 900,
            "store": False,
        },
        {"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
    )
    usage = response.get("usage", {})
    input_tokens = int(usage.get("input_tokens", 0))
    output_tokens = int(usage.get("output_tokens", 0))
    cost = input_tokens / 1_000_000 * AGENT_INPUT_PRICE_PER_MILLION + output_tokens / 1_000_000 * AGENT_OUTPUT_PRICE_PER_MILLION
    record_cost("agent_turn", model, input_tokens, output_tokens, cost)
    return response, {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": round(cost, 10),
        "model": model,
    }
