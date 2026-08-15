# Calculator Release and Deployment

This is the maintainer workflow for publishing an accepted calculator to every
official OathMCP surface. A calculator merge and a production release are
deliberately separate states:

```text
draft
  -> promoted calculator PR
  -> merged and documented on main
  -> versioned release PR with fresh attestation
  -> vX.Y.Z tag
  -> release gate
  -> MCP Worker
  -> Blume docs Worker
  -> live catalog/docs verification
  -> required npm publication
  -> GitHub release
```

The tag identifies one exact source commit for the package, hosted MCP catalog,
Blume documentation, and release evidence. A GitHub release is not created
until both Workers are deployed and the live verification succeeds.

## Contributor and maintainer boundary

A calculator pull request owns:

- the promoted runtime spec, compute function, dossier, catalog enrollment, and
  generated runtime artifacts;
- its category assignment and generated Blume calculator page; and
- focused, catalog-wide, local MCP, and Blume verification.

Ordinary contributor CI runs `npm run check` and the independent
`docs-site` check. It does not compare unreleased work with a historical
attestation.

A later maintainer release pull request owns:

- the package and private docs-module version;
- `validation/releases/<version>.yaml`;
- the changelog entry; and
- the exact release gate.

Historical attestations remain immutable.

## Prepare a release pull request

Start from the current `main` after the intended calculator pull requests have
merged. Install both lockfiles, complete the required network/source
currentness review, then run:

```bash
npm ci
npm --prefix docs-site ci
npm run release:prepare -- \
  --version 0.2.1 \
  --reviewer "<reviewer identity>" \
  --reviewer-time-zone "Asia/Riyadh" \
  --checked-at YYYY-MM-DD \
  --network-checked-at YYYY-MM-DD \
  --summary "Summarize the public release changes." \
  --confirm-currentness
npm --prefix docs-site run generate
```

`--confirm-currentness` is an explicit maintainer attestation after the source
review. The command does not perform or impersonate that review. It refuses an
old or ambiguous version, invalid chronology, source checks later than the
declared network review, claim reviews later than the attestation, or an
existing release file.

The preparation command updates:

- root `package.json` and `package-lock.json`;
- `docs-site/package.json` and its lockfile;
- the complete catalog and source-version inventory in
  `validation/releases/<version>.yaml`;
- a dated changelog entry.

The following generation command regenerates the repository-derived Blume
content from the reviewed specifications.

Review every generated field, then run the single release gate:

```bash
npm run check:release
```

It verifies release metadata, ordinary acceptance, all source/scenario
assurance, the dynamically selected package-version attestation, the complete
Blume build, and the package tarball. Open and merge a focused release pull
request only when this exact command passes.

Before merging, also:

- confirm CI passes on the exact release commit and the worktree contains no
  credentials, private patient information, local environment files, or
  unrelated drafts;
- review `README.md`, `CHANGELOG.md`, `docs/RESPONSIBLE_USE.md`, the generated
  Blume surface, the package manifest, `LICENSE`, and `NOTICE`;
- run `npm audit --omit=dev` for the published runtime and separately review the
  development dependency findings used by deployment and documentation builds;
- inspect the root `npm ls` graph and package manifest: the split MCP SDK v2
  server, Node, and Express packages must be runtime dependencies, the v2 client
  must remain development-only, and neither the monolithic v1 SDK nor a Hono
  override may be present;
- review the isolated MCP SDK v1 copy pulled into `docs-site` by Blume, confirm
  no root runtime, test, or release script imports it, and re-review that waiver
  whenever Blume's dependency graph or enabled features change; and
- confirm the comprehensive production verifier pins modern protocol
  `2026-07-28` and its separate bounded legacy list/resource/calculation smoke
  remains green.

Do not override Miniflare's exact Sharp pin; adopt Sharp updates through a
compatible Wrangler release.

## Tag the verified release commit

After the release pull request merges, update local `main`, repeat the release
gate, then create and push one annotated tag:

```bash
git switch main
git pull --ff-only
npm ci
npm --prefix docs-site ci
npm run check:release
git tag -a v0.2.1 -m "OathMCP 0.2.1"
git push origin v0.2.1
```

The tag must be annotated, equal `v` plus the package version, and point to a
commit contained in `origin/main`. The workflow rejects any mismatch before
production credentials are available.

## Automated publication and deployment

`.github/workflows/release-readiness.yml` is the only normal production
publisher. A `v*` tag runs these ordered jobs:

1. Validate the exact tag with `npm run check:release`.
2. Confirm both Workers have exactly one version receiving 100% of traffic and
   capture those version IDs plus the live `/health` version.
3. Build and upload both tagged Worker versions without changing production
   traffic.
4. Start continuous probes, promote `oath-docs` directly to 100%, verify it,
   and then promote `oath-mcp` directly to 100%. Never split MCP traffic.
5. Open a modern-pinned `2026-07-28` client and compare every live
   `calc://<id>/evidence` resource with the attested catalog.
6. Call `describe_calculator` for every calculator, exercise discovery, BMI and
   panel calculation, and calculate a source-linked reference case for every
   calculator newly added since the prior attestation.
7. Open a separate explicit-legacy client and require the bounded
   list/resource/calculation smoke to pass.
8. Fetch and verify one generated Blume page for every attested calculator.
9. Publish the npm package through trusted publishing and verify a clean
   registry consumer before the GitHub release is created.
10. Attach the package tarball and both Cloudflare Worker version IDs to the
   GitHub release.

Any partial cutover, failed availability probe, or production-verification
failure rolls back MCP first and docs second to the captured version IDs. The
workflow then confirms the previous health version, a legacy BMI calculation,
and the docs root. A failed deployment or incomplete rollback prevents the
GitHub release. Do not announce a calculator from a green build alone; the
terminal state is the successful protected deployment job and resulting GitHub
release.

## One-time production configuration

Create a protected GitHub environment named `production`. Add:

- `CLOUDFLARE_API_TOKEN` — a least-privilege token that can deploy the
  `oath-mcp` and `oath-docs` Workers in the configured account;
- `CLOUDFLARE_ACCOUNT_ID` — the exact account containing both Workers.

Require maintainer approval for that environment if the repository plan
supports it. The deployment jobs cannot read these values until the release
gate passes. Follow Cloudflare's
[GitHub Actions guidance](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
when creating and rotating the token.

Protect `v*` tag creation with a repository ruleset so only release maintainers
can start production, and keep the normal required checks on `main`.

Keep Cloudflare Workers Builds disconnected from `main`. Production must have
one owner: the tagged GitHub workflow. Reconnecting a `main` trigger creates an
ambiguous second path that either fails against an unreleased attestation or
deploys source that has not completed the release workflow.

The npm job is mandatory for release tags and runs only after production passes.
It uses the separately protected `npm-publish` environment and a
[trusted publisher](https://docs.npmjs.com/trusted-publishers/) bound to this
exact workflow. Trusted publishing uses GitHub OIDC; never add a long-lived npm
token to the repository. The GitHub release remains withheld until the registry
reports the exact package version, latest dist-tag, and tarball integrity that
matches a dry-run pack of the exact tag, and a clean registry consumer passes.
If npm reports optional `gitHead` metadata, it must also match the tag commit;
the registry does not guarantee that field for every publication.

The first publication (`0.2.1`) is the one exception because npm requires a
package to exist before trusted publishing can be configured. After the tagged
Workers are verified, leave the `npm-publish` job awaiting review, publish the
exact tag interactively with account 2FA, configure the trusted publisher,
disallow traditional publish tokens, and only then approve the pending job. All
later tags publish through OIDC.

## Manual readiness and recovery

Manual dispatch of the workflow runs release validation but never deploys;
production jobs require an actual `v*` tag.

Use the tested coordinator only for recorded recovery from an exact release
tag:

```bash
npm ci
npm --prefix docs-site ci
npm run check:release
npm run deploy:production -- \
  --tag "$(git describe --tags --exact-match)" \
  --sha "$(git rev-parse HEAD)"
```

Record the reason, captured rollback baseline, and both resulting Worker version
IDs. The coordinator uploads before cutover and automatically restores a failed
deployment. If rollback needs manual intervention, restore MCP first and docs
second to the captured version IDs and repeat the bounded rollback verification.
See [Hosted Endpoint Operations](HOSTING.md).

## npm, license, and responsibility

Before npm publication, confirm the scoped package name, public access,
Apache-2.0 identity, `NOTICE`, package contents, and trusted-publisher binding.
The package `prepublishOnly` hook repeats metadata, ordinary acceptance, and the
clinical release gate.

Release readiness proves the checked-in implementation and evidence contract.
It does not decide whether a calculator is appropriate for an individual
patient. Preserve the clinician and deployer responsibilities in
[`RESPONSIBLE_USE.md`](RESPONSIBLE_USE.md) across the repository, package,
hosted MCP service, and Blume documentation.

## Current release state

The [live service metadata](https://mcp.oath.md/health) is the source of truth
for the deployed version, and [GitHub Releases](https://github.com/OATH-md/OathMCP/releases)
identifies its exact tag and source. The npm registry is the source of truth for
the scoped package. The `0.2.1` attestation covers the 40-calculator catalog,
including FIB-4. Treat `0.2.1` as released only when the release process has
verified both production Workers, verified `@oath-md/oath-mcp@0.2.1`, and
created the matching GitHub release. The historical `0.2.0` package was not
published to npm.
