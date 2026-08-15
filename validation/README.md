# Implementation Assurance Ledger

This directory records the source and behavior assurance for the 40 established
clinical calculators implemented by OathMCP. It does not contain new clinical
research and does not claim to revalidate the underlying instruments.

`catalog.yaml` assigns every live spec to one review group;
`calculators/*.yaml` records reproducible searches, exact claim locators, and
immutable source-derived reference, edge, and agent cases;
`authorities.yaml` identifies the responsible sources; and
`compatibility/1.0.yaml` freezes the public MCP contract and its reviewed safety
breaks.

Review state is derived by code. A dossier cannot author `status`, `passed`,
`actual`, `source_verified`, or `scenario_verified`. In the current catalog,
all 40 dossiers and all four derived groups pass `scenario_verified` through
the engine, full direct MCP tools, and compact MCP dispatch. The checked-in
`0.1.0` release attestation covers the prior 39-calculator catalog and must be
refreshed as a separate release action.

Repository terminology is deliberately narrow:

- `search_complete` means the documented source search and search-quality checks
  are complete;
- `source_verified` means retained implementation claims map to current required
  sources and exact locators;
- `scenario_verified` means the source-linked cases and executable claim
  witnesses pass across all required calculation surfaces.

These states describe implementation assurance. They are not regulatory
approval, a guarantee for an individual patient, or a transfer of clinical
responsibility. See [Responsible Use](../docs/RESPONSIBLE_USE.md).

Commands:

```bash
npm run validate:clinical
npm run validate:clinical -- --group formula_unit_dosing
npm run validate:clinical -- --require-source-verified
npm run validate:clinical -- --require-scenario-verified
npm run check:clinical-release
npm run check:release
```

`npm run check` requires catalog-wide `scenario_verified` state. Publication is
additionally blocked by `check:clinical-release` and `prepublishOnly` unless the
package-version attestation, source versions, review chronology, currentness,
and unresolved-change state all pass.

Pull-request CI runs the ordinary acceptance and generated Blume documentation
gates without comparing unreleased work with a historical release attestation.
A maintainer later runs `npm run release:prepare -- ...` to create a new,
package-versioned attestation after the required currentness review. The
tag-triggered release workflow then requires `check:release`, deploys both
official Workers from the same commit, and verifies the live MCP catalog and
generated Blume pages before publication is considered complete.

No test or CI command fetches mutable clinical sources. Reviewed searches,
locators, expected cases, and release attestations are checked in. Networked
source refresh is deliberate, reviewed work performed before the applicable
expiry or release boundary.
