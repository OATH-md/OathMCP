# Contributing to OathMCP

OathMCP welcomes corrections, clearer documentation, safer agent behavior,
additional source-derived cases, and carefully reviewed calculators.

Before contributing, read [Responsible Use](docs/RESPONSIBLE_USE.md). Never add
identifiable patient information, real clinical records, credentials, or
confidential material to an issue, example, fixture, commit, or pull request.

## Start here

```bash
npm ci
npm run check
```

For calculator work, follow [Authoring and Promoting a Calculator](docs/AUTHORING.md)
and [Calculator Spec House Style](docs/HOUSE_STYLE.md). New calculators begin in
the ignored `drafts/calculators/<id>/` directory and reach the live catalog only
through the isolated promotion gate.

## Good contributions

- reproduce and correct an implementation discrepancy against an exact source;
- update a superseded policy, coefficient set, lookup table, or citation;
- add a missing boundary, omission, warning, unit-equivalence, or agent scenario;
- improve tool descriptions, errors, accessibility, or documentation;
- strengthen transport, schema, compatibility, security, or package tests; or
- propose a well-documented calculator that fits the project scope.

## Clinical contract changes

Do not change a formula, coefficient, input meaning, unit, default, cap, cutoff,
interpretation, recommendation, population, exclusion, warning, or citation from
memory. Link the exact governing source and locator, update the dossier, add a
source-derived case, regenerate artifacts, and run the complete gate.

OathMCP's review states describe implementation assurance. Contributions should
not claim that OathMCP invented, clinically revalidated, certified, or obtained
regulatory approval for an established calculator.

## Pull requests

Keep changes focused and explain:

- the user or safety problem;
- the exact behavior before and after;
- the source and locator for any clinical contract change;
- the tests or scenarios that demonstrate the change; and
- any compatibility, deployment, documentation, or release impact.

Run `npm run check` before opening a pull request. Release-affecting changes must
also pass `npm run check:clinical-release` and `npm run check:package`.

## Reporting sensitive issues

Follow [SECURITY.md](SECURITY.md) for vulnerabilities or patient-safety-sensitive
implementation errors. Do not disclose an exploitable issue publicly before a
maintainer has had a reasonable opportunity to respond.

## Contribution license

Unless you explicitly state otherwise, contributions intentionally submitted
for inclusion in OathMCP are provided under the Apache License 2.0, consistent
with section 5 of [LICENSE](LICENSE).
