# Code signing policy

Status: CodeNomad is a SignPath Foundation project. The release workflow signs
Windows files with SignPath's test certificate on request; stable Windows
releases stay unsigned until SignPath Foundation issues the release
certificate.

## Responsibilities

| Role | Maintainer | Responsibilities |
| --- | --- | --- |
| Project owners | [Shantur Rathore (@shantur)](https://github.com/shantur) and [Pascal André (@pascalandr)](https://github.com/pascalandr) | Own project governance, authorize the signing integration and approve changes to signing responsibilities. |
| Signing operator and approver | [Pascal André (@pascalandr)](https://github.com/pascalandr) | Coordinates the application, maintains the signing workflow, submits and approves release signing requests, and verifies signed artifacts before publication. |
| Authors and reviewers | [Shantur Rathore](https://github.com/shantur) and [Pascal André](https://github.com/pascalandr) | Maintain the source and build workflows, and review contributions before they enter the release build. |

Everyone involved in signing must use multi-factor authentication for GitHub
and SignPath access.

## Signing provider

The provider is [SignPath.io](https://signpath.io), with a certificate provided
by [SignPath Foundation](https://signpath.org) through its open-source program.
Certificates under this program identify SignPath Foundation as the publisher.

The attribution for releases signed through the program will be:

> Free code signing provided by [SignPath.io](https://signpath.io), certificate
> by [SignPath Foundation](https://signpath.org).

## What is signed

Only files built from this repository are signed; bundled third-party files
keep their own signatures (the OpenJS Foundation's `node.exe`) or stay unsigned
(Electron's Chromium libraries).

| Release asset | Signed files |
| --- | --- |
| `CodeNomad-Tauri-windows-x64-<version>.exe` (installer, WinGet package and in-app update) | The installer and the `codenomad-tauri.exe` application it installs |
| `CodeNomad-Electron-windows-x64-<version>.zip` (portable) | `CodeNomad.exe` inside the archive |

The uninstaller the Tauri installer writes is generated while the installer is
built and is not signed.

## Release signing

1. Windows CodeNomad executables and installers are built from the public
   [CodeNomad repository](https://github.com/NeuralNomadsAI/CodeNomad) on
   GitHub-hosted Actions runners, from an identified release commit
   (`.github/workflows/build-and-upload.yml`).
2. Each job uploads the unsigned files as a GitHub Actions artifact and submits
   it to the SignPath project `CodeNomad` (`.github/actions/signpath-sign`),
   which verifies the artifact's origin before signing. Three signing requests
   are made per release: the Tauri application, then the Tauri installer that
   packages the signed application, and the Electron archive.
3. The artifact configurations in `.signpath/artifact-configurations/` (kept
   identical to those in SignPath) list the exact files and require the product
   name `CodeNomad` and the release version as the product version of every
   signed file. Tauri writes the full release version; for Electron,
   `packages/electron-app/scripts/build.js` passes it to electron-builder as
   `shortVersionWindows`, which electron-builder writes into `CodeNomad.exe`
   before it signs the executable.
4. Pascal André reviews and manually approves each release signing request in
   SignPath. The workflow waits up to two hours for each approval.
5. Before submission the workflow checks each file's product name and version
   (Electron's on every build); afterwards it verifies the returned
   Authenticode signature, its timestamp, the SignPath Foundation signer and
   the product version, and that the contents of the Electron archive differ
   from the build only in `CodeNomad.exe`.
6. The Tauri updater signature is recomputed over the signed installer, and the
   update manifest, release asset digests and WinGet hash are taken from the
   published signed files. Release records identify the source commit and
   build workflow.

Signing access and policy changes are reviewed by the project owners. The
operator investigates failed verifications and reported signing-policy issues.

## Workflow configuration

| Setting | Effect |
| --- | --- |
| Secret `SIGNPATH_API_TOKEN` | API token of the SignPath CI submitter. Pull requests and forks never receive it and build unsigned. |
| Variable `SIGNPATH_RELEASE_SIGNING` = `true` | Stable releases use the `release-signing` policy. A release then fails, rather than publishing unsigned Windows files, when the token is missing or signing or verification fails. |
| **SignPath Test Signing** workflow | Builds a branch and signs its Windows files with the `test-signing` policy without publishing; the signed files are kept as run artifacts. |
| **Develop Pre-Release** input `signpath_test_signing` | Publishes a dev prerelease whose Windows files carry the test signature. |

Test signatures chain to a certificate Windows does not trust; verification
accepts that only for the `test-signing` policy.

## Privacy

CodeNomad's network connections and data handling are described in the
[Privacy policy](PRIVACY.md).
