"""Characterization tests for app/crawler.py.

Only the offline parts: URL canonicalisation, HTML -> text extraction, date
extraction, and PoliteFetcher's robots handling with urlopen mocked out. No
socket is ever opened; crawl() and sitemap_urls() are not exercised.
"""

import unittest
import urllib.error
from unittest.mock import patch

from app.crawler import (
    ALLOWED_HOSTS,
    HTML_TYPES,
    USER_AGENT,
    PoliteFetcher,
    canonicalize,
    date_from_page,
    extract_html,
)
from bs4 import BeautifulSoup


class FakeResponse:
    """Minimal stand-in for the object urlopen yields as a context manager."""

    def __init__(self, body: bytes = b"", status: int = 200, headers: dict | None = None, url: str = ""):
        self._body = body
        self.status = status
        self.headers = headers or {}
        self.url = url

    def read(self, *_args):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class CanonicalizeTests(unittest.TestCase):
    def test_scheme_and_host_are_lowercased_but_the_path_is_not(self):
        self.assertEqual(canonicalize("HTTPS://EverStake.COM/PaTh"), "https://everstake.com/PaTh")

    def test_repeated_slashes_in_the_path_collapse(self):
        self.assertEqual(canonicalize("https://a.com//a//b"), "https://a.com/a/b")

    def test_trailing_slash_is_stripped(self):
        self.assertEqual(canonicalize("https://a.com/blog/"), "https://a.com/blog")

    def test_a_bare_origin_normalises_to_a_single_root_slash(self):
        self.assertEqual(canonicalize("https://a.com"), "https://a.com/")

    def test_fragments_are_dropped(self):
        self.assertEqual(canonicalize("https://a.com/p#section"), "https://a.com/p")

    def test_utm_ref_and_source_parameters_are_dropped_case_insensitively(self):
        self.assertEqual(canonicalize("https://a.com/p?UTM_source=x&REF=y&Source=z&keep=1"),
                         "https://a.com/p?keep=1")

    def test_blank_valued_parameters_are_kept(self):
        self.assertEqual(canonicalize("https://a.com/p?x=&y=1"), "https://a.com/p?x=&y=1")

    def test_remaining_parameter_order_is_preserved_not_sorted(self):
        # Two orderings of the same query stay distinct URLs.
        self.assertEqual(canonicalize("https://a.com/p?b=2&a=1"), "https://a.com/p?b=2&a=1")

    def test_query_values_are_re_encoded(self):
        self.assertEqual(canonicalize("https://a.com/p?q=a b"), "https://a.com/p?q=a+b")

    def test_a_schemeless_url_is_mangled_rather_than_defaulted_to_https_host(self):
        # Suspected bug: the "or https" default assumes a netloc is present, so
        # a bare "host/path" seed produces an unusable URL instead of
        # "https://everstake.com/x".
        self.assertEqual(canonicalize("everstake.com/x"), "https:everstake.com/x")

    def test_canonicalisation_is_idempotent(self):
        once = canonicalize("HTTPS://A.com//p/?utm_source=x&k=1#f")
        self.assertEqual(canonicalize(once), once)


class DateExtractionTests(unittest.TestCase):
    def parse(self, html: str):
        return date_from_page(BeautifulSoup(html, "html.parser"))

    def test_open_graph_article_times_are_read_from_meta_properties(self):
        published, modified = self.parse(
            '<meta property="article:published_time" content="2026-01-02T03:04:05Z">'
            '<meta property="article:modified_time" content="2026-02-03T00:00:00Z">'
        )
        self.assertEqual((published, modified), ("2026-01-02T03:04:05Z", "2026-02-03T00:00:00Z"))

    def test_meta_name_variants_are_also_accepted(self):
        published, modified = self.parse(
            '<meta name="date" content="2026-01-02">'
            '<meta name="last-modified" content="2026-02-03">'
        )
        self.assertEqual((published, modified), ("2026-01-02", "2026-02-03"))

    def test_meta_keys_are_matched_case_insensitively(self):
        published, _ = self.parse('<meta property="Article:Published_Time" content="2026-01-02">')
        self.assertEqual(published, "2026-01-02")

    def test_date_values_are_truncated_to_thirty_two_characters(self):
        published, _ = self.parse(f'<meta name="date" content="{"9" * 60}">')
        self.assertEqual(len(published), 32)

    def test_empty_meta_content_is_ignored(self):
        self.assertEqual(self.parse('<meta name="date" content="">'), (None, None))

    def test_json_ld_is_used_only_when_no_meta_tag_supplied_the_date(self):
        published, modified = self.parse(
            '<script type="application/ld+json">{"datePublished":"2020-01-01","dateModified":"2020-02-02"}</script>'
        )
        self.assertEqual((published, modified), ("2020-01-01", "2020-02-02"))

    def test_a_meta_tag_beats_json_ld_for_the_same_field(self):
        published, _ = self.parse(
            '<meta name="date" content="2026-01-02">'
            '<script type="application/ld+json">{"datePublished":"2020-01-01"}</script>'
        )
        self.assertEqual(published, "2026-01-02")

    def test_a_page_with_no_dates_yields_two_nones(self):
        self.assertEqual(self.parse("<p>no dates here</p>"), (None, None))


class ExtractHtmlTests(unittest.TestCase):
    def test_scripts_styles_navigation_and_footers_are_stripped_from_the_text(self):
        html = (b"<html><body><nav>NAVX</nav><style>CSSX</style><noscript>NOX</noscript>"
                b"<svg>SVGX</svg><main>Hello<script>SCRIPTX</script> world</main>"
                b"<footer>FOOTX</footer></body></html>")
        _, text, _, _, _ = extract_html(html)
        for removed in ("NAVX", "CSSX", "NOX", "SVGX", "SCRIPTX", "FOOTX"):
            self.assertNotIn(removed, text)
        self.assertEqual(text, "Hello\nworld")

    def test_main_wins_over_article_and_body(self):
        html = b"<html><body><article>ARTICLE</article><main>MAIN</main>TAIL</body></html>"
        _, text, _, _, _ = extract_html(html)
        self.assertEqual(text, "MAIN")

    def test_article_is_used_when_there_is_no_main(self):
        html = b"<html><body><article>ARTICLE</article><p>TAIL</p></body></html>"
        _, text, _, _, _ = extract_html(html)
        self.assertEqual(text, "ARTICLE")

    def test_body_is_the_final_fallback(self):
        _, text, _, _, _ = extract_html(b"<html><body><p>ONE</p><p>TWO</p></body></html>")
        self.assertEqual(text, "ONE\nTWO")

    def test_missing_title_becomes_untitled(self):
        title, _, _, _, _ = extract_html(b"<html><body><main>text</main></body></html>")
        self.assertEqual(title, "Untitled")

    def test_title_is_truncated_to_three_hundred_characters(self):
        html = ("<html><head><title>" + "T" * 400 + "</title></head><body><main>x</main></body></html>").encode()
        title, _, _, _, _ = extract_html(html)
        self.assertEqual(len(title), 300)

    def test_runs_of_three_or_more_newlines_collapse_to_a_blank_line(self):
        html = b"<html><body><main><p>A</p><div><br><br><br></div><p>B</p></main></body></html>"
        _, text, _, _, _ = extract_html(html)
        self.assertNotIn("\n\n\n", text)

    def test_relative_links_are_resolved_against_a_placeholder_host(self):
        # The returned link list is currently discarded by crawl(); it is
        # joined against https://invalid/ so relative hrefs are NOT usable.
        _, _, _, _, links = extract_html(b'<html><body><a href="/rel">L</a></body></html>')
        self.assertEqual(links, ["https://invalid/rel"])

    def test_absolute_links_survive_the_placeholder_join(self):
        _, _, _, _, links = extract_html(b'<html><body><a href="https://everstake.com/x">L</a></body></html>')
        self.assertEqual(links, ["https://everstake.com/x"])

    def test_structured_dates_are_read_before_the_scripts_are_decomposed(self):
        html = (b'<html><head><script type="application/ld+json">{"datePublished":"2026-06-15"}</script>'
                b"</head><body><main>text</main></body></html>")
        _, text, published, _, _ = extract_html(html)
        self.assertEqual(published, "2026-06-15")
        self.assertNotIn("datePublished", text)


class RobotsPolicyTests(unittest.TestCase):
    ROBOTS = b"User-agent: *\nDisallow: /private\n"

    def test_a_permitted_path_is_allowed_after_parsing_robots(self):
        fetcher = PoliteFetcher()
        with patch("urllib.request.urlopen", return_value=FakeResponse(self.ROBOTS)):
            self.assertTrue(fetcher._robots("https://everstake.com/x").can_fetch(USER_AGENT, "https://everstake.com/x"))

    def test_a_disallowed_path_is_refused(self):
        fetcher = PoliteFetcher()
        with patch("urllib.request.urlopen", return_value=FakeResponse(self.ROBOTS)):
            robots = fetcher._robots("https://everstake.com/private/y")
        self.assertFalse(robots.can_fetch(USER_AGENT, "https://everstake.com/private/y"))

    def test_an_unreachable_robots_file_fails_closed_and_blocks_everything(self):
        # Politeness contract: if the policy cannot be established, crawl nothing.
        fetcher = PoliteFetcher()
        with patch("urllib.request.urlopen", side_effect=urllib.error.URLError("down")):
            robots = fetcher._robots("https://a.com/x")
        self.assertFalse(robots.can_fetch(USER_AGENT, "https://a.com/anything"))

    def test_robots_is_fetched_once_per_origin_and_cached(self):
        fetcher = PoliteFetcher()
        with patch("urllib.request.urlopen", return_value=FakeResponse(self.ROBOTS)) as urlopen:
            fetcher._robots("https://everstake.com/a")
            fetcher._robots("https://everstake.com/b")
            self.assertEqual(urlopen.call_count, 1)
            fetcher._robots("https://docs.everstake.com/a")
            self.assertEqual(urlopen.call_count, 2)

    def test_the_cache_key_is_the_full_origin_including_scheme(self):
        fetcher = PoliteFetcher()
        with patch("urllib.request.urlopen", return_value=FakeResponse(self.ROBOTS)) as urlopen:
            fetcher._robots("https://a.com/x")
            fetcher._robots("http://a.com/x")
            self.assertEqual(urlopen.call_count, 2)
        self.assertEqual(set(fetcher.robots), {"https://a.com", "http://a.com"})

    def test_get_returns_none_for_a_robots_disallowed_url_without_requesting_it(self):
        fetcher = PoliteFetcher(delay=0)
        with patch("urllib.request.urlopen", return_value=FakeResponse(self.ROBOTS)) as urlopen:
            self.assertIsNone(fetcher.get("https://everstake.com/private/secret"))
            self.assertEqual(urlopen.call_count, 1)  # robots.txt only

    def test_get_returns_status_content_type_body_and_final_url(self):
        fetcher = PoliteFetcher(delay=0)
        page = FakeResponse(b"<html></html>", 200, {"Content-Type": "text/html"}, "https://everstake.com/final")
        with patch("urllib.request.urlopen", side_effect=[FakeResponse(self.ROBOTS), page]):
            result = fetcher.get("https://everstake.com/ok")
        self.assertEqual(result, (200, "text/html", b"<html></html>", "https://everstake.com/final"))

    def test_a_transport_error_on_the_page_yields_none_rather_than_raising(self):
        fetcher = PoliteFetcher(delay=0)
        with patch("urllib.request.urlopen", side_effect=[FakeResponse(self.ROBOTS), TimeoutError("slow")]):
            self.assertIsNone(fetcher.get("https://everstake.com/ok"))

    def test_a_failed_page_request_still_records_the_host_rate_limit_timestamp(self):
        fetcher = PoliteFetcher(delay=0)
        with patch("urllib.request.urlopen", side_effect=[FakeResponse(self.ROBOTS), TimeoutError("slow")]):
            fetcher.get("https://everstake.com/ok")
        self.assertGreater(fetcher.last_request["everstake.com"], 0)


class AllowlistConstantTests(unittest.TestCase):
    def test_the_everstake_owned_hosts_are_allowlisted(self):
        for host in ("everstake.com", "www.everstake.com", "docs.everstake.com", "security.everstake.com"):
            self.assertIn(host, ALLOWED_HOSTS)

    def test_an_arbitrary_host_is_not_allowlisted(self):
        self.assertNotIn("evil.example", ALLOWED_HOSTS)

    def test_only_html_content_types_are_accepted(self):
        self.assertEqual(HTML_TYPES, ("text/html", "application/xhtml+xml"))


if __name__ == "__main__":
    unittest.main()
