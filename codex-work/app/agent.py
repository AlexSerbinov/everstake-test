from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Callable

from .api_clients import create_agent_response
from .audit import append_answer
from .config import DB_PATH, ROOT, load_dotenv
from .security import question_injection_reason
from .tools import ToolContext, load_tool_specs

ABSTENTION = "No reliable answer was found in the corpus."
Emit = Callable[[str, dict], None]


def _emit(emit: Emit | None, event: str, payload: dict) -> None:
    if emit:
        emit(event, payload)


def _abstention(reason: str, mode: str) -> dict:
    return {"answer": ABSTENTION, "as_of": None, "citations": [], "sources": [], "sufficient": False, "mode": mode, "reasoning": reason, "usage": {"agent": []}}


def run_agent(question: str, mode: str = "auto", database: Path = DB_PATH, emit: Emit | None = None) -> dict:
    load_dotenv()
    resolved_mode = mode
    if mode == "auto":
        resolved_mode = "synthesis" if re.search(r"how (has|did)|over time|trajectory|shift|changed", question, re.I) else "factual"
    _emit(emit, "thinking", {"message": "Planning a bounded evidence strategy", "mode": resolved_mode})
    injection = question_injection_reason(question)
    if injection:
        result = _abstention(injection, resolved_mode)
        _emit(emit, "verification", {"status": "blocked", "message": injection})
        receipt = append_answer(question, result, [], [{"guard": "question_injection", "result": injection}])
        result["audit"] = receipt
        _emit(emit, "answer", result)
        return result

    context = ToolContext(database)
    specs = load_tool_specs()
    instructions = (ROOT / "prompts/agent-system.txt").read_text()
    inputs = [{"role": "user", "content": [{"type": "input_text", "text": f"MODE: {resolved_mode}\nQUESTION: {question}"}]}]
    usage: list[dict] = []
    submitted: dict | None = None
    for turn in range(6):
        response, turn_usage = create_agent_response(instructions, inputs, specs)
        usage.append(turn_usage)
        calls = [item for item in response.get("output", []) if item.get("type") == "function_call"]
        if not calls:
            break
        call = calls[0]
        name = call.get("name", "")
        try:
            arguments = json.loads(call.get("arguments") or "{}")
        except json.JSONDecodeError:
            arguments = {}
        if name == "submit_answer":
            submitted = arguments
            break
        _emit(emit, "tool_call", {"tool": name, "arguments": arguments})
        try:
            tool_result = context.execute(name, arguments)
        except Exception as error:
            tool_result = {"error": f"{type(error).__name__}: tool unavailable"}
            context.trace.append({"tool": name, "arguments": arguments, "result": tool_result})
        _emit(emit, "tool_result", {"tool": name, **context.trace[-1]["result"]})
        inputs.extend(response.get("output", []))
        inputs.append({"type": "function_call_output", "call_id": call["call_id"], "output": json.dumps(tool_result, ensure_ascii=False)})

    result = _validate_submission(submitted, context, resolved_mode)
    result["usage"] = {"agent": usage, "estimated_cost_usd": round(sum(item["cost_usd"] for item in usage), 8)}
    _emit(emit, "verification", {"status": "passed" if result["sufficient"] else "abstained", "message": result["reasoning"], "evidence_count": len(result["sources"])})
    cited = [context.evidence[ref].audit_dict() for ref in result["citations"]]
    receipt = append_answer(question, result, cited, context.trace)
    result["audit"] = receipt
    _emit(emit, "answer", result)
    return result


def _validate_submission(submitted: dict | None, context: ToolContext, mode: str) -> dict:
    if not submitted:
        return _abstention("The agent stopped without a verifiable final submission.", mode)
    refs = []
    for value in submitted.get("citations", []):
        if isinstance(value, str) and value in context.evidence and value not in refs:
            refs.append(value)
    sufficient = bool(submitted.get("sufficient")) and bool(refs) and submitted.get("answer") != ABSTENTION
    if mode == "synthesis" and len({context.evidence[ref].url for ref in refs}) < 2:
        sufficient = False
    if not sufficient:
        return _abstention("Available evidence did not satisfy the citation and sufficiency contract.", mode)
    dates = [context.evidence[ref].date for ref in refs]
    sources = [{"ref": ref, "title": context.evidence[ref].title, "url": context.evidence[ref].url, "date": context.evidence[ref].date, "provenance": context.evidence[ref].provenance, "content_sha256": sha256} for ref in refs for sha256 in [context.evidence[ref].audit_dict()["content_sha256"]]]
    return {
        "answer": str(submitted.get("answer", "")).strip(),
        "as_of": str(submitted.get("as_of") or max(dates))[:10],
        "citations": refs,
        "sources": sources,
        "sufficient": True,
        "mode": mode,
        "reasoning": str(submitted.get("reasoning", "Evidence references passed deterministic validation."))[:500],
    }
