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

The site pins Blume `1.1.3` and Wrangler `4.113.0`, the latest compatible
releases reviewed on 2026-07-22. The MCP SDK still declares Hono's Node adapter
1.x, but Hono 2 retains the public `getRequestListener` API used by the SDK and
only raises the Node floor to 20; this project already requires Node 22. The
checked-in override therefore pins `@hono/node-server` `2.0.11`, and the real
transport parity gate covers that integration until the SDK widens its range.

`npm audit` still reports 13 transitive entries (8 high and 5 low) through
Blume's bundled Vercel adapter, Scalar API renderer, AI SDK, nested Astro and
esbuild dependencies, plus Wrangler's Miniflare/Sharp development chain. Those
paths are not part of this deployment: the site is a static build, has no
Vercel adapter or server islands, does not use Scalar, and keeps Blume MCP and
Ask AI disabled. Published assets contain no runtime Node dependency tree or
server-side renderer.

This is a bounded build-time waiver, not a claim that the findings are fixed.
Do not apply the audit tool's suggested `blume@0.0.0` downgrade or force Sharp
0.35 or Astro 7 beneath packages that still pin incompatible ranges. Re-review
the Hono override and this waiver whenever the MCP SDK, Blume, Scalar,
Miniflare, or Wrangler updates; any disabled feature is enabled; content becomes
untrusted; or a compatible patched dependency graph becomes available.

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

The tagged workflow deploys the MCP first and the docs second, then verifies the
docs home, every generated calculator page, the attested live MCP catalog, and
new-calculator execution. Rollback remains independent through the `oath-docs`
Worker deployment history; removing its two routes returns those requests to
the MCP Worker.

For manual recovery only, check out the exact release tag and run:

```bash
npm run check
npm run deploy
```
