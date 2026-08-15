# Changelog

All notable changes to OathMCP are documented here.

## Unreleased

- Added one tag-driven release workflow that validates the package-version
  attestation, deploys the MCP and Blume documentation Workers from the same
  commit, verifies both production surfaces, and only then creates a GitHub
  release.
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
