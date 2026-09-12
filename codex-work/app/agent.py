"""The answer path: guards → bounded tool loop → deterministic validation → audit receipt.

This module is the orchestrator. It owns the order of operations and, more importantly,
the rule that **the model proposes and this file disposes**: the model chooses which
tools to call and drafts an answer, but whether that answer reaches the user is decided
by `_validate_submission`, which is plain Python and cannot be argued with.

Sequence, end to end:
  1. resolve `auto` mode into `factual` or `synthesis`;
  2. refuse questions that try to replace the evidence policy (`app/security.py`);
  3. run at most five evidence turns against the tools in `app/tools.py`;
  4. spend one reserved sixth turn forcing a schema-bound submission if the model drifted;
  5. validate the submission against the evidence actually collected;
  6. append a signed audit record for the outcome, answer or abstention alike;
  7. emit the result, streaming each step to the UI if an emitter was supplied.

If the validation step is wrong, everything downstream is theatre: the audit chain would
faithfully sign a hallucination, and the UI would show a "Verified answer" badge over it.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path
from typing import Callable

from .api_clients import create_agent_response
from .accounting import RunRecorder, active_step_cost, record_code_step
from .audit import append_answer
from .config import DB_PATH, ROOT, load_dotenv
from .security import question_injection_reason
from .tools import ToolContext, load_tool_specs

# The one sentence the system says when it cannot answer. It must be byte-identical
# everywhere, because three separate things compare against it as a literal string:
# `_validate_submission` (so a model cannot pass the abstention off as an answer),
# `app/evaluate.py::verdict` (negative eval cases pass only on the exact text), and
# `app/adversarial_eval.py` (the e2e_abstain case). Rewording it — even the full stop —
# silently turns passing eval cases into failures. It is also a deliberately *bare*
# refusal: prompts/agent-system.txt forbids appending a guessed explanation, because a
# guess attached to a refusal is still a guess.
ABSTENTION = "No reliable answer was found in the corpus."

# Callback used to stream pipeline steps to the browser over SSE. `None` for the
# non-streaming JSON route, which is why every emit goes through `_emit_event`.
Emit = Callable[[str, dict], None]

# Evidence-gathering turns the model gets. Five is the hard budget: each turn is one
# model call plus at most one tool call, so this bounds both latency and cost per
# question. When it runs out, the loop simply stops — there is no "one more try". What
# happens next depends on whether any evidence was collected: if it was, the reserved
# sixth turn below forces a decision on what is in hand; if it was not, validation sees
# no submission and abstains. Hand-tuned to the tool set (search → read → verify → submit
# fits comfortably); no measurement backs the exact value. Documented in REPORT.md.
MAX_EVIDENCE_TURNS = 5

# Synthesis claims a trend, and one page cannot evidence a trend — two chunks of the same
# page even less so, since they are one author writing at one moment. Distinctness is
# measured by URL for that reason. Copied from the declared contract in
# prompts/agent-system.txt and skills/audit-answer.
SYNTHESIS_MIN_DISTINCT_SOURCES = 2

# The model's stated reasoning is shown to the user but is not evidence, so it is capped
# rather than trusted to be brief. Hand-tuned; no measurement backs the exact value.
REASONING_MAX_CHARS = 500

# Phrasings that turn a "how did X change" question into a synthesis question. Matched
# against the raw question in `auto` mode. Examples: "How has the product line changed",
# "How did staking evolve over time", "What was the trajectory". Deliberately narrow —
# a false positive costs the user an answer, because synthesis mode then demands two
# distinct sources that a simple factual question will never produce.
_SYNTHESIS_QUESTION_SHAPE = re.compile(r"how (has|did)|over time|trajectory|shift|changed", re.I)

# Four-digit years from 2000-2099 mentioned in the question, e.g. "since 2024".
_YEAR_IN_QUESTION = re.compile(r"20\d{2}")

# Answers that assert something is absent from the world rather than reporting a fact.
# Examples: "No information is available about the CEO's salary.", "That figure is not
# publicly available.", "The record cannot be found in the corpus.", "That data is private."
_ABSENCE_CLAIM = re.compile(
    r"\b(no information (?:is )?available|there is no information|"
    r"not (?:publicly )?available|not published|cannot be found|is private)\b",
    re.I,
)

# Live tools whose result cannot be improved by asking again in the same question.
_TERMINAL_LIVE_MCP_TOOLS = {"staking_calculator", "get_uptime_metrics"}


def _emit_event(emit: Emit | None, event: str, payload: dict) -> None:
    """Send one SSE event if the caller is streaming, and do nothing if it is not.

    Exists so the main flow never has to branch on whether this is the streaming route
    or the plain JSON one — both take exactly the same code path.
    """
    if emit:
        emit(event, payload)


def _abstention_result(reason: str, mode: str) -> dict:
    """Build the refusal payload, with the same key set as a successful answer.

    Same shape on purpose: the UI, the audit record and the eval runners all read one
    result dict, and a refusal that omitted keys would need special-casing in three
    places. `sufficient: False` plus empty citations is what distinguishes it.
    """
    return {
        "answer": ABSTENTION,
        "as_of": None,
        "citations": [],
        "sources": [],
        "sufficient": False,
        "mode": mode,
        "reasoning": reason,
        # Populated by run_agent when a model was actually called; an empty list here
        # keeps the key present for a refusal issued before any model call.
        "usage": {"agent": []},
    }


def _resolve_mode(mode: str, question: str) -> str:
    """Turn the requested mode into the one the contracts are enforced against.

    Mode is not cosmetic: `synthesis` triggers the two-distinct-sources and year-straddle
    rules below, and widens retrieval. `auto` guesses from the question's shape so a user
    who does not know the modes exist still gets the stricter treatment on a trend question.
    """
    if mode != "auto":
        return mode
    return "synthesis" if _SYNTHESIS_QUESTION_SHAPE.search(question) else "factual"


def run_agent(question: str, mode: str = "auto", database: Path = DB_PATH,
              emit: Emit | None = None) -> dict:
    """Answer one question end to end, and return the result with its audit receipt.

    Every exit from this function — refusal, abstention or answer — goes through
    `append_answer` first. That is the invariant that makes the audit chain complete:
    "the system declined on this date" is as much a claim worth verifying as an answer.
    """
    recorder = RunRecorder("question", "single_question", {"question": question, "mode": mode}).activate()
    try:
        result = _run_agent(question, mode, database, emit)
    except Exception:
        recorder.finish(status="failed")
        raise
    recorder.record["metadata"].update({
        "resolved_mode": result.get("mode"),
        "answer_sufficient": bool(result.get("sufficient")),
    })
    receipt = recorder.finish(items={"questions": 1})
    result["cost_receipt"] = receipt
    _emit_event(emit, "answer", result)
    return result


def _run_agent(question: str, mode: str, database: Path, emit: Emit | None) -> dict:
    """Inner answer flow; the public wrapper guarantees one complete cost receipt."""
    load_dotenv()
    resolved_mode = _resolve_mode(mode, question)
    _emit_event(emit, "thinking", {
        "message": "Planning a bounded evidence strategy",
        "mode": resolved_mode,
    })

    injection = question_injection_reason(question)
    if injection:
        return _refuse_injected_question(question, injection, resolved_mode, emit)

    context = ToolContext(database)
    specs = load_tool_specs()
    # Loaded from disk, not embedded here, so the reviewed prompt is provably the
    # deployed prompt.
    instructions = (ROOT / "prompts/agent-system.txt").read_text()
    inputs: list[dict] = [{
        "role": "user",
        "parts": [{"text": f"MODE: {resolved_mode}\nQUESTION: {question}"}],
    }]

    submitted, usage = _run_evidence_turns(instructions, inputs, specs, context, emit)
    if submitted is None and context.evidence:
        submitted = _force_final_submission(instructions, inputs, specs, usage)

    return _finalise(submitted, context, resolved_mode, question, usage, emit)


def _refuse_injected_question(question: str, injection: str, mode: str,
                              emit: Emit | None) -> dict:
    """Abstain on a question that tried to override the evidence policy.

    Refused before the model is ever called, so the injected text never reaches it —
    and still audited, because a blocked request is exactly the kind of event someone
    will later want proof of.
    """
    result = _abstention_result(injection, mode)
    _emit_event(emit, "verification", {"status": "blocked", "message": injection})
    result["audit"] = append_answer(
        question,
        result,
        [],
        [{"guard": "question_injection", "result": injection}],
    )
    return result


def _run_evidence_turns(instructions: str, inputs: list[dict], specs: list[dict],
                        context: ToolContext, emit: Emit | None) -> tuple[dict | None, list[dict]]:
    """Run the bounded tool loop and return (submission or None, per-turn usage).

    `inputs` is appended to in place: each turn the model sees its own previous output
    plus the tool result. The raw model content is preserved so Gemini 3 function-call
    thought signatures survive the next stateless request (see api_clients.py).
    """
    usage: list[dict] = []
    for _turn in range(MAX_EVIDENCE_TURNS):
        response, turn_usage = create_agent_response(instructions, inputs, specs)
        usage.append(turn_usage)
        calls = [item for item in response.get("output", []) if item.get("type") == "function_call"]
        if not calls:
            # The model answered in prose instead of calling a tool. Stop here; the
            # reserved final turn will force a schema-bound submission.
            break
        submissions = [call for call in calls if call.get("name") == "submit_answer"]
        if submissions:
            return _parse_tool_arguments(submissions[0]), usage

        function_responses = []
        terminal = False
        for call in calls:
            name = call.get("name", "")
            arguments = _parse_tool_arguments(call)
            _emit_event(emit, "tool_call", {"tool": name, "arguments": arguments})
            tool_result = _execute_tool_call(context, name, arguments)
            _emit_event(emit, "tool_result", {"tool": name, **context.trace[-1]["result"]})
            function_response = {
                "name": name,
                "response": {"output": tool_result},
            }
            if call.get("call_id"):
                function_response["id"] = call["call_id"]
            function_responses.append({"functionResponse": function_response})
            terminal = terminal or _is_terminal_live_evidence(name, arguments, tool_result)

        # Gemini 3 requires the model content to be replayed byte-for-byte so every
        # thoughtSignature stays attached to its original functionCall part.
        inputs.append(response["_content"])
        inputs.append({"role": "user", "parts": function_responses})
        if terminal:
            break
    return None, usage


def _parse_tool_arguments(call: dict) -> dict:
    """Decode a tool call's JSON arguments, treating malformed JSON as no arguments.

    Falling back to `{}` rather than raising is deliberate: an empty-argument call
    reaches the tool, fails its own validation, and the error comes back to the model as
    something it can correct on the next turn. Raising here would burn the whole question.
    """
    try:
        return json.loads(call.get("arguments") or "{}")
    except json.JSONDecodeError:
        return {}


def _execute_tool_call(context: ToolContext, name: str, arguments: dict) -> dict:
    """Run one tool, converting any failure into an error result the model can read.

    The exception type is reported but its message is not: a traceback message can carry
    a file path or a URL, and everything returned here is echoed into the signed audit
    record. A failed tool must degrade the answer to an abstention, never crash the request.
    """
    wall_start, cpu_start = time.perf_counter(), time.process_time()
    cost_before = active_step_cost()
    try:
        return context.execute(name, arguments)
    except Exception as error:
        tool_result = {"error": f"{type(error).__name__}: tool unavailable"}
        # `execute` only appends to the trace on success, so a failure has to be
        # recorded here — otherwise the audit trace would omit the call entirely, and
        # the `tool_result` event below would read the previous tool's summary.
        context.trace.append({"tool": name, "arguments": arguments, "result": tool_result})
        return tool_result
    finally:
        record_code_step(
            _plain_tool_name(name),
            (time.perf_counter() - wall_start) * 1000,
            (time.process_time() - cpu_start) * 1000,
            {"tool": name, "nested_provider_cost_usd": round(active_step_cost() - cost_before, 10)},
        )


def _plain_tool_name(name: str) -> str:
    return {
        "corpus_search": "Searching and ranking the corpus",
        "fact_number_lookup": "Reading the fact ledger",
        "document_read": "Reading a source document",
        "live_fetch": "Fetching a live Everstake page",
        "everstake_mcp": "Reading live Everstake data",
    }.get(name, f"Running {name}")


def _is_terminal_live_evidence(name: str, arguments: dict, tool_result: dict) -> bool:
    """Whether this tool result should end the loop immediately.

    A successful staking-calculator or uptime reading is the freshest the system can
    ever get: calling the same live tool again in the same question cannot improve it,
    it only costs a turn, a network round trip and money. Stopping here also reserves
    the next turn for the forced submission. Copied from the stop rule in
    prompts/agent-system.txt.
    """
    return (
        name == "everstake_mcp"
        and arguments.get("tool") in _TERMINAL_LIVE_MCP_TOOLS
        and "error" not in tool_result
    )


def _force_final_submission(instructions: str, inputs: list[dict], specs: list[dict],
                            usage: list[dict]) -> dict | None:
    """Spend the reserved sixth turn making the model commit through the schema.

    Only reached when evidence was collected but no `submit_answer` arrived — the model
    wrote prose, or spent all five turns searching. Offering `submit_answer` as the only
    tool with `tool_choice="required"` means the answer must come back as structured
    fields that `_validate_submission` can check, instead of free text that would bypass
    validation entirely. Appends its own cost to `usage` in place.
    """
    submit_spec = next(spec for spec in specs if spec["name"] == "submit_answer")
    forced, turn_usage = create_agent_response(
        instructions + "\nThis is the final turn. Call submit_answer now; do not call another evidence tool.",
        inputs,
        [submit_spec],
        "required",
    )
    usage.append(turn_usage)
    calls = [
        item for item in forced.get("output", [])
        if item.get("type") == "function_call" and item.get("name") == "submit_answer"
    ]
    if not calls:
        return None
    try:
        return json.loads(calls[0].get("arguments") or "{}")
    except json.JSONDecodeError:
        return None


def _finalise(submitted: dict | None, context: ToolContext, mode: str, question: str,
              usage: list[dict], emit: Emit | None) -> dict:
    """Validate, price, audit and emit the outcome.

    Ordering matters: validation runs before the audit record is written, so the record
    stores the answer the user was actually shown — including when that answer was
    downgraded to an abstention.
    """
    result = _validate_submission(submitted, context, mode, question)
    result["usage"] = {
        "agent": usage,
        # Rounded to 8 decimals because a single turn can cost well under a cent and
        # the total is displayed verbatim in the UI's usage panel.
        "estimated_cost_usd": round(sum(item["cost_usd"] for item in usage), 8),
    }
    _emit_event(emit, "verification", {
        "status": "passed" if result["sufficient"] else "abstained",
        "message": result["reasoning"],
        "evidence_count": len(result["sources"]),
    })
    # Only cited evidence goes into the audit record, at full length. Everything the
    # tools returned but the answer did not use is deliberately left out: the record
    # documents what the answer rests on, not what was browsed.
    cited = [context.evidence[ref].audit_dict() for ref in result["citations"]]
    result["audit"] = append_answer(question, result, cited, context.trace)
    return result


def _validate_submission(submitted: dict | None, context: ToolContext, mode: str,
                         question: str = "") -> dict:
    """The deterministic gate between what the model claims and what the user sees.

    Nothing here consults a model. Every rule is a check the candidate can rerun by hand
    against the evidence set, which is the whole reason a "verified" badge means anything.
    Any failure collapses to the same abstention rather than a partial answer — a claim
    that half-passed its evidence contract is not a weaker answer, it is an unsupported one.
    """
    if not submitted:
        return _abstention_result("The agent stopped without a verifiable final submission.", mode)

    refs = _resolve_citations(submitted.get("citations", []), context)
    answer_text = str(submitted.get("answer", "")).strip()
    if not _passes_sufficiency_contract(submitted, refs, answer_text, mode, context, question):
        return _abstention_result(
            "Available evidence did not satisfy the citation and sufficiency contract.",
            mode,
        )
    return _accepted_result(submitted, refs, answer_text, mode, context)


def _resolve_citations(claimed: list, context: ToolContext) -> list[str]:
    """Keep only the references that name evidence a tool really returned.

    This is what makes a forged citation impossible rather than merely discouraged: an
    `E999` the model invented is not a key of `context.evidence`, so it is dropped, and
    an answer left with no surviving references fails the sufficiency check below.
    Non-string values are rejected outright — the older non-agent path used integer ids,
    and those must not accidentally validate here. Order is preserved because the model's
    citation order is the order the sources are rendered in.
    """
    refs: list[str] = []
    for value in claimed:
        if isinstance(value, str) and value in context.evidence and value not in refs:
            refs.append(value)
    return refs


def _passes_sufficiency_contract(submitted: dict, refs: list[str], answer_text: str,
                                 mode: str, context: ToolContext, question: str) -> bool:
    """Apply every rule an answer must satisfy to be shown as verified."""
    baseline = (
        # The model's own judgement, honoured but never sufficient on its own.
        bool(submitted.get("sufficient"))
        # An answer with no surviving citation is by definition ungrounded.
        and bool(refs)
        # A model that emits the abstention sentence *and* sets sufficient=True would
        # otherwise have it rendered under a "Verified answer" badge. Byte comparison,
        # which is one of the three reasons ABSTENTION must never be reworded.
        and answer_text != ABSTENTION
        and not _claims_absence(answer_text)
    )
    if not baseline:
        return False
    if mode == "synthesis" and not _has_distinct_sources(refs, context):
        return False
    if mode == "synthesis" and not _straddles_requested_years(refs, context, question):
        return False
    return True


def _claims_absence(answer_text: str) -> bool:
    """Whether the answer asserts a fact does not exist, rather than reporting one.

    "X is not published" is itself an unverifiable claim about the world: the corpus not
    containing something is not proof that nothing exists, and the retrieved passages
    cannot entail it. The system must abstain instead of asserting it — that is the same
    rule as skills/negative-answer, enforced here rather than trusted to the prompt.

    KNOWN LIMITATION: the alternation matches the literal string "not published", so the
    passive "has not been published" is *accepted* as a real answer. Pinned in
    tests/test_agent_validation.py::test_a_passive_absence_phrasing_slips_past_the_detector.
    """
    return bool(_ABSENCE_CLAIM.search(answer_text))


def _has_distinct_sources(refs: list[str], context: ToolContext) -> bool:
    """Whether the synthesis answer cites at least two different pages.

    Counted by URL, not by reference: two chunks of one page share a URL and collapse to
    one, which is the point. Otherwise a model could cite `E1` and `E2` from a single
    press release and present it as corroborated. Exercised by the
    `single_source_synthesis` adversarial case.
    """
    return len({context.evidence[ref].url for ref in refs}) >= SYNTHESIS_MIN_DISTINCT_SOURCES


def _straddles_requested_years(refs: list[str], context: ToolContext, question: str) -> bool:
    """Whether a "since YYYY" answer cites evidence from both sides of that year.

    A trend claim needs a before and an after. Without this check, an answer to "how has
    X changed since 2023" could cite only 2026 pages: it would read as temporal while
    evidencing a single point in time, which is precisely the failure the wide-net
    retrieval in tools.py exists to avoid feeding.

    Concretely, with 2023 requested the citations must include at least one item dated
    2023 or earlier (`min(evidence_years) <= 2023`) and at least one dated strictly after
    2023 (`max(evidence_years) > 2023`). Undated evidence is skipped, and if that leaves
    no usable years at all the check fails — an undated trend is not a trend. Only the
    *earliest* year mentioned in the question is used as the baseline, so "from 2023 to
    2026" behaves the same as "since 2023".
    """
    requested_years = [int(value) for value in _YEAR_IN_QUESTION.findall(question)]
    if not requested_years or not refs:
        # No year named, or nothing cited: this contract does not apply. The
        # distinct-sources rule above still does.
        return True
    evidence_years = [
        int(context.evidence[ref].date[:4])
        for ref in refs
        if _YEAR_IN_QUESTION.match(context.evidence[ref].date)
    ]
    if not evidence_years:
        return False
    baseline_year = min(requested_years)
    has_baseline_evidence = min(evidence_years) <= baseline_year
    has_later_evidence = max(evidence_years) > baseline_year
    return has_baseline_evidence and has_later_evidence


def _accepted_result(submitted: dict, refs: list[str], answer_text: str, mode: str,
                     context: ToolContext) -> dict:
    """Assemble the answer payload once every contract has been satisfied.

    Only reachable for an answer that passed validation, so this function contains no
    checks — keeping them all in `_passes_sufficiency_contract` means there is exactly
    one place to look for "why was this rejected".
    """
    dates = [context.evidence[ref].date for ref in refs]
    return {
        "answer": answer_text,
        # Fall back to the newest cited evidence date when the model omits `as_of`: a
        # mutable corporate fact shown without a date invites the reader to assume it is
        # current. Sliced to 10 characters so a full timestamp becomes a plain date.
        "as_of": str(submitted.get("as_of") or max(dates))[:10],
        "citations": refs,
        "sources": _source_records(refs, context),
        "sufficient": True,
        "mode": mode,
        "reasoning": str(
            submitted.get("reasoning", "Evidence references passed deterministic validation.")
        )[:REASONING_MAX_CHARS],
    }


def _source_records(refs: list[str], context: ToolContext) -> list[dict]:
    """The per-source rows rendered under the answer and stored in the receipt.

    Carries the content hash alongside the URL so a reader can check that the cited page
    still says what it said — the URL alone proves nothing once a page has been edited.
    Deliberately omits the passage text: the full content lives in the audit record,
    which is fetched on demand rather than shipped with every answer.
    """
    return [
        {
            "ref": ref,
            "title": context.evidence[ref].title,
            "url": context.evidence[ref].url,
            "date": context.evidence[ref].date,
            "provenance": context.evidence[ref].provenance,
            "content_sha256": context.evidence[ref].audit_dict()["content_sha256"],
        }
        for ref in refs
    ]
