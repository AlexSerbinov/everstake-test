"""Characterization tests for app/audit.py: the signed hash-chain receipt.

Every test redirects AUDIT_LOG and AUDIT_KEY into a TemporaryDirectory, so the
real data/answer-audit.jsonl is never touched.
"""

import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.audit import append_answer, canonical, get_record, public_key_b64, sha256_text

RESULT = {"answer": "Everstake supports 85 networks.", "as_of": "2026-01-01", "sufficient": True}
EVIDENCE = [{"ref": "E1", "url": "https://everstake.com/ai-info", "content_sha256": "a" * 64}]


class AuditLogHarness(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.log = self.root / "audit.jsonl"
        self.key = self.root / "audit.key"
        for target in ("app.audit.AUDIT_LOG",):
            patcher = patch(target, self.log)
            patcher.start()
            self.addCleanup(patcher.stop)
        patcher = patch("app.audit.AUDIT_KEY", self.key)
        patcher.start()
        self.addCleanup(patcher.stop)

    def records(self):
        return [json.loads(line) for line in self.log.read_text().splitlines() if line.strip()]


class CanonicalisationTests(unittest.TestCase):
    def test_keys_are_sorted_and_separators_are_compact(self):
        self.assertEqual(canonical({"b": 1, "a": [1, 2]}), b'{"a":[1,2],"b":1}')

    def test_non_ascii_is_preserved_rather_than_escaped(self):
        self.assertEqual(canonical({"k": "Ünïcode"}), '{"k":"Ünïcode"}'.encode())

    def test_sha256_text_matches_the_hex_digest_of_the_utf8_bytes(self):
        self.assertEqual(
            sha256_text("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        )


class ReceiptShapeTests(AuditLogHarness):
    def test_receipt_exposes_exactly_the_six_documented_fields(self):
        receipt = append_answer("Q", RESULT, EVIDENCE, [])
        self.assertEqual(set(receipt), {"id", "record_hash", "signature", "public_key",
                                        "evidence_hashes", "verify_url"})

    def test_verify_url_points_at_the_record_id(self):
        receipt = append_answer("Q", RESULT, EVIDENCE, [])
        self.assertEqual(receipt["verify_url"], f"/api/audit/{receipt['id']}")

    def test_evidence_hashes_are_copied_from_the_evidence_content_hashes(self):
        receipt = append_answer("Q", RESULT, EVIDENCE, [])
        self.assertEqual(receipt["evidence_hashes"], ["a" * 64])

    def test_record_id_is_a_uuid_and_unique_per_answer(self):
        first = append_answer("Q1", RESULT, [], [])
        second = append_answer("Q2", RESULT, [], [])
        self.assertEqual(len(first["id"]), 36)
        self.assertNotEqual(first["id"], second["id"])

    def test_the_stored_record_keeps_the_question_answer_and_tool_trace(self):
        trace = [{"tool": "corpus_search", "arguments": {"query": "x"}, "result": {}}]
        append_answer("Who?", RESULT, EVIDENCE, trace)
        record = self.records()[0]
        self.assertEqual(record["question"], "Who?")
        self.assertEqual(record["answer"], RESULT["answer"])
        self.assertEqual(record["as_of"], "2026-01-01")
        self.assertTrue(record["sufficient"])
        self.assertEqual(record["tool_trace"], trace)
        self.assertEqual(record["evidence"], EVIDENCE)

    def test_sufficient_defaults_to_false_when_the_result_omits_it(self):
        append_answer("Q", {"answer": "A"}, [], [])
        self.assertFalse(self.records()[0]["sufficient"])

    def test_each_answer_appends_exactly_one_jsonl_line(self):
        append_answer("Q1", RESULT, [], [])
        append_answer("Q2", RESULT, [], [])
        self.assertEqual(len(self.records()), 2)


class HashChainTests(AuditLogHarness):
    def test_the_first_record_chains_from_sixty_four_zeroes(self):
        append_answer("Q", RESULT, [], [])
        self.assertEqual(self.records()[0]["previous_hash"], "0" * 64)

    def test_each_record_chains_to_the_previous_record_hash(self):
        first = append_answer("Q1", RESULT, [], [])
        append_answer("Q2", RESULT, [], [])
        self.assertEqual(self.records()[1]["previous_hash"], first["record_hash"])

    def test_an_untampered_record_verifies(self):
        receipt = append_answer("Q", RESULT, EVIDENCE, [])
        self.assertTrue(get_record(receipt["id"])["verified"])

    def test_tampering_with_an_earlier_record_invalidates_every_later_one(self):
        # The chain must not let an attacker rewrite history and keep the tail
        # of the log looking valid.
        first = append_answer("Q1", RESULT, [], [])
        second = append_answer("Q2", RESULT, [], [])
        records = self.records()
        records[0]["answer"] = "tampered"
        self.log.write_text("".join(json.dumps(record) + "\n" for record in records))
        self.assertFalse(get_record(first["id"])["verified"])
        self.assertFalse(get_record(second["id"])["verified"])

    def test_a_forged_signature_fails_verification(self):
        receipt = append_answer("Q", RESULT, [], [])
        records = self.records()
        records[0]["signature"] = "AA" * 43 + "=="
        self.log.write_text(json.dumps(records[0]) + "\n")
        self.assertFalse(get_record(receipt["id"])["verified"])

    def test_a_broken_previous_hash_link_fails_verification(self):
        append_answer("Q1", RESULT, [], [])
        second = append_answer("Q2", RESULT, [], [])
        records = self.records()
        records[1]["previous_hash"] = "f" * 64
        self.log.write_text("".join(json.dumps(record) + "\n" for record in records))
        self.assertFalse(get_record(second["id"])["verified"])

    def test_get_record_returns_none_for_an_unknown_id(self):
        append_answer("Q", RESULT, [], [])
        self.assertIsNone(get_record("00000000-0000-0000-0000-000000000000"))

    def test_get_record_returns_none_when_no_log_exists_yet(self):
        self.assertIsNone(get_record("anything"))

    def test_the_returned_record_carries_the_public_key_for_offline_verification(self):
        receipt = append_answer("Q", RESULT, [], [])
        self.assertEqual(get_record(receipt["id"])["public_key"], receipt["public_key"])


class SigningKeyTests(AuditLogHarness):
    def test_the_key_is_generated_once_and_reused_across_answers(self):
        first = append_answer("Q1", RESULT, [], [])
        second = append_answer("Q2", RESULT, [], [])
        self.assertEqual(first["public_key"], second["public_key"])

    def test_the_key_file_is_created_with_owner_only_permissions(self):
        append_answer("Q", RESULT, [], [])
        self.assertEqual(stat.S_IMODE(os.stat(self.key).st_mode), 0o600)

    def test_the_raw_ed25519_key_is_thirty_two_bytes(self):
        append_answer("Q", RESULT, [], [])
        self.assertEqual(len(self.key.read_bytes()), 32)

    def test_public_key_is_base64_of_thirty_two_raw_bytes(self):
        import base64
        self.assertEqual(len(base64.b64decode(public_key_b64(self.key))), 32)


if __name__ == "__main__":
    unittest.main()
