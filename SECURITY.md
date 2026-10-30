# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| The [latest stable release](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest) | Yes |
| The latest dev preview: [prerelease builds](https://github.com/NeuralNomadsAI/CodeNomad/releases) from `dev` and the `@neuralnomads/codenomad-dev` npm package | Yes |
| Older releases and previews | No: update to a supported version |

OpenCode is separate software. Report vulnerabilities in OpenCode itself to the [OpenCode project](https://github.com/anomalyco/opencode).

## Report a vulnerability

Report vulnerabilities privately through GitHub:

1. Open the repository's [Security tab](https://github.com/NeuralNomadsAI/CodeNomad/security).
2. Select **Report a vulnerability** and fill in the private advisory form.

If the button is not available, contact a maintainer privately through the contact details on their GitHub profile, [@shantur](https://github.com/shantur) or [@pascalandr](https://github.com/pascalandr), and ask for a private channel before sending details.

Include:

- The CodeNomad version and variant (Electron, Tauri, server CLI or web), your operating system and the OpenCode version.
- Which component is affected (for example authentication, Remote Control, SideCars, the server API or the desktop app).
- Steps to reproduce, or a minimal proof of concept.
- The impact you observed or expect, and any configuration it depends on (for example a non-loopback listener or skipped authentication).

Do not include real passwords, tokens or private data; redact logs and screenshots.

## Please do not

- Open a public issue, pull request or discussion about a vulnerability before a fix is published.
- Test against systems or data that are not yours.

## What happens next

The maintainers review the report, investigate it and discuss a fix with you in the private advisory. Once a fix is released, the advisory can be published, crediting you unless you prefer otherwise. CodeNomad is maintained by volunteers, so response times vary.

The [Authentication and security](docs/help/en/security.md) help page explains how CodeNomad's authentication works and how to expose a server safely.
