"""Deterministic Trust Score components, configuration, and owner examples."""

import tempfile
import unittest
from pathlib import Path

from app.tools import RegisteredEvidence
from app.trust import DEFAULT_WEIGHTS, load_weights, save_weights, score_answer, validate_weights


def evidence(title, url, *, voice="first_party_channel", date="2026-09-12",
             penalty=1.0, reason=None, provenance="corpus_snapshot", content=None):
    return RegisteredEvidence(
        "", title, url, date, content or f"{title} says Sergii Vasylchuk is CEO.", provenance,
        None, voice, [], title, "stated", penalty, reason, 0,
    )


class WorkedExamplesTests(unittest.TestCase):
    def test_three_independent_current_first_party_sources_score_solid_above_90(self):
        cited = [
            evidence("Company", "https://everstake.com/company/about"),
            evidence("Docs", "https://docs.everstake.one/leadership"),
            evidence("GitHub", "https://github.com/everstake/leadership"),
        ]
        trust = score_answer(
            "Who is the current CEO?", "Sergii Vasylchuk is CEO.", "2026-09-12",
            cited, cited, 0.95, weights=DEFAULT_WEIGHTS,
        )
        self.assertGreaterEqual(trust["score"], 90)
        self.assertEqual(trust["band"], "solid")
        self.assertEqual(trust["independent_sources"], 3)

    def test_authoritative_answer_beats_two_low_trust_disagreements_but_scores_lower(self):
        official = evidence("Official company page", "https://everstake.com/company/about")
        contradictors = [
            evidence("Obscure A", "https://obscure-a.example/ceo", voice="third_party",
                     penalty=0.5, reason="Contradicts first-party value."),
            evidence("Obscure B", "https://obscure-b.example/ceo", voice="third_party",
                     penalty=0.5, reason="Contradicts first-party value."),
        ]
        strong = score_answer(
            "Who is the current CEO?", "Sergii Vasylchuk is CEO.", "2026-09-12",
            [official,
             evidence("Docs", "https://docs.everstake.one/leadership"),
             evidence("GitHub", "https://github.com/everstake/leadership")],
            model_confidence=0.95, weights=DEFAULT_WEIGHTS,
        )
        split = score_answer(
            "Who is the current CEO?", "Sergii Vasylchuk is CEO.", "2026-09-12",
            [official], [official, *contradictors], 0.95, weights=DEFAULT_WEIGHTS,
        )
        self.assertLess(split["score"], strong["score"])
        self.assertEqual(len(split["disagreements"]), 2)
        self.assertTrue(all(row["level"] == "low" for row in split["disagreements"]))
        self.assertIn("2 low-trust sources disagree", next(
            row["reason"] for row in split["components"] if row["name"] == "independent_agreement"
        ))


class ComponentTests(unittest.TestCase):
    def test_same_domain_and_exact_syndication_count_once(self):
        same_text = "The company supports the claim."
        cited = [
            evidence("A", "https://news.example/a", content=same_text),
            evidence("B", "https://news.example/b", content="Different text"),
            evidence("C", "https://mirror.example/c", content=same_text),
        ]
        trust = score_answer("What is stated?", "The claim is supported.", "2026-09-12",
                             cited, model_confidence=0.5, weights=DEFAULT_WEIGHTS)
        self.assertEqual(trust["independent_sources"], 1)

    def test_live_structured_evidence_gets_full_recency_and_extraction(self):
        item = evidence("MCP", "https://mcp.everstake.com", provenance="everstake_mcp:get_chains")
        trust = score_answer("What is current now?", "APY is 5%.", "2026-09-12", [item],
                             model_confidence=0.5, weights=DEFAULT_WEIGHTS)
        values = {row["name"]: row["value"] for row in trust["components"]}
        self.assertEqual(values["recency"], 1.0)
        self.assertEqual(values["extraction_confidence"], 1.0)

    def test_model_component_is_separate_and_clamped(self):
        item = evidence("A", "https://everstake.com/a")
        trust = score_answer("Who is CEO?", "Sergii is CEO.", "2026-09-12", [item],
                             model_confidence=4, weights=DEFAULT_WEIGHTS)
        model = next(row for row in trust["components"] if row["name"] == "model_self_assessment")
        self.assertEqual(model["value"], 1.0)
        self.assertLessEqual(model["weight"], 0.1)

    def test_abstention_has_no_score(self):
        self.assertIsNone(score_answer("Unknown?", "No reliable answer.", None, []))


class LiveWeightTests(unittest.TestCase):
    def test_weights_round_trip_and_change_score_without_model_calls(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "trust.json"
            changed = dict(DEFAULT_WEIGHTS)
            changed.update(source_authority=0.10, independent_agreement=0.40)
            save_weights(changed, path)
            self.assertEqual(load_weights(path), changed)
            item = evidence("A", "https://everstake.com/a")
            default_score = score_answer("Who is CEO?", "Sergii is CEO.", "2026-09-12", [item],
                                         model_confidence=0.9, weights=DEFAULT_WEIGHTS)["score"]
            changed_score = score_answer("Who is CEO?", "Sergii is CEO.", "2026-09-12", [item],
                                         model_confidence=0.9, weights=changed)["score"]
            self.assertNotEqual(default_score, changed_score)

    def test_model_weight_above_ten_percent_is_rejected(self):
        invalid = dict(DEFAULT_WEIGHTS)
        invalid.update(model_self_assessment=0.11, source_authority=0.19)
        with self.assertRaisesRegex(ValueError, "may not exceed 10%"):
            validate_weights(invalid)

    def test_weights_must_sum_to_one(self):
        invalid = dict(DEFAULT_WEIGHTS)
        invalid["recency"] = 0.10
        with self.assertRaisesRegex(ValueError, "sum to 1.0"):
            validate_weights(invalid)
