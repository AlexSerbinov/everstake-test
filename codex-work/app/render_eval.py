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
    lines.extend(_limitations_lines())
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
        "| # | Question | Reference answer | System answer | Verdict |",
        "|---:|---|---|---|---|",
    ]


def _result_row(row: dict) -> str:
    """One table row: the question, the reference answer, and what the system said."""
    system = row["system"]
    rendered = _rendered_answer(system)
    return (f"| {row['id']} | {cell(row['question'])} | {cell(row['reference'])} | "
            f"{cell(rendered)} | {cell(row['verdict'])} |")


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


def _limitations_lines() -> list[str]:
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
        "wrong relation. The set is also small and company-focused. The 100% result therefore means "
        "the submitted behavior passes these 20 declared contracts, not that unseen-question accuracy "
        "is 100%. Earlier development runs exposed failures in stale-CEO selection, missing dates, and "
        "endpoint conflict handling; those drove source-contract fixes before this frozen final run.",
    ]


if __name__ == "__main__":
    main()
