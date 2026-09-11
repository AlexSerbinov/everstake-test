from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from .config import ROOT
from .retrieval import answer


def verdict(case: dict, result: dict) -> tuple[str, bool]:
    unknown = result["answer"] == "No reliable answer was found in the corpus."
    if case.get("expect_unknown"):
        return ("PASS — correctly abstained", False) if unknown else ("FAIL — invented or overclaimed a fact", True)
    if unknown:
        return "FAIL — missed an answer present in the corpus", False
    normalized = result["answer"].lower()
    all_ok = all(term.lower() in normalized for term in case.get("expected_all", []))
    any_terms = case.get("expected_any", [])
    any_ok = not any_terms or any(term.lower() in normalized for term in any_terms)
    cited = bool(result.get("sources")) and bool(result.get("as_of"))
    return ("PASS", False) if all_ok and any_ok and cited else ("FAIL — answer, date, or citation mismatch", False)


def run() -> dict:
    cases = json.loads((ROOT / "eval/questions.json").read_text())
    rows = []
    for case in cases:
        print(f"[{case['id']:02d}/20] {case['question']}", flush=True)
        result = answer(case["question"], "auto")
        label, invented = verdict(case, result)
        rows.append({"id": case["id"], "question": case["question"], "reference": case["reference"], "system": result, "verdict": label, "invented": invented})
    passed = sum(row["verdict"].startswith("PASS") for row in rows)
    payload = {
        "run_at": datetime.now(timezone.utc).isoformat(), "questions": len(rows), "passed": passed,
        "failed": len(rows) - passed, "accuracy": passed / len(rows),
        "invented_facts": sum(row["invented"] for row in rows), "rows": rows,
    }
    output = ROOT / "data/eval-results.json"
    output.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    print(json.dumps({key: payload[key] for key in ("questions", "passed", "failed", "accuracy", "invented_facts")}, indent=2))
    return payload


if __name__ == "__main__":
    run()
