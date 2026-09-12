"""Accounting math and Gemini adapter contracts."""

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.accounting import RunRecorder, price_usd, record_code_step, record_provider_step
from app.api_clients import _gemini_declaration, _thinking_config, create_agent_response
from app.render_cost import build_report, receipt_totals


class PricingTests(unittest.TestCase):
    def test_all_configured_provider_prices_use_per_million_arithmetic(self):
        self.assertEqual(price_usd("gemini-3.8-flash", 1_000_000, 1_000_000), 4.5)
        self.assertEqual(price_usd("gemini-3.5-flash-lite", 1_000_000, 1_000_000), 2.8)
        self.assertEqual(price_usd("text-embedding-3-small", 1_000_000, 0), 0.02)

    def test_cached_tokens_are_reported_without_being_double_charged(self):
        self.assertEqual(price_usd("gemini-3.8-flash", 1000, 0, 400), 0.00075)


class ReceiptTests(unittest.TestCase):
    def test_receipt_total_equals_the_exact_sum_of_steps(self):
        steps = [
            {"tokens": {"input": 10, "output": 2, "cached_input": 3}, "cost_usd": 0.001},
            {"tokens": {"input": 7, "output": 1, "cached_input": 0}, "cost_usd": 0.002},
            {"tokens": {"input": 0, "output": 0, "cached_input": 0}, "cost_usd": 0},
        ]
        self.assertEqual(receipt_totals(steps), {
            "input_tokens": 17,
            "output_tokens": 3,
            "cached_input_tokens": 3,
            "cost_usd": 0.003,
        })

    def test_run_aggregation_matches_provider_and_code_steps(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder = RunRecorder("question", "single_question",
                                   log_path=Path(directory) / "accounting.jsonl").activate()
            record_provider_step("Model turn", "gemini-3.8-flash", 1000, 20, 200, 5, 1)
            record_code_step("Search", 2, 1)
            result = recorder.finish(items={"questions": 1})
        self.assertEqual(result["tokens"], {"input": 1000, "output": 20, "cached_input": 200})
        self.assertEqual(result["cost_usd"], price_usd("gemini-3.8-flash", 1000, 20, 200))
        self.assertEqual(result["items"], {"questions": 1})

    def test_report_uses_the_latest_completed_run_per_stage(self):
        def row(run_id, cost):
            return {"run_id": run_id, "kind": "stage", "name": "embeddings",
                    "status": "completed", "metadata": {"code_or_model": "model"},
                    "models": ["text-embedding-3-small"], "providers": ["OpenAI"],
                    "items": {"chunks": 10}, "bytes_downloaded": 0,
                    "tokens": {"input": 100, "output": 0, "cached_input": 0},
                    "cost_usd": cost, "wall_ms": 10, "cpu_ms": 2,
                    "peak_rss_mb": 20, "machine": "test", "steps": []}
        report = build_report([row("old", 0.1), row("new", 0.2)])
        self.assertEqual(report["stages"][0]["cost_usd"], 0.2)
        self.assertEqual([run["run_id"] for run in report["stages"][0]["runs"]], ["old", "new"])

    def test_nested_run_records_its_parent_for_suite_scoped_means(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounting.jsonl"
            parent = RunRecorder("eval", "adversarial_eval", log_path=path).activate()
            child = RunRecorder("question", "single_question", log_path=path).activate()
            child.finish()
            parent.finish()
        self.assertEqual(child.record["metadata"]["parent_runs"], [
            {"run_id": parent.record["run_id"], "name": "adversarial_eval"}
        ])


class GeminiAdapterTests(unittest.TestCase):
    def test_lite_omits_thinking_config_and_flash_uses_a_level_not_a_budget(self):
        self.assertEqual(_thinking_config("gemini-3.5-flash-lite"), {})
        self.assertEqual(_thinking_config("gemini-3.8-flash"),
                         {"thinkingConfig": {"thinkingLevel": "low"}})

    def test_openai_only_schema_fields_are_removed(self):
        declaration = _gemini_declaration({
            "type": "function", "name": "done", "description": "finish", "strict": True,
            "parameters": {"type": "object", "additionalProperties": False,
                           "properties": {"as_of": {"type": ["string", "null"]}}},
        })
        self.assertNotIn("strict", declaration)
        self.assertNotIn("additionalProperties", declaration["parameters"])
        self.assertEqual(declaration["parameters"]["properties"]["as_of"],
                         {"type": "string", "nullable": True})

    def test_function_call_is_normalized_and_signature_is_preserved(self):
        response = {
            "candidates": [{"content": {"role": "model", "parts": [{
                "functionCall": {"id": "call-1", "name": "done", "args": {"x": 1}},
                "thoughtSignature": "opaque",
            }]}}],
            "usageMetadata": {"promptTokenCount": 12, "candidatesTokenCount": 3,
                              "cachedContentTokenCount": 2},
        }
        tool = {"type": "function", "name": "done", "description": "finish",
                "parameters": {"type": "object", "properties": {}}}
        with patch.dict("os.environ", {"GEMINI_API_KEY": "test"}), \
             patch("app.api_clients._post_json", return_value=response), \
             patch("app.api_clients.record_cost"):
            normalized, usage = create_agent_response("rules", [], [tool])
        self.assertEqual(normalized["output"][0]["call_id"], "call-1")
        self.assertEqual(normalized["_content"]["parts"][0]["thoughtSignature"], "opaque")
        self.assertEqual(usage["cached_input_tokens"], 2)


if __name__ == "__main__":
    unittest.main()
