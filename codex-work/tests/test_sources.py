import unittest

from app.agent import _validate_submission
from app.consistency import consistency_pass
from app.sources import classify_voice, relevant_video, vtt_to_minute_transcript
from app.tools import RegisteredEvidence, ToolContext


class SourceDiscoveryTests(unittest.TestCase):
    def test_filter_rejects_lookalikes_shorts_and_missing_subtitles(self):
        base = {"title": "Everstake interview", "description": "", "duration": 600}
        self.assertEqual(relevant_video({**base, "title": "EverRise review"}, "Everstake " * 4)[1], "lookalike")
        self.assertEqual(relevant_video({**base, "duration": 59}, "Everstake " * 4)[1], "short")
        self.assertEqual(relevant_video(base, "")[1], "no_usable_subtitles")

    def test_voice_follows_speaker_not_host(self):
        voice, speakers = classify_voice("CoinDesk", "third", "Interview with Sergii Vasylchuk", "", "")
        self.assertEqual(voice, "employee_on_third_party")
        self.assertEqual(speakers[0]["name"], "Sergii Vasylchuk")

    def test_vtt_keeps_minute_markers(self):
        text = vtt_to_minute_transcript("WEBVTT\n\n00:00:02.000 --> 00:00:05.000\nHello\n\n00:01:03.000 --> 00:01:06.000\nWorld\n")
        self.assertEqual(text, "[00:00] Hello\n[01:00] World")


class ConsistencyAndAnswerSafetyTests(unittest.TestCase):
    def test_two_verified_contradictions_halve_document_trust(self):
        docs = [
            {"title": "Official", "text": "Everstake supports 80 networks. Its fee is 7%.", "tier": 1,
             "voice": "first_party_channel", "provenance": "stated", "published_at": "2026-01-01"},
            {"title": "Report", "text": "Everstake supports 999 networks. Its fee is 50%.", "tier": 2,
             "voice": "third_party", "provenance": "reported", "published_at": "2026-02-01"},
        ]
        facts, stats = consistency_pass(docs)
        self.assertEqual(docs[1]["trust_penalty"], 0.5)
        self.assertEqual(stats["contradictions"], 2)
        self.assertTrue(any(fact.get("contradiction") for fact in facts))

    def test_unverified_evidence_is_excluded_for_an_ordinary_question(self):
        context = ToolContext()
        context._register(RegisteredEvidence("", "Claim", "https://example.com", "2026-01-01", "Claim",
                                             "corpus_snapshot", 1, "third_party", [], "Publisher",
                                             "reported", 1.0, None, 1))
        result = _validate_submission({"answer": "It happened.", "citations": ["E1"], "sufficient": True},
                                      context, "factual", "Did it happen?")
        self.assertFalse(result["sufficient"])

    def test_reported_number_requires_according_to_and_date(self):
        context = ToolContext()
        context._register(RegisteredEvidence("", "Report", "https://example.com", "2025-01-02", "Fee 8%",
                                             "corpus_snapshot", 1, "third_party", [], "Publisher", "reported"))
        bad = _validate_submission({"answer": "The fee was 8%.", "citations": ["E1"], "sufficient": True},
                                   context, "factual", "What did reports say?")
        good = _validate_submission({"answer": "According to Publisher (2025-01-02), the fee was 8%.",
                                     "citations": ["E1"], "sufficient": True}, context, "factual",
                                    "What did reports say?")
        self.assertFalse(bad["sufficient"])
        self.assertTrue(good["sufficient"])

    def test_negative_third_party_claim_needs_claim_and_unverified_labels(self):
        context = ToolContext()
        context._register(RegisteredEvidence("", "Report", "https://example.com", "2025-01-02", "Allegation",
                                             "corpus_snapshot", 1, "third_party", [], "Publisher", "reported"))
        bad = _validate_submission({"answer": "Everstake committed fraud.", "citations": ["E1"], "sufficient": True},
                                   context, "factual", "What claims were reported?")
        good = _validate_submission({"answer": "Publisher claims fraud (unverified).", "citations": ["E1"],
                                     "sufficient": True}, context, "factual", "What claims were reported?")
        self.assertFalse(bad["sufficient"])
        self.assertTrue(good["sufficient"])


if __name__ == "__main__":
    unittest.main()
