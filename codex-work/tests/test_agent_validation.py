"""Characterization tests for app/agent.py::_validate_submission.

This is the deterministic gate between whatever the model submits and what the
user is shown. run_agent() itself is a model loop and is not exercised.
"""

import tempfile
import unittest
from pathlib import Path

from app.agent import ABSTENTION, _validate_submission
from app.tools import RegisteredEvidence, ToolContext

CONTRACT_FAILURE = "Available evidence did not satisfy the citation and sufficiency contract."


class ValidationHarness(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.context = ToolContext(Path(directory.name) / "absent.sqlite3")

    def register(self, url="https://everstake.com/a", date="2026-01-01", content="chunk", title="A", document_id=1):
        return self.context._register(
            RegisteredEvidence("", title, url, date, content, "corpus_snapshot", document_id)
        )

    def validate(self, submitted, mode="factual", question=""):
        return _validate_submission(submitted, self.context, mode, question)


class AbstentionTests(ValidationHarness):
    def test_a_missing_submission_abstains_with_the_stop_reason(self):
        result = self.validate(None)
        self.assertEqual(result["answer"], ABSTENTION)
        self.assertEqual(result["reasoning"], "The agent stopped without a verifiable final submission.")

    def test_an_empty_submission_dict_also_abstains(self):
        self.assertEqual(self.validate({})["answer"], ABSTENTION)

    def test_an_abstention_carries_no_citations_sources_or_as_of(self):
        result = self.validate(None)
        self.assertEqual(result["citations"], [])
        self.assertEqual(result["sources"], [])
        self.assertIsNone(result["as_of"])
        self.assertFalse(result["sufficient"])

    def test_the_resolved_mode_is_echoed_back_on_an_abstention(self):
        self.assertEqual(self.validate(None, mode="synthesis")["mode"], "synthesis")

    def test_a_confident_answer_with_no_citations_is_refused(self):
        self.register()
        result = self.validate({"answer": "85 networks", "citations": [], "sufficient": True})
        self.assertEqual(result["answer"], ABSTENTION)
        self.assertEqual(result["reasoning"], CONTRACT_FAILURE)

    def test_sufficient_false_is_honoured_even_with_valid_citations(self):
        self.register()
        self.assertFalse(self.validate({"answer": "x", "citations": ["E1"], "sufficient": False})["sufficient"])

    def test_repeating_the_abstention_sentence_cannot_be_passed_off_as_an_answer(self):
        self.register()
        result = self.validate({"answer": ABSTENTION, "citations": ["E1"], "sufficient": True})
        self.assertFalse(result["sufficient"])


class CitationValidationTests(ValidationHarness):
    def test_unknown_refs_are_stripped_and_force_abstention(self):
        self.register()
        result = self.validate({"answer": "Forged", "citations": ["E99"], "sufficient": True})
        self.assertEqual(result["answer"], ABSTENTION)

    def test_duplicate_refs_are_collapsed_to_one_citation(self):
        self.register()
        self.assertEqual(self.validate({"answer": "x", "citations": ["E1", "E1"], "sufficient": True})["citations"],
                         ["E1"])

    def test_non_string_citation_values_are_ignored(self):
        # A model that emits integer ids (as the non-agent path uses) must not
        # accidentally validate here.
        self.register()
        result = self.validate({"answer": "x", "citations": [1, None, {"ref": "E1"}], "sufficient": True})
        self.assertEqual(result["answer"], ABSTENTION)

    def test_valid_and_invalid_refs_mixed_keeps_only_the_valid_ones(self):
        self.register()
        self.register(url="https://everstake.com/b", content="other")
        result = self.validate({"answer": "x", "citations": ["E1", "E404", "E2"], "sufficient": True})
        self.assertEqual(result["citations"], ["E1", "E2"])

    def test_citation_order_from_the_model_is_preserved(self):
        self.register()
        self.register(url="https://everstake.com/b", content="other")
        self.assertEqual(self.validate({"answer": "x", "citations": ["E2", "E1"], "sufficient": True})["citations"],
                         ["E2", "E1"])


class AbsenceClaimTests(ValidationHarness):
    ABSENCE_PHRASINGS = (
        "No information is available about the CEO's salary.",
        "There is no information on that.",
        "That figure is not publicly available.",
        "The number is not available.",
        "That figure is not published.",
        "The record cannot be found in the corpus.",
        "That data is private.",
    )

    def test_an_answer_that_asserts_absence_is_downgraded_to_an_abstention(self):
        # Claiming "X is not published" is itself an unverifiable claim about
        # the world; the system must abstain instead of asserting it.
        self.register()
        for phrasing in self.ABSENCE_PHRASINGS:
            with self.subTest(answer=phrasing):
                result = self.validate({"answer": phrasing, "citations": ["E1"], "sufficient": True})
                self.assertEqual(result["answer"], ABSTENTION)

    def test_a_passive_absence_phrasing_slips_past_the_detector(self):
        # Suspected gap: the alternation matches "not published" literally, so
        # "has not been published" is accepted as a real answer.
        self.register()
        result = self.validate({"answer": "This has not been published by Everstake.",
                                "citations": ["E1"], "sufficient": True})
        self.assertTrue(result["sufficient"])
        self.assertEqual(result["answer"], "This has not been published by Everstake.")

    def test_an_ordinary_answer_mentioning_availability_still_passes(self):
        self.register()
        result = self.validate({"answer": "Staking is available on 85 networks.",
                                "citations": ["E1"], "sufficient": True})
        self.assertTrue(result["sufficient"])


class SynthesisContractTests(ValidationHarness):
    def test_two_chunks_of_one_page_do_not_satisfy_synthesis(self):
        self.register(content="chunk one")
        self.register(content="chunk two")
        self.assertFalse(self.validate({"answer": "Trend", "citations": ["E1", "E2"], "sufficient": True},
                                       mode="synthesis")["sufficient"])

    def test_two_distinct_urls_satisfy_synthesis(self):
        self.register(url="https://everstake.com/a")
        self.register(url="https://everstake.com/b")
        self.assertTrue(self.validate({"answer": "Trend", "citations": ["E1", "E2"], "sufficient": True},
                                      mode="synthesis")["sufficient"])

    def test_a_since_year_question_needs_evidence_straddling_that_year(self):
        self.register(url="https://everstake.com/a", date="2023-01-01")
        self.register(url="https://everstake.com/b", date="2026-01-01")
        self.assertTrue(self.validate({"answer": "Trend", "citations": ["E1", "E2"], "sufficient": True},
                                      mode="synthesis", question="How has it changed since 2023?")["sufficient"])

    def test_evidence_that_all_postdates_the_requested_year_fails_the_straddle_check(self):
        # Guards the "looks temporal but cites nothing from the baseline year"
        # failure mode.
        self.register(url="https://everstake.com/a", date="2024-01-01")
        self.register(url="https://everstake.com/b", date="2026-01-01")
        self.assertFalse(self.validate({"answer": "Trend", "citations": ["E1", "E2"], "sufficient": True},
                                       mode="synthesis", question="How has it changed since 2023?")["sufficient"])

    def test_evidence_that_all_predates_the_requested_year_also_fails(self):
        self.register(url="https://everstake.com/a", date="2021-01-01")
        self.register(url="https://everstake.com/b", date="2022-01-01")
        self.assertFalse(self.validate({"answer": "Trend", "citations": ["E1", "E2"], "sufficient": True},
                                       mode="synthesis", question="How has it changed since 2023?")["sufficient"])

    def test_the_year_straddle_check_does_not_apply_in_factual_mode(self):
        self.register(url="https://everstake.com/a", date="2026-01-01")
        self.assertTrue(self.validate({"answer": "x", "citations": ["E1"], "sufficient": True},
                                      mode="factual", question="What happened in 2023?")["sufficient"])

    def test_a_synthesis_question_with_no_year_only_needs_two_sources(self):
        self.register(url="https://everstake.com/a", date="2026-01-01")
        self.register(url="https://everstake.com/b", date="2026-02-01")
        self.assertTrue(self.validate({"answer": "Trend", "citations": ["E1", "E2"], "sufficient": True},
                                      mode="synthesis", question="How has this changed?")["sufficient"])


class AcceptedSubmissionShapeTests(ValidationHarness):
    def test_as_of_defaults_to_the_newest_cited_evidence_date(self):
        self.register(url="https://everstake.com/a", date="2023-01-01")
        self.register(url="https://everstake.com/b", date="2026-05-06")
        result = self.validate({"answer": "x", "citations": ["E1", "E2"], "sufficient": True})
        self.assertEqual(result["as_of"], "2026-05-06")

    def test_a_model_supplied_as_of_timestamp_is_truncated_to_a_date(self):
        self.register()
        result = self.validate({"answer": "x", "citations": ["E1"],
                                "as_of": "2026-03-04T11:22:33Z", "sufficient": True})
        self.assertEqual(result["as_of"], "2026-03-04")

    def test_sources_expose_ref_title_url_date_provenance_and_content_hash(self):
        self.register()
        source = self.validate({"answer": "x", "citations": ["E1"], "sufficient": True})["sources"][0]
        self.assertEqual(set(source), {"ref", "title", "url", "date", "provenance", "content_sha256"})
        self.assertEqual(len(source["content_sha256"]), 64)

    def test_the_answer_text_is_stripped_of_surrounding_whitespace(self):
        self.register()
        result = self.validate({"answer": "  85 networks  ", "citations": ["E1"], "sufficient": True})
        self.assertEqual(result["answer"], "85 networks")

    def test_reasoning_is_truncated_to_five_hundred_characters(self):
        self.register()
        result = self.validate({"answer": "x", "citations": ["E1"], "sufficient": True, "reasoning": "z" * 900})
        self.assertEqual(len(result["reasoning"]), 500)

    def test_missing_reasoning_gets_the_default_validation_sentence(self):
        self.register()
        result = self.validate({"answer": "x", "citations": ["E1"], "sufficient": True})
        self.assertEqual(result["reasoning"], "Evidence references passed deterministic validation.")

    def test_an_accepted_result_exposes_the_documented_key_set(self):
        self.register()
        result = self.validate({"answer": "x", "citations": ["E1"], "sufficient": True})
        self.assertEqual(set(result), {"answer", "as_of", "citations", "sources",
                                       "sufficient", "mode", "reasoning"})


if __name__ == "__main__":
    unittest.main()
