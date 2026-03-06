# Security Policy

## Supported Versions

Security fixes are applied to the current maintained release line.

| Version | Supported |
| --- | --- |
| `0.1.x` | Yes |
| `< 0.1` | No |

## Reporting a Vulnerability

Please report vulnerabilities privately.

Do not:

- open a public GitHub issue
- post exploit details in discussions, PRs, or comments

Preferred reporting path:

1. Use GitHub's private vulnerability reporting flow for this repository if it is enabled.
2. If that is not available, contact the maintainers privately through GitHub.

Include:

- a clear description of the issue
- affected area or file paths
- reproduction steps
- impact
- suggested mitigation if you have one

## What to Expect

- We will review the report and validate the issue.
- We may ask follow-up questions or request a proof of concept.
- We will coordinate disclosure timing when a report is valid.

Response times depend on severity and maintainer availability. No fixed SLA is guaranteed.

## Security Considerations

### Local-first runtime

VibeTube is designed to run locally by default. Audio, model files, and generated assets can remain on the local machine unless you intentionally connect to an external server or move files elsewhere.

### Remote or external server connections

If you point the app at a non-local backend:

- treat that server as trusted infrastructure
- use network protections appropriate for the environment
- avoid exposing development servers directly to the public internet without hardening

### Development server defaults

Typical development setup binds the backend to `127.0.0.1:17493`. If you change that to a broader host such as `0.0.0.0`, you are responsible for the resulting network exposure.

### Model and dependency supply chain

The project depends on third-party Python and JavaScript packages, model downloads, and build tooling. Keep dependencies current and review source changes carefully when updating them.

## Security Updates

Security-related fixes may be reflected in:

- patch releases
- GitHub release notes
- repository documentation such as [CHANGELOG.md](CHANGELOG.md)

## Disclosure

Please allow maintainers reasonable time to investigate and fix a reported issue before public disclosure.
