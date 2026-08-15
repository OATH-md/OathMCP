# Hosted Endpoint Operations

This runbook covers the official OathMCP service at
`https://mcp.oath.md/mcp`. It does not govern third-party deployments.

## Service layout

- `https://mcp.oath.md/` — redirects human visitors to
  `https://mcp.oath.md/docs/`.
- `https://mcp.oath.md/docs/` — static clinical and technical documentation,
  built from `docs-site/` and served by the separately deployed `oath-docs`
  Worker.
- `https://mcp.oath.md/mcp` — stateless Streamable HTTP MCP endpoint.
- `https://mcp.oath.md/health` — public service name, package version, and route
  metadata. It contains no patient or request data.
- `https://mcp.oath.md/responsible-use` — the complete canonical Responsible Use
  notice bundled from `docs/RESPONSIBLE_USE.md` at build time.
- `https://mcp.oath.md/.well-known/openai-apps-challenge` — OpenAI plugin-domain
  verification. It returns 404 until a portal-generated token is installed as
  the `OPENAI_APPS_CHALLENGE` Worker secret.
- `oath://responsible-use` — the same notice exposed as an MCP resource.

Cloudflare path routes assign `mcp.oath.md/docs` and `mcp.oath.md/docs/*` to
`oath-docs` before the `mcp.oath.md` custom-domain deployment is invoked. Both
Workers are built from this repository, but their deployments and rollback
histories remain independent. Every other `mcp.oath.md` path remains owned by
the clinical calculator Worker.

## Production policy

The official endpoint is public and unauthenticated. This makes established
calculator access straightforward; it does not transfer clinical responsibility
to OathMCP. A clinician remains responsible for selection, inputs, units,
applicability, interpretation, and every clinical decision.

The Worker is stateless and does not require patient identifiers. Clients must
not send names, record numbers, free-text notes, or other protected or personal
health information. OathMCP does not provide a protected-health-information
hosting commitment for this public endpoint.

Production controls are defined in `wrangler.jsonc`:

- compact catalog mode (`find_calculator`, `describe_calculator`, `calculate`,
  and `calculate_panel`);
- exact browser origins `https://oath.md` and `https://mcp.oath.md`;
- 120 requests per client per 60 seconds using the Workers Rate Limiting
  binding;
- Workers observability enabled with 10% head sampling; and
- no `workers.dev` route or preview URL.

The Worker additionally redirects plaintext HTTP to the identical HTTPS URL,
adds `Strict-Transport-Security: max-age=31536000; includeSubDomains` to every
HTTPS response, cancels request streams as soon as they exceed 100 KiB, and
rejects JSON-RPC batches because Streamable HTTP carries exactly one MCP message
per POST. MCP responses use `Cache-Control: no-store`.

The application does not log inputs, request bodies, calculated values, patient
data, or error payload contents. Cloudflare platform metadata may still be
processed under the Cloudflare account and its configured observability policy.

## Protocol compatibility

The stdio, Node HTTP, and Worker entrypoints share one MCP SDK v2 implementation
that serves modern protocol `2026-07-28` and the supported stateless legacy era.
Each HTTP request creates a fresh MCP server; no MCP session or Durable Object
holds protocol state between requests.

Modern HTTP messages carry protocol version and client capability metadata;
client identity metadata may also be present. Clients mirror routing through
`MCP-Protocol-Version`, `Mcp-Method`, and, where applicable, `Mcp-Name`. Browser
preflight allows `Accept`, `Content-Type`, and those three MCP headers. MCP responses retain
`Cache-Control: no-store`. The SDK selects JSON for complete non-streaming
exchanges and request-scoped SSE when required; neither response form changes
the service's stateless ownership model.

Around February 2027 is the earliest evidence review date for legacy support,
not a scheduled protocol cutoff. Legacy removal requires a later announced
breaking release, at least two successful modern OathMCP releases, support in
the major documented clients, consistently green modern-first production
verification, and advance deprecation notice.

## Tagged production deployment

The official Workers deploy from the exact `v*` Git tag through
`.github/workflows/release-readiness.yml`. A push to `main` is an accepted but
unreleased catalog change; it never proves or initiates a production release.

The workflow first runs:

```bash
npm run check:release
```

That gate verifies release metadata, ordinary repository acceptance, the
package-version clinical attestation, the complete Blume site, and the package
tarball. Only then can the protected `production` environment expose its
least-privilege Cloudflare credential.

The workflow builds and uploads both Worker versions before changing production
traffic. It records the two current version IDs and the live `/health` version,
starts continuous availability probes, promotes `oath-docs` directly to 100%,
and then promotes `oath-mcp` directly to 100%. It never splits MCP traffic
between versions.

The production verifier opens a modern-pinned MCP client, compares the complete
live evidence-resource catalog with the release attestation, describes every
calculator, exercises discovery, BMI, a panel, and each newly released
calculator, and then runs a separate explicit-legacy smoke. It also verifies
every generated Blume page. Any cutover or verification failure automatically
rolls back MCP first and docs second to the captured version IDs, confirms the
previous health version, legacy BMI, and docs root, and fails the workflow. The
GitHub release is created only after the full cutover succeeds.

Cloudflare Workers Builds must remain disconnected from `main`. There must not
be a second production path whose source and release state differ from the tag.

For OpenAI plugin-domain verification, obtain the exact token from the plugin
submission portal and install it without committing it:

```bash
npx wrangler secret put OPENAI_APPS_CHALLENGE
```

Verify that `/.well-known/openai-apps-challenge` returns only the token, with no
JSON wrapper or additional text. Remove or rotate the secret when OpenAI issues
a replacement challenge.

GitHub pull-request CI remains an independent acceptance signal. It validates
the current catalog and generated Blume content without rewriting a historical
release attestation or deploying either Worker.

## Manual deploy and verification

Use this only as a documented recovery path when the tagged workflow is
unavailable. Authenticate Wrangler to the intended account and check out the
exact release tag, then run:

```bash
npm ci
npm --prefix docs-site ci
npm run check:release
npm run deploy:production -- \
  --tag "$(git describe --tags --exact-match)" \
  --sha "$(git rev-parse HEAD)"
```

The coordinator performs the same upload-first cutover, continuous probes,
production verification, and automatic rollback as the tagged workflow. Also
confirm that a disallowed browser origin receives 403, plaintext HTTP redirects
with 308, HTTPS carries the HSTS header, a JSON-RPC batch receives
400/`-32600`, and no request body appears in Workers Logs.

Record the deployed package version, Worker deployment or version identifier,
UTC timestamp, commit, verification result, and previous deployable version in
the release notes or deployment record before announcing availability.

## Rollback

The deployment coordinator automatically rolls back a partial or failed
cutover. It restores `oath-mcp` first and `oath-docs` second, confirms both
captured version IDs are again receiving 100% of traffic, and then verifies the
previous `/health` version, a legacy BMI calculation, and the docs root.

If manual intervention is required, use the exact captured version IDs with
these commands, again restoring MCP before docs. Set `MCP_VERSION_ID` and
`DOCS_VERSION_ID` to the recorded values before running them:

```bash
npx wrangler rollback "$MCP_VERSION_ID" -y
npx wrangler --cwd docs-site rollback "$DOCS_VERSION_ID" -y
```

Keep the existing routes and domains in place so the last verified version
remains available. Treat an incomplete rollback as an incident, do not create
or announce the GitHub release, and do not silently serve a clinically changed
contract under the previous release state.

## Deployment record

### Initial production deployment — 0.1.0

- Deployed: `2026-07-17T10:10:59.130675Z`
- Worker version: `3e864015-f5ef-4349-9bdf-9364f1a69973` (version 1)
- Source: the Git commit that adds this record; no Worker-affecting file changed
  between the successful deployment and that commit.
- Route: `mcp.oath.md` custom domain; `workers.dev` and preview URLs disabled.
- Previous verified version: none; this was the initial production deployment.
- Verification: `/health` reported `0.1.0`; `/responsible-use` served the bundled
  canonical notice; the real MCP SDK initialized, listed the four compact tools,
  read `oath://responsible-use`, and calculated BMI 24.22 for 70 kg and 170 cm;
  allowlisted CORS preflight returned 204 and a disallowed origin returned 403.
