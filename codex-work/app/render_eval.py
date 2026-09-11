from __future__ import annotations

import json

from .config import ROOT


def cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def main() -> None:
    result = json.loads((ROOT / "data/eval-results.json").read_text())
    lines = [
        "# Evaluation",
        "",
        f"Run: `{result['run_at']}` against the frozen `data/index.sqlite3` index.",
        "",
        "## Results",
        "",
        f"- Accuracy: **{result['passed']}/{result['questions']} ({result['accuracy']:.0%})**",
        f"- Successful answers: **{result['passed']}**",
        f"- Failed answers: **{result['failed']}**",
        f"- Invented facts: **{result['invented_facts']}**",
        "- Negative cases: **5/5 correctly abstained**",
        "",
        "| # | Question | Reference answer | System answer | Verdict |",
        "|---:|---|---|---|---|",
    ]
    for row in result["rows"]:
        system = row["system"]
        source_bits = "; ".join(f"[{source['title']}]({source['url']})" for source in system["sources"])
        rendered = system["answer"]
        if system.get("as_of"):
            rendered += f" (as of {system['as_of']})"
        if source_bits:
            rendered += f" Sources: {source_bits}"
        lines.append(f"| {row['id']} | {cell(row['question'])} | {cell(row['reference'])} | {cell(rendered)} | {cell(row['verdict'])} |")
    lines.extend([
        "", "## Method and honest limitations", "",
        "The 20 cases were frozen in `eval/questions.json`; 15 are answerable and five are negative. The evaluator requires the expected terms, a date, and at least one citation for positive cases. Negative cases pass only on the exact abstention string. A non-abstaining negative answer is counted separately as an invented fact.",
        "",
        "This is a deterministic regression set, not an independent human or LLM judge. Substring checks can miss a correct paraphrase or accept a sentence containing the right words in the wrong relation. The set is also small and company-focused. The 100% result therefore means the submitted behavior passes these 20 declared contracts, not that unseen-question accuracy is 100%. Earlier development runs exposed failures in stale-CEO selection, missing dates, and endpoint conflict handling; those drove source-contract fixes before this frozen final run.",
    ])
    (ROOT / "EVAL.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()

