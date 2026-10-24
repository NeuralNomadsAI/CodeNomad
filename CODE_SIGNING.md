# Code signing policy

Status: proposed policy for the SignPath Foundation application.

## Responsibilities

| Role | Maintainer | Responsibilities |
| --- | --- | --- |
| Project owner | [Shantur Rathore (@shantur)](https://github.com/shantur) | Owns project governance, authorizes the signing integration and approves changes to signing responsibilities. |
| Signing operator and approver | [Pascal André (@pascalandr)](https://github.com/pascalandr) | Coordinates the application, maintains the signing workflow, submits and approves release signing requests, and verifies signed artifacts before publication. |
| Authors and reviewers | [Shantur Rathore](https://github.com/shantur) and [Pascal André](https://github.com/pascalandr) | Maintain the source and build workflows, and review contributions before they enter the release build. |

Everyone involved in signing must use multi-factor authentication for GitHub
and SignPath access.

## Signing provider

The proposed provider is [SignPath.io](https://signpath.io), with a certificate
provided by [SignPath Foundation](https://signpath.org), subject to acceptance
into its open-source program. Certificates under this program identify
SignPath Foundation as the publisher.

The attribution for releases signed through the program will be:

> Free code signing provided by [SignPath.io](https://signpath.io), certificate
> by [SignPath Foundation](https://signpath.org).

## Release signing

1. Windows CodeNomad executables and installers are built from the public
   [CodeNomad repository](https://github.com/NeuralNomadsAI/CodeNomad) on
   GitHub-hosted Actions runners, from an identified release commit.
2. The signing workflow uploads the build artifacts to GitHub Actions and
   submits them to SignPath for origin verification and signing.
3. Pascal André reviews and manually approves each release signing request.
4. The workflow verifies the returned Authenticode signatures, timestamp and
   product version before publishing the signed artifacts.
5. Tauri updater signatures and checksums are generated from the final signed
   files. Release records identify the source commit and build workflow.

Signing access and policy changes are reviewed by the project owner. The
operator investigates failed verifications and reported signing-policy issues.

## Privacy

CodeNomad's network connections and data handling are described in the
[Privacy policy](PRIVACY.md).
