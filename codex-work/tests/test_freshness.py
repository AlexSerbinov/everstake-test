"""Freshness policy, calculator, and cheap detector contracts."""

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from app.freshness import PRESETS, calculate_monthly, source_type, validate_policy
from app.refresh import _describe_page_change, _is_due


class SourceTypeTests(unittest.TestCase):
    def test_reports_and_events_are_split_from_generic_site_pages(self):
        self.assertEqual(source_type({"category": "site", "url": "https://everstake.com/company/events/x"}),
                         "reports_events")

    def test_github_video_and_press_keep_distinct_policies(self):
        cases = [
            ({"category": "code", "url": "https://github.com/everstake"}, "github"),
            ({"category": "video", "url": "https://youtube.com/watch?v=x"}, "video"),
            ({"category": "press", "url": "https://news.example/x"}, "third_party"),
        ]
        for doc, expected in cases:
            with self.subTest(expected=expected):
                self.assertEqual(source_type(doc), expected)


class CalculatorTests(unittest.TestCase):
    def setUp(self):
        self.profile = {
            "counts": {name: 0 for name in PRESETS["balanced"]},
            "chunks_per_doc": 2, "total_documents": 10, "total_chunks": 20,
        }
        self.units = {
            "fetch_wall_ms": 100, "extract_wall_ms": 10, "extract_cost_usd": 0.01,
            "extract_tokens": 100, "embedding_wall_ms": 20,
            "embedding_cost_usd": 0.001, "embedding_tokens": 50,
            "run_overhead_ms": 50,
        }

    def test_never_has_zero_cost_and_unbounded_staleness(self):
        policy = {"preset": "custom", "sources": {
            name: {"interval": "never", "depth": "full"} for name in PRESETS["balanced"]
        }}
        result = calculate_monthly(policy, self.profile, self.units)
        self.assertEqual(result["totals"], {
            "cost_usd": 0.0, "tokens": 0, "machine_minutes": 0.0,
            "worst_staleness_hours": None,
        })

    def test_reextract_prices_only_expected_changed_documents_and_their_chunks(self):
        self.profile["counts"]["github"] = 10
        policy = {"preset": "custom", "sources": {
            name: {"interval": "never", "depth": "cheap"} for name in PRESETS["balanced"]
        }}
        policy["sources"]["github"] = {"interval": "daily", "depth": "reextract"}
        result = calculate_monthly(policy, self.profile, self.units)
        github = next(row for row in result["sources"] if row["type"] == "github")
        # 30 runs * 10 repos * 5% = 15 changed docs; each has two chunks.
        self.assertEqual(github["expected_changed_docs"], 15)
        self.assertAlmostEqual(github["cost_usd"], 0.18)
        self.assertEqual(github["tokens"], 3000)

    def test_full_reindex_uses_probability_of_at_least_one_change(self):
        self.profile["counts"]["live_pages"] = 2
        policy = {"preset": "custom", "sources": {
            name: {"interval": "never", "depth": "cheap"} for name in PRESETS["balanced"]
        }}
        policy["sources"]["live_pages"] = {"interval": "monthly", "depth": "full"}
        result = calculate_monthly(policy, self.profile, self.units)
        row = next(row for row in result["sources"] if row["type"] == "live_pages")
        expected_rebuilds = 1 - 0.97 ** 2
        expected = (2 * 0.03 * 0.01) + expected_rebuilds * 20 * 0.001
        self.assertAlmostEqual(row["cost_usd"], expected)

    def test_every_preset_is_complete_and_valid(self):
        for name, sources in PRESETS.items():
            with self.subTest(name=name):
                validate_policy({"preset": name, "sources": sources})


class RefreshMathTests(unittest.TestCase):
    def test_due_check_respects_interval_and_never(self):
        now = datetime(2026, 9, 12, 12, tzinfo=timezone.utc)
        self.assertTrue(_is_due("2026-09-11T11:00:00+00:00", "daily", now))
        self.assertFalse(_is_due("2026-09-12T11:00:00+00:00", "daily", now))
        self.assertFalse(_is_due(None, "never", now))

    def test_change_log_exposes_fact_value_deltas(self):
        old = {"url": "https://everstake.com/about", "category": "site", "text": "APY is 5%."}
        new = {"title": "About", "text": "APY is 6%.", "sha256": "new"}
        delta = _describe_page_change(old, new, "reextract")
        self.assertTrue(any("6" in fact for fact in delta["facts_added"]))
        self.assertTrue(any("5" in fact for fact in delta["facts_removed"]))


if __name__ == "__main__":
    unittest.main()
