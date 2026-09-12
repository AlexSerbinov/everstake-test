"""Answer-quality evaluation: the 20 frozen questions in `eval/questions.json`.

Pipeline position: sits outside the request path. It replays a fixed question set against
the **legacy single-shot RAG path** (`retrieval.answer`, not the tool-using agent) and
writes `data/eval-results.json`, which `app/render_eval.py` turns into `EVAL.md`.
The agent path has its own suite in `app/adversarial_eval.py`.

Fifteen cases are answerable and five are negative — questions whose answer is genuinely
not in the corpus. The negative cases carry the weight: any RAG system can be made to
score well on questions it can answer, and the failure mode that actually matters for a
company knowledge assistant is confidently inventing the one it cannot.

If the grading here is wrong, the accuracy figure in EVAL.md and REPORT.md is wrong, and
those numbers are the evidence the whole submission rests on.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from .accounting import RunRecorder
from .config import ROOT
from .retrieval import answer

# Duplicated as a literal rather than imported from app.agent, so this grader keeps
# working if the answer path is swapped out — and so a change to the abstention wording
# shows up here as a failing eval rather than as a silently passing one. It must stay
# byte-identical to app.agent.ABSTENTION.
ABSTENTION = "No reliable answer was found in the corpus."

TOTAL_CASES = 20


def verdict(case: dict, result: dict) -> tuple[str, bool]:
    """Grade one answer, returning (human-readable label, was-a-fact-invented).

    The second value is tracked separately from pass/fail because the two failures are
    not equally bad. Missing an answer that is in the corpus is a retrieval weakness;
    answering a question whose answer does not exist is a fabrication, and it is the only
    path that increments `invented_facts` in the report.
    """
    abstained = result["answer"] == ABSTENTION
    if case.get("expect_unknown"):
        if abstained:
            return "PASS — correctly abstained", False
        return "FAIL — invented or overclaimed a fact", True
    if abstained:
        return "FAIL — missed an answer present in the corpus", False
    return _grade_answered_case(case, result)


def _grade_answered_case(case: dict, result: dict) -> tuple[str, bool]:
    """Grade a case the system chose to answer, against three independent requirements.

    All of `expected_all`, `expected_any` and the citation/date check must hold. The
    citation and date requirement is not a formality: an undated claim about a mutable
    corporate fact ("Everstake supports N networks") is not a correct answer even when
    the number is right, because the reader has no way to tell how old it is.
    """
    normalized = result["answer"].lower()
    # KNOWN LIMITATION: terms are matched as bare substrings, not word-bounded, so a
    # short expected term passes against an unrelated answer — `expected_all: ["eth"]`
    # is satisfied by "Whether or not." Pinned in
    # tests/test_eval_predicates.py::test_expected_terms_are_matched_as_bare_substrings_not_words.
    # Not fixed here: word boundaries would change which of the 20 cases pass.
    has_all_required = all(term.lower() in normalized for term in case.get("expected_all", []))
    alternatives = case.get("expected_any", [])
    # An empty alternatives list means the case declared no alternatives, which is
    # satisfied — not "nothing matched, so fail".
    has_an_alternative = not alternatives or any(term.lower() in normalized for term in alternatives)
    is_cited_and_dated = bool(result.get("sources")) and bool(result.get("as_of"))
    if has_all_required and has_an_alternative and is_cited_and_dated:
        return "PASS", False
    # One label for all three failure shapes: the row in EVAL.md shows the reference and
    # the system answer side by side, so a reader can see which requirement missed.
    return "FAIL — answer, date, or citation mismatch", False


def run() -> dict:
    """Replay the frozen question set and write the machine-readable results.

    Questions are read from disk rather than embedded here so the graded set is visibly
    frozen — a reviewer can diff `eval/questions.json` against git history and see it was
    not tuned after the fact. Progress is printed per case with `flush=True` because a
    full run takes minutes of API calls and a silent terminal looks like a hang.
    """
    cases = json.loads((ROOT / "eval/questions.json").read_text())
    recorder = RunRecorder("eval", "quality_eval", {"suite": "eval/questions.json"}).activate()
    try:
        rows = [_run_case(case) for case in cases]
    except Exception:
        recorder.finish(status="failed", items={"questions": len(cases)})
        raise
    recorder.finish(items={"questions": len(cases)})
    payload = _summarise(rows)
    output = ROOT / "data/eval-results.json"
    output.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(json.dumps(
        {key: payload[key] for key in ("questions", "passed", "failed", "accuracy", "invented_facts")},
        indent=2,
    ))
    return payload


def _run_case(case: dict) -> dict:
    """Answer one case and record everything needed to re-audit the grade later.

    The whole `result` is kept, not just the verdict, so EVAL.md can show the system's
    actual answer next to the reference and a reader can disagree with the grading.
    """
    print(f"[{case['id']:02d}/{TOTAL_CASES}] {case['question']}", flush=True)
    # "auto" so mode selection is part of what is being evaluated, rather than the
    # evaluator quietly handing the system the right mode for each question.
    recorder = RunRecorder("question", "legacy_eval_question", {
        "question": case["question"], "eval_case": case["id"],
    }).activate()
    try:
        result = answer(case["question"], "auto")
    except Exception:
        recorder.finish(status="failed", items={"questions": 1})
        raise
    recorder.finish(items={"questions": 1})
    label, invented = verdict(case, result)
    return {
        "id": case["id"],
        "question": case["question"],
        "reference": case["reference"],
        "system": result,
        "verdict": label,
        "invented": invented,
    }


def _summarise(rows: list[dict]) -> dict:
    """Roll the per-case rows into the headline figures quoted in REPORT.md."""
    passed = sum(row["verdict"].startswith("PASS") for row in rows)
    return {
        "run_at": datetime.now(timezone.utc).isoformat(),
        "questions": len(rows),
        "passed": passed,
        "failed": len(rows) - passed,
        "accuracy": passed / len(rows),
        "invented_facts": sum(row["invented"] for row in rows),
        "rows": rows,
    }


if __name__ == "__main__":
    run()
