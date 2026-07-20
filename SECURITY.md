# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes |
| `< 0.1` | No |

## Reporting a vulnerability

Use GitHub private vulnerability reporting for security-sensitive issues. If
private reporting is unavailable, open a public issue with no vulnerability
details and ask the maintainers to establish a private channel. Do not publish
an exploit, secret, patient information, or other sensitive reproduction data.

Include the affected version, transport, configuration, reproduction steps,
impact, and any suggested mitigation. Do not include access tokens, credentials,
identifiable patient information, protected health information, or real clinical
records.

Security-sensitive reports include authentication or origin bypasses, remote
code execution, request smuggling, denial of service, dependency compromise,
data disclosure, unsafe default network exposure, and package or release-chain
tampering.

## Patient-safety-sensitive reports

Report a reproducible formula, coefficient, unit, cutoff, policy-version,
interpretation, warning, exclusion, or conditional-output discrepancy privately
when public disclosure could create immediate misuse. Include a non-identifying
reproduction, the exact governing source and locator when available, and the
expected behavior.

OathMCP is not an emergency service. If a problem has affected patient care,
follow the applicable local clinical-safety, incident-reporting, and regulatory
processes independently of this project report.

## Response

Maintainers will acknowledge a complete report, reproduce and classify it,
identify affected versions, prepare a correction and regression scenario, and
coordinate disclosure when appropriate. No response time is guaranteed.
