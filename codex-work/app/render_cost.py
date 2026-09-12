"""Generate COST.md and the JSON payload served by the Cost view."""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from .config import ACCOUNTING_LOG, COST_REPORT_PATH, PRICE_TABLE, PRICE_TABLE_COPIED_AT, ROOT

STAGE_ORDER = ("crawl", "dedup", "chunk_index", "fact_extraction", "embeddings",
               "quality_eval", "adversarial_eval")
LABELS = {
    "crawl": "Polite crawl",
    "dedup": "Deduplication",
    "chunk_index": "Clean, chunk & index",
    "fact_extraction": "Fact-ledger extraction",
    "embeddings": "Index embeddings",
    "quality_eval": "Quality evaluation",
    "adversarial_eval": "Adversarial evaluation",
}


def load_records(path: Path = ACCOUNTING_LOG) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def receipt_totals(steps: list[dict[str, Any]]) -> dict[str, Any]:
    """Sum receipt steps; kept public because exact-sum tests guard UI honesty."""
    return {
        "input_tokens": sum(int(step.get("tokens", {}).get("input", 0) or 0) for step in steps),
        "output_tokens": sum(int(step.get("tokens", {}).get("output", 0) or 0) for step in steps),
        "cached_input_tokens": sum(
            int(step.get("tokens", {}).get("cached_input", 0) or 0) for step in steps
        ),
        "cost_usd": round(sum(float(step.get("cost_usd", 0) or 0) for step in steps), 10),
    }


def build_report(records: list[dict[str, Any]]) -> dict[str, Any]:
    completed = [row for row in records if row.get("status") == "completed"]
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in completed:
        grouped[row["name"]].append(row)

    stages = []
    for name in STAGE_ORDER:
        runs = grouped.get(name, [])
        if not runs:
            continue
        latest = runs[-1]
        units = _units(latest.get("items", {}))
        stages.append({
            "name": name,
            "label": LABELS[name],
            "code_or_model": latest.get("metadata", {}).get(
                "code_or_model", "model + code" if latest.get("models") else "code"
            ),
            "models": latest.get("models", []),
            "providers": latest.get("providers", []),
            "units": units,
            "items": latest.get("items", {}),
            "bytes_downloaded": latest.get("bytes_downloaded", 0),
            "tokens": latest.get("tokens", {}),
            "cost_usd": latest.get("cost_usd", 0),
            "wall_ms": latest.get("wall_ms"),
            "cpu_ms": latest.get("cpu_ms"),
            "peak_rss_mb": latest.get("peak_rss_mb"),
            "machine": latest.get("machine"),
            "cost_per_unit": round(latest.get("cost_usd", 0) / max(1, units["count"]), 10),
            "runs": runs[-8:],
        })

    questions = [row for row in completed if row.get("name") == "single_question"]
    representative = next(
        (row for row in reversed(questions) if row.get("metadata", {}).get("answer_sufficient")),
        questions[-1] if questions else None,
    )
    mean_question_cost = (
        sum(row["cost_usd"] for row in questions) / len(questions) if questions else 0
    )
    index_stages = [row for row in stages if row["name"] in STAGE_ORDER[:5]]
    index_cost = sum(row["cost_usd"] for row in index_stages)
    index_wall = sum(row["wall_ms"] or 0 for row in index_stages)
    return {
        "generated_from": str(ACCOUNTING_LOG.relative_to(ROOT)),
        "price_table_copied_at": PRICE_TABLE_COPIED_AT,
        "prices": PRICE_TABLE,
        "headline": {
            "index_cost_usd": round(index_cost, 10),
            "index_wall_ms": round(index_wall, 3),
            "mean_question_cost_usd": round(mean_question_cost, 10),
            "measured_questions": len(questions),
        },
        "stages": stages,
        "representative_question": representative,
        "assumptions": [
            f"Provider list prices copied {PRICE_TABLE_COPIED_AT}; later prices may differ.",
            "Provider usage fields are measured; no tokenizer estimates are used.",
            "×50 time is serial multiplication, not a parallel-throughput forecast.",
            "CPU and RSS depend on the recorded machine and cannot be transferred to other hardware.",
            "Historical runs without resource telemetry are excluded from current stage timing.",
        ],
    }


def _units(items: dict[str, int]) -> dict[str, Any]:
    for key in ("questions", "chunks", "documents", "chunks_scanned", "visited_urls"):
        if key in items:
            return {"count": int(items[key]), "label": key.replace("_", " ")}
    return {"count": 1, "label": "run"}


def render_markdown(report: dict[str, Any]) -> str:
    headline = report["headline"]
    lines = [
        "# Measured Cost & Resources",
        "",
        f"Building the measured index pipeline cost **${headline['index_cost_usd']:.6f}**. "
        f"Across {headline['measured_questions']} measured full-agent questions, one question averaged "
        f"**${headline['mean_question_cost_usd']:.6f}**.",
        "",
        f"Prices were copied on **{report['price_table_copied_at']}**. Tokens are provider-reported; "
        "wall time, process CPU and peak RSS are captured during the run.",
        "",
        "## Per-stage measurements",
        "",
        "| Stage | Runs as | Model | Units | Tokens in / out (cache) | USD | Wall | CPU | Peak RAM | $ / unit |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in report["stages"]:
        token = row["tokens"]
        models = ", ".join(row["models"]) or "—"
        lines.append(
            f"| {row['label']} | {row['code_or_model']} | {models} | "
            f"{row['units']['count']:,} {row['units']['label']} | "
            f"{token.get('input', 0):,} / {token.get('output', 0):,} "
            f"({token.get('cached_input', 0):,}) | ${row['cost_usd']:.8f} | "
            f"{_duration(row['wall_ms'])} | {_duration(row['cpu_ms'])} | "
            f"{row['peak_rss_mb']:.2f} MB | ${row['cost_per_unit']:.10f} |"
        )

    question = report.get("representative_question")
    lines += ["", "## One real question, step by step", ""]
    if question:
        lines += [f"**Question:** {question['metadata']['question']}", "",
                  "| Step | Tool or model | Tokens in / out (cache) | USD | Time |",
                  "|---|---|---:|---:|---:|"]
        for step in question["steps"]:
            token = step["tokens"]
            actor = step.get("model") or "code"
            lines.append(
                f"| {step['name']} | {actor} | {token['input']:,} / {token['output']:,} "
                f"({token['cached_input']:,}) | ${step['cost_usd']:.8f} | {_duration(step['wall_ms'])} |"
            )
        total = receipt_totals(question["steps"])
        lines.append(
            f"| **Total** |  | **{total['input_tokens']:,} / {total['output_tokens']:,} "
            f"({total['cached_input_tokens']:,})** | **${total['cost_usd']:.8f}** | "
            f"**{_duration(question['wall_ms'])}** |"
        )
        lines += ["", f"Measured on **{question['machine']}**."]
    else:
        lines.append("No full-agent question has been measured yet.")

    lines += ["", "## ×50, row by row", "",
              "| Stage | Measured USD | ×50 USD | Serial wall-time arithmetic |",
              "|---|---:|---:|---:|"]
    for row in report["stages"]:
        lines.append(
            f"| {row['label']} | ${row['cost_usd']:.8f} | "
            f"${row['cost_usd']:.8f} × 50 = **${row['cost_usd'] * 50:.8f}** | "
            f"{_duration(row['wall_ms'])} × 50 = **{_duration((row['wall_ms'] or 0) * 50)}** |"
        )
    if question:
        lines.append(
            f"| One full-agent question | ${question['cost_usd']:.8f} | "
            f"${question['cost_usd']:.8f} × 50 = **${question['cost_usd'] * 50:.8f}** | "
            f"{_duration(question['wall_ms'])} × 50 = **{_duration(question['wall_ms'] * 50)}** |"
        )

    lines += ["", "## What is measured vs assumed", ""]
    lines.extend(f"- {item}" for item in report["assumptions"])
    lines += ["", _where_money_goes(report), ""]
    return "\n".join(lines)


def _duration(milliseconds: float | None) -> str:
    if milliseconds is None:
        return "unknown"
    return f"{milliseconds / 1000:.2f}s" if milliseconds >= 1000 else f"{milliseconds:.1f}ms"


def _where_money_goes(report: dict[str, Any]) -> str:
    index_rows = [row for row in report["stages"] if row["name"] in STAGE_ORDER[:5]]
    total_cost = sum(row["cost_usd"] for row in index_rows)
    total_time = sum(row["wall_ms"] or 0 for row in index_rows)
    money = max(index_rows, key=lambda row: row["cost_usd"], default=None)
    time_row = max(index_rows, key=lambda row: row["wall_ms"] or 0, default=None)
    if not money or not time_row:
        return "Where the money goes: no complete index measurement is available yet."
    money_share = money["cost_usd"] / total_cost * 100 if total_cost else 0
    time_share = (time_row["wall_ms"] or 0) / total_time * 100 if total_time else 0
    return (f"**Where the money goes:** {money_share:.0f}% of index cost is {money['label'].lower()}; "
            f"{time_share:.0f}% of measured index time is {time_row['label'].lower()}.")


def main() -> None:
    report = build_report(load_records())
    COST_REPORT_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    (ROOT / "COST.md").write_text(render_markdown(report))
    print(json.dumps(report["headline"], indent=2))


if __name__ == "__main__":
    main()
