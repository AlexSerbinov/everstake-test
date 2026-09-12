"""Characterization tests for the pure parts of app/tools.py.

Evidence registration/de-duplication, the tool dispatcher, the allow-list
rejections (which return before any socket is opened) and the SSE/JSON helpers.
The MCP and live-fetch happy paths are network calls and are not exercised.
"""

import json
import tempfile
import unittest
from pathlib import Path

from app.retrieval import Evidence
from app.tools import (
    LIVE_HOSTS,
    READ_ONLY_MCP_TOOLS,
    RegisteredEvidence,
    ToolContext,
    _enrich_synthesis_query,
    _model_evidence,
    _read_sse_json,
    _summary,
    load_tool_specs,
)

ALLOWLIST_ERROR = "URL is outside the live-fetch allowlist."
MCP_ERROR = "Only allow-listed read-only MCP tools are available."


class SynthesisQueryTests(unittest.TestCase):
    def test_positioning_queries_gain_company_evolution_vocabulary(self):
        enriched = _enrich_synthesis_query("How has positioning shifted?", "synthesis")
        self.assertIn("institutional infrastructure", enriched)

    def test_factual_queries_are_never_rewritten(self):
        query = "What is the current positioning?"
        self.assertEqual(_enrich_synthesis_query(query, "factual"), query)


def registered(url="https://everstake.com/a", content="body", date="2026-01-01", title="T"):
    return RegisteredEvidence("", title, url, date, content, "corpus_snapshot", 1)


class FakeResponse:
    def __init__(self, text: str):
        self._text = text

    def read(self):
        return self._text.encode()


class ContextHarness(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        # A path that does not exist: every code path under test returns before
        # SQLite is opened, so this also proves no accidental DB access.
        self.context = ToolContext(Path(directory.name) / "absent.sqlite3")


class RegisteredEvidenceTests(unittest.TestCase):
    def test_audit_dict_adds_the_content_hash_to_every_field(self):
        item = registered()
        audit = item.audit_dict()
        self.assertEqual(set(audit), {"ref", "title", "url", "date", "content",
                                      "provenance", "document_id", "content_sha256", "voice", "speakers",
                                      "attribution", "claim_provenance", "trust_penalty",
                                      "trust_penalty_reason", "unverified_claims"})
        self.assertEqual(len(audit["content_sha256"]), 64)

    def test_document_id_defaults_to_none(self):
        self.assertIsNone(RegisteredEvidence("", "T", "u", "d", "c", "p").document_id)


class EvidenceRegistrationTests(ContextHarness):
    def test_refs_are_assigned_sequentially_starting_at_e1(self):
        first = self.context._register(registered(content="one"))
        second = self.context._register(registered(content="two"))
        self.assertEqual([first.ref, second.ref], ["E1", "E2"])

    def test_identical_url_and_content_returns_the_existing_registration(self):
        first = self.context._register(registered())
        second = self.context._register(registered())
        self.assertIs(first, second)
        self.assertEqual(len(self.context.evidence), 1)

    def test_the_same_url_with_different_content_gets_a_new_ref(self):
        # Two chunks of one page are distinct evidence and must be citable apart.
        self.context._register(registered(content="chunk one"))
        second = self.context._register(registered(content="chunk two"))
        self.assertEqual(second.ref, "E2")

    def test_the_same_content_on_a_different_url_gets_a_new_ref(self):
        self.context._register(registered(url="https://everstake.com/a"))
        second = self.context._register(registered(url="https://everstake.com/b"))
        self.assertEqual(second.ref, "E2")

    def test_a_retrieval_evidence_is_converted_and_marked_as_corpus_snapshot(self):
        item = Evidence(1, 7, "Title", "https://everstake.com/x", "text",
                        None, "2026-05-06T12:00:00Z", "2026-01-01", 1, "site", 0.5)
        registration = self.context._register(item)
        self.assertEqual(registration.provenance, "corpus_snapshot")
        self.assertEqual(registration.document_id, 7)
        self.assertEqual(registration.date, "2026-05-06")


class DispatcherTests(ContextHarness):
    def test_an_unknown_tool_name_raises_value_error(self):
        with self.assertRaises(ValueError) as caught:
            self.context.execute("delete_everything", {})
        self.assertIn("Unsupported tool: delete_everything", str(caught.exception))

    def test_the_call_counter_increments_even_for_a_rejected_tool_name(self):
        # Pinned as-is: the budget counter is bumped before validation, so a
        # hallucinated tool name still costs the agent a call.
        with self.assertRaises(ValueError):
            self.context.execute("nope", {})
        self.assertEqual(self.context.calls, 1)

    def test_a_rejected_tool_name_leaves_no_trace_entry(self):
        with self.assertRaises(ValueError):
            self.context.execute("nope", {})
        self.assertEqual(self.context.trace, [])

    def test_a_successful_call_records_name_arguments_and_summary_in_the_trace(self):
        self.context.execute("everstake_mcp", {"tool": "request_integration"})
        self.assertEqual(self.context.trace, [{
            "tool": "everstake_mcp",
            "arguments": {"tool": "request_integration"},
            "result": {"error": MCP_ERROR},
        }])


class LiveFetchAllowlistTests(ContextHarness):
    REJECTED = {
        "plain_http": "http://everstake.com/x",
        "off_domain_host": "https://evil.example/x",
        "lookalike_subdomain": "https://everstake.com.evil.example/x",
        "userinfo_smuggling": "https://everstake.com@evil.example/fake",
        "credentials_in_url": "https://user:pass@everstake.com/x",
        "file_scheme": "file:///etc/passwd",
        "non_allowlisted_everstake_subdomain": "https://stake.everstake.com/x",
    }

    def test_every_disallowed_url_shape_is_refused_with_one_message(self):
        for name, url in self.REJECTED.items():
            with self.subTest(case=name):
                self.assertEqual(self.context.live_fetch(url), {"error": ALLOWLIST_ERROR})

    def test_the_live_host_allowlist_is_narrower_than_the_crawl_allowlist(self):
        self.assertEqual(LIVE_HOSTS, {"everstake.com", "www.everstake.com", "docs.everstake.com",
                                      "security.everstake.com", "status.everstake.one"})


class McpAllowlistTests(ContextHarness):
    def test_mutating_mcp_tools_are_refused(self):
        for tool in ("request_integration", "get_contact_information", ""):
            with self.subTest(tool=tool):
                self.assertEqual(self.context.everstake_mcp(tool), {"error": MCP_ERROR})

    def test_the_read_only_allowlist_holds_exactly_the_six_documented_tools(self):
        self.assertEqual(READ_ONLY_MCP_TOOLS, {
            "get_chains", "get_uptime_metrics", "staking_calculator",
            "get_company_profile", "get_security_profile", "get_products",
        })

    def test_request_integration_is_deliberately_absent_from_the_allowlist(self):
        self.assertNotIn("request_integration", READ_ONLY_MCP_TOOLS)


class SummaryTests(unittest.TestCase):
    def test_an_error_result_is_summarised_as_the_error_alone(self):
        self.assertEqual(_summary({"error": "nope", "extra": 1}), {"error": "nope"})

    def test_a_single_evidence_dict_is_wrapped_in_a_list(self):
        result = {"evidence": {"ref": "E1", "title": "t", "date": "d",
                               "provenance": "p", "content_sha256": "s", "content": "long body"}}
        self.assertEqual(_summary(result), {"evidence": [
            {"ref": "E1", "title": "t", "date": "d", "provenance": "p", "content_sha256": "s"}
        ]})

    def test_the_full_content_is_never_copied_into_the_trace(self):
        # The audit trace must stay small; only the hash of the content goes in.
        result = {"evidence": [{"ref": "E1", "title": "t", "date": "d", "provenance": "p",
                                "content_sha256": "s", "content": "SECRET"}]}
        self.assertNotIn("SECRET", json.dumps(_summary(result)))

    def test_a_result_with_no_evidence_summarises_to_an_empty_list(self):
        self.assertEqual(_summary({}), {"evidence": []})


class ModelEvidenceTests(unittest.TestCase):
    def test_content_is_truncated_to_the_requested_limit(self):
        payload = _model_evidence(registered(content="x" * 5000), 2800)
        self.assertEqual(len(payload["content"]), 2800)

    def test_the_content_hash_covers_the_untruncated_content(self):
        # A citation hash must identify the whole chunk, not the model's view.
        full = registered(content="x" * 5000)
        self.assertEqual(_model_evidence(full, 10)["content_sha256"], full.audit_dict()["content_sha256"])

    def test_the_default_limit_is_two_thousand_eight_hundred_characters(self):
        self.assertEqual(len(_model_evidence(registered(content="x" * 5000))["content"]), 2800)


class SseParsingTests(unittest.TestCase):
    def test_a_data_line_is_parsed_out_of_an_event_stream(self):
        self.assertEqual(_read_sse_json(FakeResponse('event: message\ndata: {"a":1}\n')), {"a": 1})

    def test_the_first_data_line_wins(self):
        self.assertEqual(_read_sse_json(FakeResponse('data: {"a":1}\ndata: {"a":2}\n')), {"a": 1})

    def test_a_plain_json_body_is_parsed_directly(self):
        self.assertEqual(_read_sse_json(FakeResponse('{"b":2}')), {"b": 2})

    def test_an_empty_body_yields_an_empty_dict(self):
        self.assertEqual(_read_sse_json(FakeResponse("   \n ")), {})


class ToolSpecTests(unittest.TestCase):
    def test_the_declared_tool_names_match_the_dispatcher_plus_submit_answer(self):
        names = [spec["name"] for spec in load_tool_specs()]
        self.assertEqual(names, ["corpus_search", "fact_number_lookup", "document_read",
                                 "live_fetch", "everstake_mcp", "submit_answer"])


if __name__ == "__main__":
    unittest.main()
