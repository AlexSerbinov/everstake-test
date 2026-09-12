# Task: freshness policy with a live cost calculator (queued for both agents after the cost task)

Goal: the corpus must stay current, and the person operating the system must *see* what each freshness policy costs before choosing it.

## What to build

1. **Freshness policy per source type**, configurable: live pages (about/team/product), blog, docs, reports/events, GitHub, video, third-party press. For each: re-check interval (from "every hour" to "monthly" to "never"), depth ("cheap check only" = sitemap lastmod + conditional GET/ETag + content hash; "re-extract facts on change" = run the extractor on changed docs only; "full re-index"), and for GitHub: "commits since last check → summarise the diff" instead of re-reading everything.
2. **A scheduler** that actually runs it (a lightweight in-process cron or a documented external cron/systemd timer) and a **changes log** (what changed since last run: new pages, changed pages, facts that changed value). The UI shows "last refreshed", "what changed".
3. **The calculator in the UI**: sliders / dropdowns per source type (interval, depth) and, computed live from the *measured* unit costs in the cost ledger (per-page fetch time, per-doc extraction $, per-chunk embedding $, per-run overhead): monthly cost in $, model tokens, machine minutes, and how stale the data can be at worst. Show three presets (Economy / Balanced / Real-time) and a custom mode. Change a slider → the numbers and a small bar chart update instantly. Plain language ("Checking the blog daily costs about $0.40/month and finds a new post within 24 hours").
4. **Docs**: a section in REPORT.md (policy chosen for the demo and why, with the numbers) and the assumptions of the calculator stated in the UI (prices as of a date, hardware).

Constraints: Gemini 3.x only; measured unit costs, not guesses; keep the code explainable; tests for the calculator math; do not `git push`.
