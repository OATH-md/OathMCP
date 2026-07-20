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
per POST. MCP responses use `Cache-Control: no-store`; the stateless transport
returns JSON rather than opening an SSE stream.

The application does not log inputs, request bodies, calculated values, patient
data, or error payload contents. Cloudflare platform metadata may still be
processed under the Cloudflare account and its configured observability policy.

## Continuous deployment

The official Worker is connected directly to the
`OATH-md/OathMCP` GitHub repository through Cloudflare Workers Builds. A push
to `main` starts the production pipeline. Non-production branch builds and
preview URLs remain disabled.

Cloudflare installs dependencies, runs the configured build command, and only
deploys when it succeeds:

```bash
npm run check:deploy
```

That gate runs the complete repository acceptance suite, the clinical-release
attestation, generated Worker type verification, and a Wrangler dry run. The
separate Workers Builds deploy command is `npx wrangler deploy`, using the
checked-in `wrangler.jsonc`. Cloudflare manages the deployment credential; the
repository does not contain a Cloudflare token.

For OpenAI plugin-domain verification, obtain the exact token from the plugin
submission portal and install it without committing it:

```bash
npx wrangler secret put OPENAI_APPS_CHALLENGE
```

Verify that `/.well-known/openai-apps-challenge` returns only the token, with no
JSON wrapper or additional text. Remove or rotate the secret when OpenAI issues
a replacement challenge.

GitHub Actions remains an independent pull-request and push signal. Cloudflare
does not depend on that separate workflow finishing because it repeats the
release gates itself before production deployment.

The `oath-docs` Worker is connected to the same repository with `docs-site` as
its Workers Builds root directory. Its build command is `npm run check`, its
deploy command is `npx wrangler deploy`, and its watch paths cover `docs-site/`
plus the repository-root specs, validation data, generated assurance state, and
Responsible Use notice listed in `docs-site/README.md`.

## Manual deploy and verification

Use this only as a documented recovery path when Workers Builds is unavailable.
Authenticate Wrangler to the intended account, then run:

```bash
npm ci
npm run deploy:worker
```

After deployment, verify `/health`, `/responsible-use`, MCP initialization, tool
listing, calculator discovery, and at least one deterministic calculation through
the real remote transport. Confirm that a disallowed browser origin receives
403, plaintext HTTP redirects with 308, HTTPS carries the HSTS header, a JSON-RPC
batch receives 400/`-32600`, and no request body appears in Workers Logs.

Record the deployed package version, Worker deployment or version identifier,
UTC timestamp, commit, verification result, and previous deployable version in
the release notes or deployment record before announcing availability.

## Rollback

Use Cloudflare Workers deployment history to roll back to the immediately prior
verified deployment. After rollback, repeat the remote transport checks and
confirm `/health` reports the expected package version. If a safe deployment is
not available, remove the `mcp.oath.md` custom domain or disable the Worker until
the issue is resolved. Do not silently serve a clinically changed contract under
the same recorded release state.

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
