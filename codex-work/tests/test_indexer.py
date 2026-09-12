"""Characterization tests for app/indexer.py.

Covers tokenisation, fingerprinting, simhash near-duplicate detection, the
union-find grouping, chunking arithmetic and boilerplate detection. build() is
not exercised here because it calls embed().
"""

import unittest

from app.indexer import (
    chunks,
    content_fingerprint,
    duplicate_groups,
    line_signature,
    normalized_words,
    pack,
    repeated_boilerplate,
    simhash,
    title_similarity,
)
from app.retrieval import unpack


def paragraph(marker: str = "everstake", count: int = 60) -> str:
    return " ".join(f"{marker} sentence number {i} about staking" for i in range(count))


class TokenisationTests(unittest.TestCase):
    def test_words_are_lowercased_and_stripped_of_punctuation(self):
        self.assertEqual(normalized_words("Ever-stake's 2026, ETH!"), ["ever", "stake", "s", "2026", "eth"])

    def test_empty_text_yields_no_words(self):
        self.assertEqual(normalized_words("   \n "), [])

    def test_line_signature_collapses_whitespace_and_lowercases(self):
        self.assertEqual(line_signature("  Legal   Disclaimer\tHere  "), "legal disclaimer here")


class FingerprintTests(unittest.TestCase):
    def test_case_punctuation_and_whitespace_differences_share_a_fingerprint(self):
        # The same page served with different markup must dedupe.
        self.assertEqual(content_fingerprint("A  b\nC"), content_fingerprint("a b, c!"))

    def test_different_content_gets_a_different_fingerprint(self):
        self.assertNotEqual(content_fingerprint("alpha beta"), content_fingerprint("alpha gamma"))

    def test_word_order_changes_the_fingerprint(self):
        self.assertNotEqual(content_fingerprint("alpha beta"), content_fingerprint("beta alpha"))


class SimhashTests(unittest.TestCase):
    def test_identical_text_hashes_identically_and_deterministically(self):
        self.assertEqual(simhash("hello world foo bar baz"), simhash("hello world foo bar baz"))

    def test_a_small_trailing_edit_keeps_the_hamming_distance_tiny(self):
        base = paragraph()
        near = base + " one extra trailing clause here"
        self.assertLessEqual((simhash(base) ^ simhash(near)).bit_count(), 5)

    def test_unrelated_text_is_far_apart_in_hamming_distance(self):
        far = " ".join(f"completely different content block {i} zzz" for i in range(60))
        self.assertGreater((simhash(paragraph()) ^ simhash(far)).bit_count(), 12)

    def test_hash_fits_in_sixty_four_bits(self):
        self.assertLess(simhash("anything at all here"), 1 << 64)


class TitleSimilarityTests(unittest.TestCase):
    def test_case_and_punctuation_insensitive_exact_match_scores_one(self):
        self.assertEqual(title_similarity("Everstake Staking Guide", "everstake staking guide!"), 1.0)

    def test_disjoint_titles_score_zero(self):
        self.assertEqual(title_similarity("A B", "C D"), 0.0)

    def test_two_empty_titles_score_zero_rather_than_dividing_by_zero(self):
        self.assertEqual(title_similarity("", ""), 0.0)

    def test_half_overlap_scores_jaccard_not_containment(self):
        self.assertAlmostEqual(title_similarity("alpha beta", "beta gamma"), 1 / 3)


class DuplicateGroupTests(unittest.TestCase):
    def test_exact_duplicates_are_counted_as_exact_pairs_not_near_pairs(self):
        text = paragraph()
        groups, stats = duplicate_groups([{"text": text, "title": "A"}, {"text": text, "title": "B"}])
        self.assertEqual(groups, [1, 1])
        self.assertEqual(stats["exact_pairs"], 1)
        self.assertEqual(stats["near_duplicate_pairs"], 0)

    def test_near_duplicates_within_the_simhash_radius_are_merged(self):
        base = paragraph()
        near = base + " one extra trailing clause here"
        far = " ".join(f"completely different content block {i} zzz" for i in range(60))
        groups, stats = duplicate_groups([
            {"text": base, "title": "Everstake staking guide"},
            {"text": near, "title": "Everstake staking guide"},
            {"text": far, "title": "Other"},
        ])
        self.assertEqual(groups, [1, 1, 2])
        self.assertEqual(stats["near_duplicate_pairs"], 1)
        self.assertEqual(stats["duplicate_documents"], 1)

    def test_a_short_excerpt_is_not_merged_into_the_full_article(self):
        # The 0.72 length-ratio guard stops a teaser being treated as the page.
        groups, stats = duplicate_groups([
            {"text": paragraph(count=60), "title": "T"},
            {"text": paragraph(count=20), "title": "T"},
        ])
        self.assertEqual(groups, [1, 2])
        self.assertEqual(stats["near_duplicate_pairs"], 0)

    def test_grouping_is_transitive_through_union_find(self):
        base = paragraph()
        groups, stats = duplicate_groups([
            {"text": base, "title": "T"},
            {"text": base + " one extra trailing clause here", "title": "T"},
            {"text": base + " one extra trailing clause here x", "title": "T"},
        ])
        self.assertEqual(groups, [1, 1, 1])
        self.assertEqual(stats["unique_groups"], 1)
        self.assertEqual(stats["duplicate_documents"], 2)

    def test_group_ids_are_one_based_and_assigned_in_document_order(self):
        groups, _ = duplicate_groups([{"text": f"unique text {i} " * 40, "title": str(i)} for i in range(3)])
        self.assertEqual(groups, [1, 2, 3])

    def test_empty_corpus_reports_zero_groups(self):
        groups, stats = duplicate_groups([])
        self.assertEqual(groups, [])
        self.assertEqual(stats, {"exact_pairs": 0, "near_duplicate_pairs": 0,
                                 "unique_groups": 0, "duplicate_documents": 0})

    def test_stats_expose_exactly_the_four_documented_keys(self):
        _, stats = duplicate_groups([{"text": "a b c", "title": "t"}])
        self.assertEqual(set(stats), {"exact_pairs", "near_duplicate_pairs",
                                      "unique_groups", "duplicate_documents"})


class ChunkTests(unittest.TestCase):
    def test_stride_is_size_minus_overlap(self):
        output = chunks(" ".join(str(i) for i in range(200)), size=100, overlap=10)
        self.assertEqual([chunk.split()[0] for chunk in output], ["0", "90"])

    def test_a_trailing_chunk_shorter_than_thirty_words_is_discarded(self):
        # 200 words at stride 90 leaves a 20-word tail, which is dropped.
        output = chunks(" ".join(str(i) for i in range(200)), size=100, overlap=10)
        self.assertEqual([len(chunk.split()) for chunk in output], [100, 100])

    def test_text_shorter_than_the_minimum_produces_no_chunks(self):
        self.assertEqual(chunks("one two three"), [])

    def test_empty_text_produces_no_chunks(self):
        self.assertEqual(chunks(""), [])

    def test_whitespace_is_normalised_to_single_spaces_inside_a_chunk(self):
        output = chunks("word\n" * 40, size=620, overlap=80)
        self.assertEqual(output[0], " ".join(["word"] * 40))

    def test_overlap_equal_to_size_raises_instead_of_looping_forever(self):
        # Suspected robustness gap: chunks() has no argument validation, so a
        # bad call surfaces as a bare range() ValueError.
        with self.assertRaises(ValueError):
            chunks("word " * 100, size=100, overlap=100)


class BoilerplateTests(unittest.TestCase):
    LONG_LINE = "This is a long repeated legal disclaimer used as a website template across every article."

    def test_a_line_repeated_across_enough_documents_is_flagged(self):
        docs = [{"text": self.LONG_LINE + f"\nUnique {i}"} for i in range(10)]
        self.assertEqual(repeated_boilerplate(docs), {self.LONG_LINE.lower()})

    def test_lines_shorter_than_eighty_characters_are_never_flagged(self):
        docs = [{"text": "Short footer line."} for _ in range(50)]
        self.assertEqual(repeated_boilerplate(docs), set())

    def test_a_line_repeated_many_times_inside_one_document_counts_once(self):
        # Protects the "counting once per document" contract: a page that
        # repeats its own banner must not self-nominate as boilerplate.
        docs = [{"text": (self.LONG_LINE + "\n") * 20} for _ in range(3)]
        self.assertEqual(repeated_boilerplate(docs), set())

    def test_a_small_corpus_can_never_produce_boilerplate_because_of_the_floor_of_eight(self):
        # Suspected sharp edge: the threshold is max(8, 8% of docs), so a
        # 7-document corpus of identical templates yields nothing.
        docs = [{"text": self.LONG_LINE} for _ in range(7)]
        self.assertEqual(repeated_boilerplate(docs), set())
        self.assertEqual(repeated_boilerplate(docs + [{"text": self.LONG_LINE}]),
                         {self.LONG_LINE.lower()})

    def test_the_eight_percent_threshold_takes_over_on_a_large_corpus(self):
        # 200 documents => threshold ceil(8%) = 16.
        filler = lambda n: [{"text": f"unique {i}"} for i in range(n)]
        below = [{"text": self.LONG_LINE} for _ in range(15)] + filler(185)
        at_threshold = [{"text": self.LONG_LINE} for _ in range(16)] + filler(184)
        self.assertEqual(repeated_boilerplate(below), set())
        self.assertEqual(repeated_boilerplate(at_threshold), {self.LONG_LINE.lower()})

    def test_signatures_are_returned_lowercased_and_whitespace_collapsed(self):
        spaced = "  " + self.LONG_LINE.upper().replace(" ", "   ") + "  "
        docs = [{"text": spaced} for _ in range(10)]
        self.assertEqual(repeated_boilerplate(docs), {self.LONG_LINE.lower()})


class PackingTests(unittest.TestCase):
    def test_pack_produces_four_bytes_per_dimension(self):
        self.assertEqual(len(pack([0.0] * 512)), 2048)

    def test_pack_and_unpack_round_trip_exactly_for_float32_safe_values(self):
        self.assertEqual(unpack(pack([1.5, -2.25, 0.0])), (1.5, -2.25, 0.0))

    def test_float64_precision_is_lost_on_the_round_trip(self):
        # Embeddings are stored as float32; a refactor must not assume exact
        # equality with the original Python floats.
        self.assertNotEqual(unpack(pack([0.1]))[0], 0.1)
        self.assertAlmostEqual(unpack(pack([0.1]))[0], 0.1, places=7)


if __name__ == "__main__":
    unittest.main()
