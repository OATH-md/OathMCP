# Release Process

This is the release checklist for the repository, npm package, and any hosted
MCP endpoint. Release readiness is separate from a deployment decision: a green
gate proves the checked-in implementation and evidence contract, while the
operator remains responsible for its environment and clinical use boundary.

## Before release

1. Confirm the intended version in `package.json` and the matching attestation
   in `validation/releases/<version>.yaml`.
2. Review upstream policy/model changes and update every source or clinical-data
   asset whose review window requires it.
3. Run the complete local gates:

   ```bash
   npm ci
   npm run check
   npm run check:clinical-release
   npm --prefix docs-site ci
   npm --prefix docs-site run check
   npm pack --dry-run
   ```

4. Confirm the worktree is clean and CI passes on the exact release commit.
5. Review `README.md`, `CHANGELOG.md`, `docs/RESPONSIBLE_USE.md`, the generated
   `docs-site/` surface, the documented docs dependency waiver, and the package
   manifest for the version being released.
6. Confirm that `LICENSE`, `NOTICE`, and the package metadata identify the
   Apache License 2.0 before changing visibility or distributing the package.
7. Confirm that Git author/committer metadata and the copyright holder named in
   `NOTICE` are deliberate public identities, not local defaults.

## Repository publication

- Push the exact release commit before changing repository visibility.
- Confirm the repository host recognizes the project as Apache-2.0 licensed.
- Confirm no credentials, local environment files, private patient information,
  drafts, or ignored workflow state are present in Git history.
- Enable branch protection for the release branch, secret scanning and push
  protection, dependency alerts, and code scanning where the repository host
  supports them.
- Enable private vulnerability reporting and use `SECURITY.md` as the public
  reporting policy.
- Create a signed or annotated `v<version>` tag and GitHub release from the
  verified commit.
- Publish the changelog and responsibility notice with the release.

## Dependency security

- Keep `npm audit --omit=dev` clean for the published MCP runtime. Review the
  complete audit separately because deployment and documentation build tools are
  intentionally development dependencies.
- `@modelcontextprotocol/sdk` `1.29.0` still declares
  `@hono/node-server` 1.x. Hono 2 retains the `getRequestListener` API used by
  the SDK and requires Node 20+, while OathMCP requires Node 22; the checked-in
  override pins Hono `2.0.11` and real transport parity is the compatibility
  gate. Remove the override when the SDK adopts Hono 2 directly.
- Do not override Miniflare's exact Sharp pin. Keep Wrangler current and adopt
  Sharp 0.35 only through a Cloudflare release that declares it compatible.
- Re-review the separate static-site waiver in `docs-site/README.md` whenever
  its framework graph or enabled feature set changes.

## npm publication

Authenticate the maintainer account separately; credentials are never stored in
the repository. The package runs `prepublishOnly`, which rebuilds and repeats
the clinical-release and package gates.

```bash
npm login
npm publish --access public
```

After publication, verify the package from a clean temporary directory and
exercise at least one calculator through the real stdio transport.

## Hosted endpoint

Before deploying HTTP or Worker transports:

- set the exact browser-origin allowlist;
- decide whether the endpoint is private, authenticated, rate-limited, and
  monitored;
- prohibit unnecessary patient identifiers and document data handling;
- expose the full Responsible Use notice to integrators;
- record the deployed package/spec version and rollback procedure; and
- run the real transport parity checks against the release build.

The official Cloudflare Worker policy, deployment commands, verification steps,
and rollback procedure are recorded in [HOSTING.md](HOSTING.md).

## After release

- Monitor security, clinical-source, compatibility, and implementation reports.
- Re-run the source/currentness and release gates before every subsequent
  publication.
- Treat a changed formula, coefficient, cutoff, policy, lookup table, warning,
  interpretation, or applicability boundary as a reviewed clinical contract
  change with source-linked regression coverage.
- Deprecate safely and record intentional contract changes in the compatibility
  manifest and changelog.

## Version 0.1.0 release state

The checked-in `0.1.0` release passes the ordinary acceptance,
clinical-release, compatibility, real-transport, and package-manifest gates.
It is licensed under Apache-2.0. The GitHub release and npm publication are
separate operator actions; the package is not yet available from npm.
