# OathMCP Documentation Site

The independently deployed Blume documentation module for OathMCP. It combines
clinical use boundaries with the MCP server contract and publishes one generated
reference page for every live calculator.

The source lives in the public `OATH-md/OathMCP` repository so calculator,
evidence, runtime, and documentation changes can be reviewed in one pull
request. The docs remain a separate Cloudflare Worker and are not bundled into
the npm package or MCP runtime.

## Source ownership

Repository-root sources are canonical:

- `../specs/` — calculator contracts;
- `../validation/` and `../src/server/validation-state.generated.ts` — evidence
  dossiers and implementation-assurance state;
- `../docs/RESPONSIBLE_USE.md` — responsibility language.

`docs/calculators/**` and `docs/responsible-use.mdx` are generated. Change the
repository source or generator instead of editing those pages directly.

```bash
cd docs-site
npm ci
npm run generate
npm run check
```

Use `npm run dev` for local authoring. It regenerates repository-derived content
before starting Blume.

## Dependency posture

The site pins Blume `1.4.3` and Wrangler `4.123.0`, the latest compatible
releases reviewed on 2026-08-15. Blume's transitive MCP SDK remains build tooling
only; this site keeps Blume MCP disabled and publishes no SDK runtime code.

`npm audit` still reports nine transitive entries (seven high and two low)
through Blume's bundled Vercel adapter, Scalar API renderer, image metadata
reader, and nested Astro, esbuild, and Sharp dependencies. Those paths are
bounded to a trusted-content static build: the deployment has no Vercel adapter
or server islands, does not use Scalar, and keeps Blume MCP and Ask AI disabled.
Published assets contain no runtime Node dependency tree or server-side
renderer.

This is a bounded build-time waiver, not a claim that the findings are fixed.
Do not apply the audit tool's suggested `blume@1.4.0` downgrade or force nested
Astro or Sharp versions beneath packages that still pin incompatible ranges.
Re-review this waiver whenever the MCP SDK, Blume, Scalar, Miniflare, or
Wrangler updates; any disabled feature is enabled; content becomes untrusted;
or a compatible patched dependency graph becomes available.

## Deployment

The static site is canonical at `https://mcp.oath.md/docs/`. Its Worker owns
only these path routes:

- `mcp.oath.md/docs`
- `mcp.oath.md/docs/*`

The existing `oath-mcp` custom-domain Worker continues to own `/mcp`, `/health`,
`/responsible-use`, and every other `mcp.oath.md` path. Cloudflare runs the more
specific documentation routes before that custom-domain Worker.

The normal publisher is the repository-root tagged release workflow. A
calculator pull request runs `npm run generate`, commits the generated page,
and passes this module's `npm run check`. A later versioned release tag deploys
the `oath-mcp` Worker and this `oath-docs` Worker from the same exact checkout,
then verifies every live calculator page before publishing the GitHub release.

Do not connect this Worker to automatic builds from `main`. Accepted calculator
work can exist on `main` before its package-version release attestation is
prepared; deploying the docs independently would advertise a calculator that
the official MCP does not yet serve.

The build stages Blume output beneath `.deploy/docs/` because path-routed static
assets mirror the public `/docs` prefix. Do not deploy `dist/` directly.

A minimal Worker-first middleware redirects plaintext requests to the identical
HTTPS URL before delegating to the static-assets binding. It also applies HSTS
and `nosniff` defensively to the returned asset response; it does not render,
transform, log, or inspect documentation content.

The tagged workflow uploads both Worker versions without changing traffic,
promotes docs and then MCP directly to 100%, and verifies the docs home, every
generated calculator page, both MCP protocol eras, the attested live catalog,
and new-calculator execution. A failed cutover automatically restores MCP first
and docs second to their captured production version IDs.

For manual recovery only, check out the exact release tag.

Use the repository-root deployment coordinator for manual recovery so the same
availability probes, verification, and automatic rollback remain in force. See
[`docs/RELEASE.md`](../docs/RELEASE.md) for the exact command.
