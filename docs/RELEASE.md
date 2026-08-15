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
  -> optional npm publication
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
  --version 0.2.0 \
  --reviewer "<reviewer identity>" \
  --reviewer-time-zone "Asia/Riyadh" \
  --checked-at YYYY-MM-DD \
  --network-checked-at YYYY-MM-DD \
  --summary "Added <calculator> and its generated Blume reference." \
  --confirm-currentness
```

`--confirm-currentness` is an explicit maintainer attestation after the source
review. The command does not perform or impersonate that review. It refuses an
old or ambiguous version, invalid chronology, source checks later than the
declared network review, claim reviews later than the attestation, or an
existing release file.

The command prepares together:

- root `package.json` and `package-lock.json`;
- `docs-site/package.json` and its lockfile;
- the complete catalog and source-version inventory in
  `validation/releases/<version>.yaml`;
- a dated changelog entry; and
- regenerated repository-derived Blume content.

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
  and
- re-review the documented `docs-site` dependency waiver whenever its framework
  graph or enabled features change.

The MCP SDK currently relies on the checked-in `@hono/node-server` override;
real transport parity is the compatibility gate until the SDK adopts that major
version directly. Do not override Miniflare's exact Sharp pin; adopt Sharp
updates through a compatible Wrangler release.

## Tag the verified release commit

After the release pull request merges, update local `main`, repeat the release
gate, then create and push one annotated tag:

```bash
git switch main
git pull --ff-only
npm ci
npm --prefix docs-site ci
npm run check:release
git tag -a v0.2.0 -m "OathMCP 0.2.0"
git push origin v0.2.0
```

The tag must be annotated, equal `v` plus the package version, and point to a
commit contained in `origin/main`. The workflow rejects any mismatch before
production credentials are available.

## Automated publication and deployment

`.github/workflows/release-readiness.yml` is the only normal production
publisher. A `v*` tag runs these ordered jobs:

1. Validate the exact tag with `npm run check:release`.
2. Build both tagged Worker artifacts before changing production.
3. Deploy `oath-mcp` and then the tagged Blume `oath-docs` Worker under one
   protected-environment approval.
4. Poll the live service until `/health` reports the tagged version.
5. Compare every live `calc://<id>/evidence` resource with the attested catalog.
6. Call `describe_calculator` for every calculator and calculate a source-linked
   reference case for every calculator newly added since the prior attestation.
7. Fetch and verify one generated Blume page for every attested calculator.
8. Optionally publish the npm package through trusted publishing.
9. Attach the package tarball and both Cloudflare Worker version IDs to the
   GitHub release.

Any failure prevents the GitHub release. Do not announce a calculator from a
green build alone; the terminal state is the successful production-verification
job and resulting GitHub release.

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

Disconnect the old Cloudflare Workers Builds connection from `main` after this
tag workflow is merged and its credentials are tested. Production must have one
owner: the tagged GitHub workflow. Leaving the old `main` trigger connected
creates an ambiguous second path that either fails against an unreleased
attestation or deploys source that has not completed the release workflow.

The npm job is disabled unless repository variable
`NPM_PUBLISH_ENABLED=true`. Enable it only after the `oath-mcp` package has an
[npm trusted publisher](https://docs.npmjs.com/trusted-publishers/) bound to this
exact workflow. Trusted publishing uses GitHub OIDC; do not add a long-lived npm
token to the repository.

## Manual readiness and recovery

Manual dispatch of the workflow runs release validation but never deploys;
production jobs require an actual `v*` tag.

Use direct Wrangler deployment only for recovery:

```bash
npm ci
npm --prefix docs-site ci
npm run check:release
npm run deploy:worker
npm --prefix docs-site run deploy
npm run verify:production
```

Record the reason and both resulting Worker version IDs. If the second
deployment or live verification fails after the first Worker changes, roll the
changed Worker back to its immediately prior verified version and repeat live
verification. See [Hosted Endpoint Operations](HOSTING.md).

## npm, license, and responsibility

Before enabling npm publication, confirm the package name, public access,
Apache-2.0 identity, `NOTICE`, package contents, and trusted-publisher binding.
The package `prepublishOnly` hook repeats metadata, ordinary acceptance, and the
clinical release gate.

Release readiness proves the checked-in implementation and evidence contract.
It does not decide whether a calculator is appropriate for an individual
patient. Preserve the clinician and deployer responsibilities in
[`RESPONSIBLE_USE.md`](RESPONSIBLE_USE.md) across the repository, package,
hosted MCP service, and Blume documentation.

## Current release state

`v0.1.0` is the latest tagged production release and contains the prior
39-calculator catalog. The 40-calculator `main` catalog, including FIB-4,
requires the next versioned release pull request and tag before it is expected
on the official MCP or Blume site.
