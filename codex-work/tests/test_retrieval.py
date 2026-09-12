"""Characterization tests for the ranking heart: app/retrieval.py.

These pin CURRENT behaviour so a readability refactor cannot silently change
which evidence wins. Where behaviour looks wrong it is still pinned, with a
comment saying so.
"""

import sqlite3
import struct
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import app.retrieval as retrieval
from app.indexer import SCHEMA, pack
from app.retrieval import (
    Evidence,
    _year,
    adjudicate_evidence,
    cosine,
    fts_query,
    source_authority,
    unpack,
)


def make_evidence(url: str, *, date: str = "2026-01-01", document_id: int = 1,
                  tier: int = 1, category: str = "blog", score: float = 0.5) -> Evidence:
    return Evidence(1, document_id, "title", url, "text", None, None, date, tier, category, score)


class FtsQueryTests(unittest.TestCase):
    def test_first_two_surviving_terms_are_emitted_as_an_adjacency_phrase(self):
        query = fts_query("uptime metrics for solana validators")
        self.assertTrue(query.startswith('"uptime metrics" OR '))

    def test_stopwords_and_two_letter_tokens_are_dropped(self):
        # "what/the/current/everstake" are stopwords and "is/of" are too short,
        # so a natural leadership question collapses to a single term.
        self.assertEqual(fts_query("What is the current CEO of Everstake?"), '"ceo"')

    def test_single_surviving_term_produces_no_phrase_clause(self):
        self.assertEqual(fts_query("uptime"), '"uptime"')

    def test_query_with_only_stopwords_falls_back_to_everstake(self):
        self.assertEqual(fts_query("the and for"), '"everstake"')

    def test_empty_question_falls_back_to_everstake(self):
        self.assertEqual(fts_query(""), '"everstake"')

    def test_terms_are_capped_at_sixteen_after_the_phrase_clause(self):
        query = fts_query(" ".join(f"term{i}" for i in range(25)))
        self.assertEqual(query.count(" OR "), 16)
        self.assertIn('"term15"', query)
        self.assertNotIn('"term16"', query)

    def test_punctuation_and_case_are_normalised_away(self):
        self.assertEqual(fts_query("STAKING, Rewards!"), '"staking rewards" OR "staking" OR "rewards"')

    def test_digits_survive_as_terms(self):
        self.assertIn('"2024"', fts_query("networks 2024"))


class SourceAuthorityTests(unittest.TestCase):
    def test_ai_info_is_the_single_highest_authority_path(self):
        self.assertEqual(source_authority("https://everstake.com/ai-info", "canonical"), 1.36)

    def test_company_about_is_second_highest(self):
        self.assertEqual(source_authority("https://everstake.com/company/about", "site"), 1.30)

    def test_top_paths_win_regardless_of_declared_category(self):
        # The path check runs before the category check, so a mislabelled
        # canonical page is not demoted.
        self.assertEqual(source_authority("https://everstake.com/ai-info", "blog"), 1.36)

    def test_trailing_slash_does_not_demote_a_canonical_path(self):
        self.assertEqual(source_authority("https://everstake.com/ai-info/", "canonical"), 1.36)

    def test_site_docs_and_canonical_categories_share_one_tier(self):
        for category in ("site", "docs", "canonical"):
            with self.subTest(category=category):
                self.assertEqual(source_authority("https://everstake.com/staking", category), 1.16)

    def test_everstake_blog_ranks_below_site_pages(self):
        self.assertEqual(source_authority("https://everstake.com/resources/blog/news", "blog"), 1.0)

    def test_blog_path_is_excluded_from_the_site_tier_even_when_labelled_canonical(self):
        # Suspected quirk: an everstake.com blog URL labelled "canonical" falls
        # all the way to the third-party floor instead of the blog tier.
        self.assertEqual(source_authority("https://everstake.com/resources/blog/x", "canonical"), 0.82)

    def test_third_party_host_inherits_the_site_tier_from_its_category(self):
        # Suspected bug: the site/docs/canonical branch never checks the host,
        # so an off-domain page categorised "docs" outranks the Everstake blog.
        self.assertEqual(source_authority("https://medium.com/@everstake/post", "docs"), 1.16)

    def test_third_party_blog_gets_the_floor_authority(self):
        self.assertEqual(source_authority("https://cryptopotato.com/story", "blog"), 0.82)

    def test_unknown_category_gets_the_floor_authority(self):
        self.assertEqual(source_authority("https://everstake.com/whatever", "news"), 0.82)


class CosineTests(unittest.TestCase):
    def test_identical_vectors_score_one(self):
        self.assertAlmostEqual(cosine([1.0, 2.0, 3.0], (1.0, 2.0, 3.0)), 1.0)

    def test_orthogonal_vectors_score_zero(self):
        self.assertAlmostEqual(cosine([1.0, 0.0], (0.0, 1.0)), 0.0)

    def test_opposite_vectors_score_minus_one(self):
        self.assertAlmostEqual(cosine([1.0, 0.0], (-1.0, 0.0)), -1.0)

    def test_zero_vector_returns_zero_instead_of_raising(self):
        self.assertEqual(cosine([0.0, 0.0], (0.0, 0.0)), 0.0)

    def test_mismatched_dimensions_are_silently_truncated_by_zip(self):
        # Suspected bug: the dot product uses only the overlapping prefix while
        # each norm uses its full vector, so a truncated embedding can still
        # score a perfect 1.0 instead of failing loudly.
        self.assertAlmostEqual(cosine([1.0, 0.0, 0.0], (1.0, 0.0)), 1.0)


class UnpackTests(unittest.TestCase):
    def test_round_trips_the_indexer_packing(self):
        self.assertEqual(unpack(pack([1.5, -2.25, 0.0])), (1.5, -2.25, 0.0))

    def test_empty_blob_yields_an_empty_tuple(self):
        self.assertEqual(unpack(b""), ())

    def test_blob_not_a_multiple_of_four_bytes_raises(self):
        # Protects against a refactor that silently drops trailing bytes of a
        # corrupted embedding instead of surfacing the corruption.
        with self.assertRaises(struct.error):
            unpack(b"abcde")


class EvidenceDateTests(unittest.TestCase):
    def test_modified_date_wins_over_published_and_fetched(self):
        item = Evidence(1, 1, "t", "u", "x", "2020-01-01", "2026-02-02", "2026-09-01", 1, "site", 0.1)
        self.assertEqual(item.evidence_date, "2026-02-02")

    def test_published_date_is_used_when_modified_is_missing(self):
        item = Evidence(1, 1, "t", "u", "x", "2020-01-01", None, "2026-09-01", 1, "site", 0.1)
        self.assertEqual(item.evidence_date, "2020-01-01")

    def test_fetched_timestamp_is_truncated_to_a_date_as_last_resort(self):
        item = Evidence(1, 1, "t", "u", "x", None, None, "2026-05-06T12:00:00Z", 1, "site", 0.1)
        self.assertEqual(item.evidence_date, "2026-05-06")


class YearParsingTests(unittest.TestCase):
    def test_missing_date_is_treated_as_2020(self):
        self.assertEqual(_year(None), 2020)

    def test_pre_2000_year_is_not_recognised_and_defaults_to_2020(self):
        # The regex only matches 20xx, so a 1999 date is scored as 2020.
        self.assertEqual(_year("1999-01-01"), 2020)

    def test_first_twenty_first_century_year_in_the_string_wins(self):
        self.assertEqual(_year("crawled 2026 from a 2020 archive"), 2026)


class AdjudicationTests(unittest.TestCase):
    def test_non_factual_mode_passes_evidence_through_untouched(self):
        evidence = [make_evidence("https://a"), make_evidence("https://b")]
        self.assertEqual(adjudicate_evidence("Who is the CEO?", "synthesis", evidence), evidence)

    def test_leadership_question_falls_back_to_all_evidence_when_no_canonical_page_matched(self):
        evidence = [make_evidence("https://everstake.com/resources/blog/x")]
        self.assertEqual(adjudicate_evidence("Who is the CEO?", "factual", evidence), evidence)

    def test_company_about_also_counts_as_canonical_for_leadership(self):
        about = make_evidence("https://everstake.com/company/about")
        blog = make_evidence("https://everstake.com/resources/blog/old-ceo")
        self.assertEqual(adjudicate_evidence("Who is the president?", "factual", [blog, about]), [about])

    def test_mcp_endpoint_question_puts_canonical_before_the_product_page(self):
        result = adjudicate_evidence(
            "What is the MCP endpoint URL?",
            "factual",
            [make_evidence("https://everstake.com/mcp"),
             make_evidence("https://everstake.com/ai-info"),
             make_evidence("https://other.example/x")],
        )
        self.assertEqual([item.url for item in result],
                         ["https://everstake.com/ai-info", "https://everstake.com/mcp"])

    def test_metrics_question_promotes_canonical_and_the_staking_page(self):
        result = adjudicate_evidence(
            "How many networks does Everstake support?",
            "factual",
            [make_evidence("https://everstake.com/staking"),
             make_evidence("https://everstake.com/ai-info"),
             make_evidence("https://other.example/x")],
        )
        self.assertEqual([item.url for item in result],
                         ["https://everstake.com/ai-info", "https://everstake.com/staking"])

    def test_compliance_question_promotes_the_dora_assessment(self):
        dora = make_evidence("https://everstake.com/blog/dora-controls-assessment")
        other = make_evidence("https://other.example/x")
        self.assertEqual(adjudicate_evidence("What certifications exist?", "factual", [other, dora]), [dora])

    def test_question_matching_no_contract_is_left_alone(self):
        evidence = [make_evidence("https://other.example/x")]
        self.assertEqual(adjudicate_evidence("What is staking?", "factual", evidence), evidence)


class IndexHarness(unittest.TestCase):
    """Builds a throwaway SQLite index; `embed` is patched at the retrieval
    module boundary so app/api_clients.py is never entered."""

    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        self.database = Path(self._directory.name) / "index.sqlite3"
        connection = sqlite3.connect(self.database)
        connection.executescript(SCHEMA)
        self.connection = connection

    def add_document(self, document_id, url, category="site", tier=1,
                     modified="2026-01-01", is_canonical=1):
        self.connection.execute(
            "INSERT INTO documents(id,url,final_url,title,category,tier,language,published_at,"
            "modified_at,fetched_at,duplicate_group,is_canonical,injection_hits,removed_passages,word_count)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (document_id, url, url, f"Title {document_id}", category, tier, "en", None, modified,
             "2026-09-01T00:00:00Z", document_id, is_canonical, 0, "[]", 100),
        )

    def add_chunk(self, chunk_id, document_id, vector=(1.0, 0.0), text="alpha beta gamma delta"):
        # The default text deliberately does NOT match the default question, so
        # the BM25 term is zero and score ratios isolate authority and recency.
        self.connection.execute(
            "INSERT INTO chunks(id,document_id,position,text,embedding) VALUES(?,?,?,?,?)",
            (chunk_id, document_id, chunk_id, text, pack(list(vector))),
        )

    def finish(self):
        self.connection.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
        self.connection.commit()
        self.connection.close()

    def retrieve(self, question="staking rewards", **kwargs):
        fake_embed = lambda texts: ([[1.0, 0.0]], {"input_tokens": 0, "cost_usd": 0.0, "model": "fake"})
        with patch.object(retrieval, "embed", fake_embed):
            return retrieval.retrieve(question, database=self.database, **kwargs)


class RetrieveRankingTests(IndexHarness):
    def test_non_canonical_documents_are_never_retrieved(self):
        self.add_document(1, "https://everstake.com/a")
        self.add_document(2, "https://everstake.com/duplicate", is_canonical=0)
        self.add_chunk(1, 1)
        self.add_chunk(2, 2)
        self.finish()
        evidence, _ = self.retrieve()
        self.assertEqual([item.document_id for item in evidence], [1])

    def test_at_most_three_chunks_per_document_are_selected(self):
        # Without this cap one long canonical page crowds out every other source.
        self.add_document(1, "https://everstake.com/a")
        self.add_document(2, "https://everstake.com/b")
        for chunk_id in range(1, 6):
            self.add_chunk(chunk_id, 1)
        self.add_chunk(6, 2)
        self.finish()
        evidence, _ = self.retrieve()
        self.assertEqual(sum(1 for item in evidence if item.document_id == 1), 3)
        self.assertIn(2, [item.document_id for item in evidence])

    def test_limit_caps_the_returned_evidence(self):
        for index in range(1, 6):
            self.add_document(index, f"https://everstake.com/p{index}")
            self.add_chunk(index, index)
        self.finish()
        evidence, _ = self.retrieve(limit=2)
        self.assertEqual(len(evidence), 2)

    def test_canonical_page_outranks_a_blog_copy_with_identical_semantics(self):
        self.add_document(1, "https://everstake.com/resources/blog/news", category="blog")
        self.add_document(2, "https://everstake.com/ai-info", category="canonical")
        self.add_chunk(1, 1)
        self.add_chunk(2, 2)
        self.finish()
        evidence, _ = self.retrieve()
        self.assertEqual(evidence[0].url, "https://everstake.com/ai-info")

    def test_tier_two_source_is_discounted_against_an_identical_tier_one_source(self):
        self.add_document(1, "https://everstake.com/a", tier=2)
        self.add_document(2, "https://everstake.com/b", tier=1)
        self.add_chunk(1, 1)
        self.add_chunk(2, 2)
        self.finish()
        evidence, _ = self.retrieve()
        self.assertEqual(evidence[0].document_id, 2)
        self.assertAlmostEqual(evidence[1].score / evidence[0].score, 0.82, places=6)

    def test_older_document_is_demoted_when_prefer_recent_is_on(self):
        self.add_document(1, "https://everstake.com/old", modified="2018-01-01")
        self.add_document(2, "https://everstake.com/new", modified="2026-01-01")
        self.add_chunk(1, 1)
        self.add_chunk(2, 2)
        self.finish()
        evidence, _ = self.retrieve(prefer_recent=True)
        self.assertEqual(evidence[0].url, "https://everstake.com/new")
        self.assertLess(evidence[1].score, evidence[0].score)

    def test_recency_decay_is_disabled_when_prefer_recent_is_off(self):
        self.add_document(1, "https://everstake.com/old", modified="2018-01-01")
        self.add_document(2, "https://everstake.com/new", modified="2026-01-01")
        self.add_chunk(1, 1)
        self.add_chunk(2, 2)
        self.finish()
        evidence, _ = self.retrieve(prefer_recent=False)
        self.assertAlmostEqual(evidence[0].score, evidence[1].score, places=6)

    def test_recency_decay_bottoms_out_at_zero_point_seven_two(self):
        # A 1970s-era document must not be scored to zero; the floor keeps very
        # old but still-canonical pages retrievable.
        self.add_document(1, "https://everstake.com/ancient", modified="2001-01-01")
        self.add_document(2, "https://everstake.com/fresh", modified=f"{datetime.now(timezone.utc).year}-01-01")
        self.add_chunk(1, 1)
        self.add_chunk(2, 2)
        self.finish()
        evidence, _ = self.retrieve(prefer_recent=True)
        by_url = {item.url: item.score for item in evidence}
        ratio = by_url["https://everstake.com/ancient"] / by_url["https://everstake.com/fresh"]
        self.assertAlmostEqual(ratio, 0.72, places=6)

    def test_lexical_match_boosts_a_chunk_above_a_semantically_identical_one(self):
        # Both chunks embed identically, so only the BM25 half of the hybrid
        # score can separate them.
        self.add_document(1, "https://everstake.com/a")
        self.add_document(2, "https://everstake.com/b")
        self.add_chunk(1, 1, text="alpha beta gamma delta")
        self.add_chunk(2, 2, text="staking rewards are paid to delegators")
        self.finish()
        evidence, _ = self.retrieve("staking rewards")
        self.assertEqual(evidence[0].document_id, 2)
        self.assertAlmostEqual(evidence[0].score - evidence[1].score, 0.28 * 1.16, places=6)

    def test_top_score_is_reported_in_usage(self):
        self.add_document(1, "https://everstake.com/ai-info", category="canonical")
        self.add_chunk(1, 1)
        self.finish()
        evidence, usage = self.retrieve()
        self.assertEqual(usage["top_score"], round(evidence[0].score, 4))

    def test_top_score_is_zero_for_an_empty_index(self):
        self.finish()
        evidence, usage = self.retrieve()
        self.assertEqual(evidence, [])
        self.assertEqual(usage["top_score"], 0)

    def test_missing_fts_table_degrades_to_semantic_only_instead_of_raising(self):
        self.add_document(1, "https://everstake.com/a")
        self.add_chunk(1, 1)
        self.connection.execute("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')")
        self.connection.execute("DROP TABLE chunks_fts")
        self.connection.commit()
        self.connection.close()
        evidence, _ = self.retrieve()
        self.assertEqual(len(evidence), 1)
        # 0.72 * semantic(1.0) * authority(1.16) * recency(1.0), no lexical term.
        self.assertAlmostEqual(evidence[0].score, 0.72 * 1.16, places=6)


class AnswerPostProcessingTests(IndexHarness):
    """The deterministic half of answer(): mode routing, the confidence floor,
    citation filtering and the as_of contract.

    Both `embed` and `generate_json` are patched at the retrieval module
    boundary, so app/api_clients.py is never entered.
    """

    def answer(self, question="staking rewards", mode="auto", generated=None):
        fake_embed = lambda texts: ([[1.0, 0.0]], {"input_tokens": 0, "cost_usd": 0.0, "model": "fake"})
        self.generator_calls = []

        def fake_generate_json(prompt, operation="answer"):
            self.generator_calls.append(prompt)
            return dict(generated or {}), {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "model": "fake"}

        with patch.object(retrieval, "embed", fake_embed), \
             patch.object(retrieval, "generate_json", fake_generate_json):
            return retrieval.answer(question, mode, database=self.database)

    def two_documents(self):
        self.add_document(1, "https://everstake.com/a", modified="2023-01-01")
        self.add_document(2, "https://everstake.com/b", modified="2026-05-06")
        self.add_chunk(1, 1)
        self.add_chunk(2, 2)
        self.finish()

    def test_auto_mode_routes_trajectory_wording_to_synthesis(self):
        self.two_documents()
        for question in ("How has staking changed?", "revenue over time",
                         "the trajectory of alpha", "a shift in alpha", "growth after 2024"):
            with self.subTest(question=question):
                result = self.answer(question, "auto", {"answer": "x", "citations": [1, 2], "sufficient": True})
                self.assertEqual(result["mode"], "synthesis")

    def test_auto_mode_defaults_to_factual_for_a_plain_lookup(self):
        self.two_documents()
        result = self.answer("Who is the CEO?", "auto", {"answer": "x", "citations": [1], "sufficient": True})
        self.assertEqual(result["mode"], "factual")

    def test_an_explicit_mode_is_not_overridden(self):
        self.two_documents()
        result = self.answer("How has staking changed?", "factual",
                             {"answer": "x", "citations": [1], "sufficient": True})
        self.assertEqual(result["mode"], "factual")

    def test_retrieval_below_the_confidence_floor_abstains_without_calling_the_generator(self):
        # Cost and hallucination control: a weak match never reaches the model.
        self.add_document(1, "https://everstake.com/a")
        self.add_chunk(1, 1, vector=(0.1, 1.0))
        self.finish()
        result = self.answer("staking rewards", "factual", {"answer": "x", "citations": [1], "sufficient": True})
        self.assertEqual(self.generator_calls, [])
        self.assertFalse(result["sufficient"])
        self.assertEqual(result["reasoning"], "Retrieval confidence was below the evidence threshold.")
        self.assertEqual(result["answer"], "No reliable answer was found in the corpus.")

    def test_an_empty_index_abstains_without_calling_the_generator(self):
        self.finish()
        result = self.answer()
        self.assertEqual(self.generator_calls, [])
        self.assertEqual(result["sources"], [])

    def test_evidence_is_presented_to_the_generator_as_numbered_xml_blocks(self):
        self.two_documents()
        self.answer("staking rewards", "factual", {"answer": "x", "citations": [1], "sufficient": True})
        prompt = self.generator_calls[0]
        self.assertIn('<evidence id="1" tier="1" date="2026-05-06" url="https://everstake.com/b">', prompt)
        self.assertIn("</evidence>", prompt)

    def test_a_citation_id_the_generator_invented_is_dropped_and_forces_abstention(self):
        self.two_documents()
        result = self.answer("staking rewards", "factual", {"answer": "Forged", "citations": [99], "sufficient": True})
        self.assertEqual(result["citations"], [])
        self.assertFalse(result["sufficient"])
        self.assertEqual(result["answer"], "No reliable answer was found in the corpus.")

    def test_non_integer_citations_are_dropped(self):
        self.two_documents()
        result = self.answer("staking rewards", "factual", {"answer": "x", "citations": ["1"], "sufficient": True})
        self.assertFalse(result["sufficient"])

    def test_two_chunks_of_one_document_collapse_to_a_single_citation_by_url(self):
        # Deduplication is by URL, not by evidence id, so a page cited twice
        # yields one source.
        self.add_document(1, "https://everstake.com/a")
        self.add_chunk(1, 1)
        self.add_chunk(2, 1)
        self.finish()
        result = self.answer("staking rewards", "factual", {"answer": "x", "citations": [1, 2], "sufficient": True})
        self.assertEqual(result["citations"], [1])
        self.assertEqual(len(result["sources"]), 1)

    def test_synthesis_needs_two_surviving_citations(self):
        self.add_document(1, "https://everstake.com/a")
        self.add_chunk(1, 1)
        self.add_chunk(2, 1)
        self.finish()
        result = self.answer("How has it changed?", "synthesis",
                             {"answer": "Trend", "citations": [1, 2], "sufficient": True})
        self.assertFalse(result["sufficient"])

    def test_a_generator_that_reports_insufficient_is_believed(self):
        self.two_documents()
        result = self.answer("staking rewards", "factual", {"answer": "x", "citations": [1], "sufficient": False})
        self.assertFalse(result["sufficient"])
        self.assertIsNone(result["as_of"])

    def test_a_missing_as_of_falls_back_to_the_newest_cited_evidence_date(self):
        self.two_documents()
        result = self.answer("staking rewards", "factual", {"answer": "x", "citations": [1, 2], "sufficient": True})
        self.assertEqual(result["as_of"], "2026-05-06")

    def test_a_generator_supplied_as_of_is_passed_through_unchanged(self):
        self.two_documents()
        result = self.answer("staking rewards", "factual",
                             {"answer": "x", "citations": [1], "as_of": "2026-01-02", "sufficient": True})
        self.assertEqual(result["as_of"], "2026-01-02")

    def test_sources_expose_title_url_date_and_tier(self):
        self.two_documents()
        result = self.answer("staking rewards", "factual", {"answer": "x", "citations": [1], "sufficient": True})
        self.assertEqual(set(result["sources"][0]), {"title", "url", "date", "tier"})

    def test_usage_reports_both_the_embedding_and_generation_legs(self):
        self.two_documents()
        result = self.answer("staking rewards", "factual", {"answer": "x", "citations": [1], "sufficient": True})
        self.assertEqual(set(result["usage"]), {"embedding", "generation"})
        self.assertIsNotNone(result["usage"]["generation"])

    def test_generation_usage_is_none_when_the_confidence_floor_short_circuits(self):
        self.finish()
        self.assertIsNone(self.answer()["usage"]["generation"])

    def test_a_successful_answer_exposes_the_documented_key_set(self):
        self.two_documents()
        result = self.answer("staking rewards", "factual", {"answer": "x", "citations": [1], "sufficient": True})
        self.assertEqual(set(result), {"answer", "as_of", "citations", "sources",
                                       "sufficient", "mode", "usage", "reasoning"})

    def test_a_missing_reasoning_field_becomes_an_empty_string(self):
        self.two_documents()
        result = self.answer("staking rewards", "factual", {"answer": "x", "citations": [1], "sufficient": True})
        self.assertEqual(result["reasoning"], "")


if __name__ == "__main__":
    unittest.main()
