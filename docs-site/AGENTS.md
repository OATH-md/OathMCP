# OathMCP Documentation Site Agent Guide

`docs-site/` is OathMCP's independently deployed Blume documentation module. It
is intended for clinicians, clinical informaticians, and engineers, while the
repository root remains the calculator runtime and package module.

## Source boundaries

- Repository-root `specs/`, `validation/`, `src/server/validation-state.generated.ts`,
  and `docs/RESPONSIBLE_USE.md` are canonical.
- `docs/calculators/**` and `docs/responsible-use.mdx` are generated directly
  from those repository sources. Improve the generator, not a generated page.
- Hand-written guides may explain contracts but must not invent or silently
  modify clinical claims, thresholds, exclusions, or citations.

## Language

- Describe calculators as established, published, or documented.
- `source_verified` and `scenario_verified` are repository-defined assurance
  states. Never shorten either to “clinically validated.”
- Preserve clinician responsibility for selection, inputs, units, model,
  applicability, interpretation, and every clinical decision.
- Preserve the deployer boundary for authentication, privacy, PHI, compliance,
  monitoring, and source/version updates.

## Acceptance

```bash
npm run check
```

The check must confirm generated-page parity, all 39 calculator pages, required
responsibility language, and a successful production Blume build.
