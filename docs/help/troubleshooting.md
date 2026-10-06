# Troubleshooting

Checks for the CodeNomad interface and its connection to OpenCode. Shared-service restarts affect other connected clients too.

## OpenCode will not connect

Open **Settings → OpenCode** and check the selected executable, running-service status, and compatibility details. Use **Check status and updates**; install or select a supported OpenCode V2 executable if needed.

If an update is installed but the old service is still running, use the explicit restart action when it is safe to interrupt shared work. A configuration reload is not an executable upgrade.

## No model is available

If a model works in OpenCode but is missing in CodeNomad, check **Settings → Providers → Manage models** for selector visibility, then check the active account. **Models** and **Web search** are separate groups.

## Git or worktrees are unavailable

Check Git in the CodeNomad **backend process's `PATH`**, not only in the agent's shell. Restart CodeNomad or its standalone server after changing that environment.

Git inside WSL alone does not satisfy a Windows backend. Until Git is available, folder-only conversations can still work, but repository and worktree features cannot.

## A reply seems stuck

Pending requests are in the area **above the composer**, including requests from subsessions and other conversations. Check that area rather than looking for an editable transcript form. **Status** shows background activity; message-content filters can hide reasoning and tool details.

Use **Stop** if you want to interrupt the execution. If sending failed, verify the current state before trying again—do not assume the server rejected it before doing any work.

If the interface itself freezes, [report it](https://github.com/NeuralNomadsAI/CodeNomad/issues) with your CodeNomad version, OpenCode version, OS, desktop host (Tauri/Electron) or browser, and whether the server is remote. Include repeatable steps where possible, but remove credentials and private project content.

## Remote login or HTTPS fails

The remote URL and login belong to the **CodeNomad server**, not directly to the OpenCode service. Check its reachability and authentication independently of provider credentials.

Only trust a certificate warning after verifying that the server is yours. For remote hosts, prefer a trusted certificate or secure tunnel. See the [server authentication and TLS guide](https://github.com/NeuralNomadsAI/CodeNomad/blob/dev/packages/server/README.md).

## Desktop-specific startup issues

For an unnotarized macOS download that Gatekeeper marks as damaged, use the documented [macOS steps](https://github.com/NeuralNomadsAI/CodeNomad#troubleshooting) only after verifying the download's source.

On Linux with Wayland/NVIDIA, a Tauri WebKitGTK startup failure may be a graphics issue. The [same troubleshooting section](https://github.com/NeuralNomadsAI/CodeNomad#troubleshooting) lists the workaround; Electron is an alternative host. The Tauri Debian package is currently qualified on Ubuntu 24.04, not every Debian-based distribution.

## Go deeper

- [OpenCode V2 documentation](https://opencode.ai/v2/docs/) for agents, commands, skills, and tool configuration.
- [CodeNomad server guide](https://github.com/NeuralNomadsAI/CodeNomad/blob/dev/packages/server/README.md) for hosting and connection options.
- [CodeNomad issues](https://github.com/NeuralNomadsAI/CodeNomad/issues) for bugs and feature requests.
