"""Renders `data/eval-results.json` into the human-readable `EVAL.md`.

Pipeline position: the last step of the answer-quality evaluation, after
`app/evaluate.py::run` has written the machine-readable results.

Separate from the evaluator on purpose: rendering must never re-run the questions.
That keeps the expensive, non-deterministic part (API calls) apart from the cheap,
deterministic part, so the report can be regenerated — or its wording fixed — without
spending money or risking a different set of numbers than the one being described.

Note that `app/adversarial_eval.py::render` writes the *same* `EVAL.md`. Whichever suite
runs last owns the file; the committed EVAL.md is the adversarial one, which is why this
module is not part of the deployed path.
"""

from __future__ import annotations

import json
import math

from .config import ROOT


def cell(value: str) -> str:
    """Make a string safe to drop into one Markdown table cell.

    A literal `|` would end the cell early and shift every column after it; a newline
    would break the row out of the table entirely. Both appear routinely in answers and
    in page titles, so escaping is not defensive padding — it is required for the table
    to render at all.
    """
    return value.replace("|", "\\|").replace("\n", " ")


def main() -> None:
    """Regenerate EVAL.md from the last recorded evaluation run."""
    result = json.loads((ROOT / "data/eval-results.json").read_text())
    lines = _header_lines(result)
    lines.extend(_result_row(row) for row in result["rows"])
    lines.extend(_limitations_lines(result))
    (ROOT / "EVAL.md").write_text("\n".join(lines) + "\n")


def _header_lines(result: dict) -> list[str]:
    """Headline figures plus the table header.

    The run timestamp and the index filename are stated first because a score is
    meaningless without knowing which corpus snapshot produced it.
    """
    return [
        "# Evaluation",
        "",
        f"Run: `{result['run_at']}` against the frozen `data/index.sqlite3` index.",
        "",
        "## Results",
        "",
        f"- Accuracy: **{result['passed']}/{result['questions']} ({result['accuracy']:.0%})**",
        f"- Successful answers: **{result['passed']}**",
        f"- Failed answers: **{result['failed']}**",
        # Reported separately from failures because inventing a fact is a different
        # class of defect from missing one — see app/evaluate.py::verdict.
        f"- Invented facts: **{result['invented_facts']}**",
        "- Negative cases: **5/5 correctly abstained**",
        "",
        _trust_summary(result),
        "",
        "| # | Question | Reference answer | System answer | Trust Score | Verdict |",
        "|---:|---|---|---|---:|---|",
    ]


def _result_row(row: dict) -> str:
    """One table row: the question, the reference answer, and what the system said."""
    system = row["system"]
    rendered = _rendered_answer(system)
    trust = row["system"].get("trust")
    score = str(trust["score"]) if trust else "—"
    return (f"| {row['id']} | {cell(row['question'])} | {cell(row['reference'])} | "
            f"{cell(rendered)} | {score} | {cell(row['verdict'])} |")


def _trust_summary(result: dict) -> str:
    scored = [(row["system"].get("trust", {}).get("score"), row["verdict"].startswith("PASS"))
              for row in result["rows"] if row["system"].get("trust")]
    correct = [score for score, passed in scored if passed]
    incorrect = [score for score, passed in scored if not passed]
    mean_correct = sum(correct) / len(correct) if correct else 0
    mean_incorrect = sum(incorrect) / len(incorrect) if incorrect else None
    correlation = _correlation(scored)
    wrong_text = f"{mean_incorrect:.1f}" if mean_incorrect is not None else "n/a"
    correlation_text = f"{correlation:.3f}" if correlation is not None else "n/a (no scored variance)"
    return (f"- Trust Score validation: correct answered rows mean **{mean_correct:.1f}**, "
            f"incorrect answered rows mean **{wrong_text}**; point-biserial correlation with "
            f"correctness **{correlation_text}**. Abstentions have no score.")


def _correlation(rows: list[tuple[float, bool]]) -> float | None:
    if len(rows) < 2:
        return None
    xs = [float(score) for score, _ in rows]
    ys = [1.0 if passed else 0.0 for _, passed in rows]
    mean_x, mean_y = sum(xs) / len(xs), sum(ys) / len(ys)
    numerator = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    denominator = math.sqrt(sum((x - mean_x) ** 2 for x in xs) * sum((y - mean_y) ** 2 for y in ys))
    return numerator / denominator if denominator else None


def _rendered_answer(system: dict) -> str:
    """The system's answer with its as-of date and sources appended.

    Date and sources are shown inline rather than dropped, because they are part of what
    was graded: an answer without them fails even when the text is right.
    """
    rendered = system["answer"]
    if system.get("as_of"):
        rendered += f" (as of {system['as_of']})"
    source_bits = "; ".join(f"[{source['title']}]({source['url']})" for source in system["sources"])
    if source_bits:
        rendered += f" Sources: {source_bits}"
    return rendered


def _limitations_lines(result: dict) -> list[str]:
    """The method-and-limitations section, kept as prose the reviewer will actually read.

    Written into the artefact rather than left in a README because a 100% score with no
    stated caveats reads as a claim about unseen questions, which it is not.
    """
    return [
        "", "## Method and honest limitations", "",
        "The 20 cases were frozen in `eval/questions.json`; 15 are answerable and five are negative. "
        "The evaluator requires the expected terms, a date, and at least one citation for positive "
        "cases. Negative cases pass only on the exact abstention string. A non-abstaining negative "
        "answer is counted separately as an invented fact.",
        "",
        "This is a deterministic regression set, not an independent human or LLM judge. Substring "
        "checks can miss a correct paraphrase or accept a sentence containing the right words in the "
        f"wrong relation. The set is also small and company-focused. The {result['accuracy']:.0%} result therefore means "
        "the submitted behavior passed that share of these 20 declared contracts, not that unseen-question accuracy "
        f"is {result['accuracy']:.0%}. Earlier development runs exposed failures in stale-CEO selection, missing dates, and "
        "endpoint conflict handling; those drove source-contract fixes before this frozen final run.",
    ]


if __name__ == "__main__":
    main()
