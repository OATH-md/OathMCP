# Changelog

All notable changes to OathMCP are documented here.

## Unreleased

## 0.2.1 — 2026-08-15

- Published the first public npm package as `@oath-md/oath-mcp`, while
  preserving the `oath-mcp` executable, server identity, Worker names, and
  canonical hosted endpoint.
- Made verified npm publication mandatory for future release tags after the
  Cloudflare cutover and before GitHub release creation, using a protected
  trusted-publishing environment without a stored npm token.
- Added clean packed-consumer checks on Node.js 22 and 24 for both public
  exports and declarations, the installed executable, modern and legacy MCP
  clients, the 40-calculator catalog, BMI, FIB-4, evidence, package hygiene,
  and the runtime dependency audit.
- Refreshed the moved NASA Glenn metric-atmosphere citation to its current
  official page. Clinical formulas, MCP behavior, and hosted routes are
  unchanged.

## 0.2.0 — 2026-08-15

- Added FIB-4 and its generated documentation, adopted MCP SDK v2 with modern
  and legacy protocol support, and made hosted Worker releases rollback-safe.
- Migrated the MCP boundary to the split TypeScript SDK v2 packages and one
  stateless dual-era implementation serving modern protocol `2026-07-28` plus
  the supported legacy era over stdio, Node HTTP, and Cloudflare Workers.
- Added explicit legacy/modern transport matrices, raw protocol checks, a real
  workerd smoke, and modern-first production verification with a bounded legacy
  smoke.
- **Breaking for pre-1.0 embedders:** the `./server` export and
  `buildServer()` name are unchanged, but the returned `McpServer` is an SDK v2
  object. Interoperability with SDK v1 transport objects is not retained.
- Added one tag-driven release workflow that validates the package-version
  attestation, deploys the MCP and Blume documentation Workers from the same
  commit, verifies both production surfaces, and only then creates a GitHub
  release.
- Updated Blume and Wrangler to their current reviewed compatible releases,
  applied available transitive dependency patches, and cleared all root runtime
  audit findings.
- Replaced the unavailable original Apgar DOI resolver link with its stable
  PubMed record without changing the DOI identity or calculator contract.
- Added a guarded release-preparation command, dynamic release metadata checks,
  and live catalog, calculation, evidence, version, and generated-page
  verification.
- Made generated Blume calculator-page parity part of calculator contribution
  and release acceptance instead of relying on a hard-coded catalog count.

## 0.1.0 — 2026-07-21

- Added 39 established clinical calculators and structured interpretation tools
  derived from strict runtime specifications.
- Added full and compact MCP catalogs over stdio, stateless HTTP, and Cloudflare
  Workers, with real-transport parity coverage.
- Reduced the compact catalog from roughly 568 KB to under 27 KB with lazy
  exact-contract discovery, a bounded aggregate result envelope, deterministic
  clarification states, and actionable compact execution errors.
- Added per-value unit handling, plausibility and hard-limit guards, typed
  errors, conditional outputs, score provenance, adjustment traces, and cited
  evidence resources.
- Added source and scenario assurance dossiers for every calculator, with 1,192
  frozen source-derived reference, edge, and agent cases executed through the
  engine, direct MCP tools, and compact dispatch.
- Added immutable policy/model data assets, currentness checks, release
  attestations, exact compatibility contracts, and reviewed safety-break
  records.
- Added isolated calculator authoring and promotion, generated exact compute
  types, package-manifest checks, and release gates.
- Added responsible-use, contribution, security, and release documentation for
  public use and contribution.
- Hardened the hosted transport with immutable catalog capabilities, stateless
  JSON responses, batch/body-size rejection, HTTP-to-HTTPS redirect, and HSTS.
- Stabilized Cloudflare Workers Builds with an end-of-run Vitest reporter
  selected only under `WORKERS_CI`, avoiding remote log backpressure without
  changing test assertions, isolation, or local and GitHub execution.
- Licensed the project under the Apache License 2.0.
