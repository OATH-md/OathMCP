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

The site pins Blume `1.1.2`, the latest compatible release reviewed on
2026-07-20. `npm audit` still reports 10 transitive findings (5 high and 5 low)
through Blume's bundled Vercel adapter, Scalar API renderer, AI SDK, nested
Astro, and esbuild dependencies. Those paths are not part of this deployment:
the site is a static build, has no Vercel adapter or server islands, does not use
Scalar, and keeps Blume MCP and Ask AI disabled. Published assets contain no
runtime Node dependency tree or server-side renderer.

This is a bounded build-time waiver, not a claim that the findings are fixed.
Do not apply the audit tool's suggested `blume@0.0.0` downgrade or force
incompatible overrides. Re-review the waiver whenever Blume updates, any of the
disabled features is enabled, content becomes untrusted, or a compatible patched
dependency graph becomes available.

## Deployment

The static site is canonical at `https://mcp.oath.md/docs/`. Its Worker owns
only these path routes:

- `mcp.oath.md/docs`
- `mcp.oath.md/docs/*`

The existing `oath-mcp` custom-domain Worker continues to own `/mcp`, `/health`,
`/responsible-use`, and every other `mcp.oath.md` path. Cloudflare runs the more
specific documentation routes before that custom-domain Worker.

Connect the Cloudflare Worker named `oath-docs` to the same
`OATH-md/OathMCP` GitHub repository with Workers Builds:

- Production branch: `main`
- Root directory: `docs-site`
- Build command: `npm run check`
- Deploy command: `npx wrangler deploy`
- Preview URLs and non-production branch deploys: disabled initially

Configure build watch paths to include changes that can affect the published
site:

- `docs-site/**`
- `specs/**`
- `validation/**`
- `src/server/validation-state.generated.ts`
- `docs/RESPONSIBLE_USE.md`
- `package.json`

The build stages Blume output beneath `.deploy/docs/` because path-routed static
assets mirror the public `/docs` prefix. Do not deploy `dist/` directly.

A minimal Worker-first middleware redirects plaintext requests to the identical
HTTPS URL before delegating to the static-assets binding. It also applies HSTS
and `nosniff` defensively to the returned asset response; it does not render,
transform, log, or inspect documentation content.

Deploy `oath-docs` before enabling human-facing links or the MCP root redirect.
Verify the docs home, one generated calculator page, search, raw Markdown,
`llms.txt`, light and dark themes, and `/mcp` health after the route is active.
Rollback is independent through the `oath-docs` Worker deployment history;
removing its two routes returns those requests to the MCP Worker.
