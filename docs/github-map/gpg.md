---
repo: gpg
url: https://github.com/everstake/gpg
language: none (Markdown only)
stars: 0
created: 2022-06-17
last_commit: 2024-01-19
license: none found
topics: []
---

## What it is
Not code — a one-page instructional README describing how external researchers should encrypt vulnerability reports for Everstake using GPG.

## What it does technically
- No executables. Documents the `gpg --full-gen-key` / `gpg --import` / `gpg -r security@everstake.one -e <file>` workflow.
- Links to Everstake's published PGP public key and a keyserver lookup.

## Facts about Everstake it reveals
- Everstake's security contact address: `security@everstake.one` (README.md).
- Published PGP key fingerprint: `DC4086E9056C17234D62A44E302F408B14F95372`, RSA4096, created 2022-05-27, expires 2027-05-26 (README.md).
- Vulnerability disclosure policy page: `https://everstake.one/security/report-vulnerability` (README.md, repo homepage field) — note this is on the legacy `everstake.one` domain, not `everstake.com` (see `mcp` and `wallet-sdk` repos, which are actively migrating to `.com`).

## Dates
- Created: 2022-06-17.
- Last commit: 2024-01-19 ("Fix page URL").
- No tags/releases (not applicable — it's a doc page).

## Freshness signals
Single Markdown file; freshness only trackable via git history. Content (key fingerprint, expiry) should be re-verified against the live `everstake.one/security` page periodically, especially the 2027 key expiry.
