---
repo: mcp
url: https://github.com/everstake/mcp
language: Go
stars: 1
created: 2026-04-20
last_commit: 2026-08-25
license: (LICENSE file present, text not verified as SPDX-tagged)
topics: []
---

## What it is
The official Everstake **MCP (Model Context Protocol) server** — a Go service that exposes Everstake company/product/staking data as tools for AI agents (this very assistant's `mcp__everstake__*` tools come from this codebase). Built on `modelcontextprotocol/go-sdk`.

## What it does technically
- Two transports selectable via `MCP_TRANSPORT` env var: Streamable HTTP (MCP 2025-03-26 spec, single `/` endpoint, port 8080 default) or stdio.
- **11 tools**, split into three kinds: 7 *static* (`get_company_profile`, `get_products`, `get_solutions`, `get_developer_docs`, `get_contact_information`, `get_security_profile`, `get_integrations`) whose responses are literal text baked into `tools.yaml`; 2 *live* (`get_uptime_metrics`, `get_chains`, `staking_calculator`) that call a backend "Dashboard" API and cache results for 30 minutes (`internal/server/mcp/dashboard.go`, `pkg/everstake/dashboard/*`); 1 *write* tool (`request_integration`) that submits a lead to Everstake sales (`pkg/everstake/dashboard/leads.go`).
- Static tool content is data-driven: `tools.yaml` maps tool name → description + `static_response` (or a template for live tools), and `internal/assistant/config/mcp_config.go`'s `ToolsConfig` binds it via reflection + `yaml` struct tags — adding a tool means editing YAML + one config field + registering `staticTextTool()` in `internal/server/mcp/server.go`.
- Rate limiting via `golang.org/x/time/rate` token bucket, applied as Gin middleware (`internal/server/middleware/ratelimit.go`); disabled in stdio mode.
- Config loaded via `caarlos0/env` from environment variables (`DASHBOARD_URL` required, `PORT`, `GIN_MODE`, `DASHBOARD_API_KEY`).
- Linting is strict: golangci-lint with staticcheck (all checks), gosec, gocritic, revive (40+ rules), errchkjson, bodyclose, contextcheck; `.golangci.yml` forbids bare `//nolint`.
- Multi-stage Docker build (Go 1.26.1-alpine builder → alpine:3.21 runtime, non-root `app` user, `CGO_ENABLED=0` static binary).
- `glama.json` present — this MCP server is (or was intended to be) listed on the Glama MCP directory.
- Contains a `CLAUDE.md` — like `wallet-sdk`, this repo is explicitly documented for AI coding agents.

## Facts about Everstake it reveals
- `tools.yaml`'s embedded `get_company_profile` static response is a compact company fact sheet: founded 2018, HQ **Miami, FL, US** and **Grand Cayman, Cayman Islands**, legal entity **"Everstake Validation Services LLC"** (via Hermes Corporate Services Ltd., Grand Cayman), tagline **"Certified Yield Infrastructure for Institutions"**, 1.6M+ delegators, 130+ PoS networks, $7B+ staked, $700M+ rewards generated, 99.98% uptime, and claims to be the only validator certified across **SOC 2 Type II, ISO/IEC 27001, NIST CSF, ITGC, GDPR, CCPA simultaneously** (`tools.yaml`).
- `get_products` tool documents named products: **Institutional Staking, VaaS (Validator-as-a-Service), Yield, SWQOS, ShredStream** (README.md tool table) — "SWQOS" here still uses the old name even though the `everstake-swqos-docs` repo has since renamed the product "Landing" (as of its 2026-07-27 commit), and "ShredStream" is a Solana product not documented in any other repo examined.
- `get_integrations` names custody partners: **Fireblocks, BitGo, Anchorage, Coinbase, etc.** (README.md).
- Last commit (2026-08-25, PR #20) is "chore(DEV-3508): migrate apex website URLs to everstake.com" — the same `everstake.one` → `everstake.com` domain migration seen in `wallet-sdk`, dated slightly earlier, confirming an org-wide rebrand/domain cutover happening in mid-to-late 2026.
- This is the **live, authoritative source** behind the `mcp__everstake__*` tools available to AI assistants integrating with Everstake — the canonical machine-readable "about the company" dataset.

## Dates
- Created: 2026-04-20 — the youngest repo in the org.
- Last commit: 2026-08-25 (PR #20, domain migration).
- No git tags found; no CHANGELOG.

## Freshness signals
- `tools.yaml` is the single highest-value file to diff on every refresh — any change there directly changes what AI agents are told about the company (metrics, certifications, product list, contact routing).
- `go.mod`'s `github.com/modelcontextprotocol/go-sdk` version pin indicates protocol-spec compatibility drift.
- Dockerfile's Go/Alpine base image versions are a secondary freshness signal for infra currency.
