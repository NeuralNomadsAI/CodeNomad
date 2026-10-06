# Connect OpenCode

Use your existing OpenCode V2 setup from a local desktop host or through a CodeNomad server.

## Local desktop

Download [the current desktop build](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest), then select your OpenCode executable in setup. CodeNomad prefers executables on `PATH`; **Settings → OpenCode** exposes the selected CLI and the running shared service separately. An installation action is available if you need it. Desktop builds bundle Node.js/npm.

Open the repository or folder whose sessions you want to access. CodeNomad uses directory ownership to determine which sessions belong to that project; see [projects and worktrees](projects.md).

## Backend versus execution host

Git must be available in the **CodeNomad backend's `PATH`**, even when OpenCode executes inside WSL. Git installed only in WSL does not satisfy a Windows backend. Restart the backend after changing its environment.

With Git unavailable, folder-only sessions remain usable, but Git/worktree features and cross-checkout discovery are unavailable.

## Browser and remote desktop

Run CodeNomad on the host containing your projects and OpenCode setup. The standalone server requires Node.js 24 LTS/npm:

```sh
npx @neuralnomads/codenomad --password "your-password" --launch
```

Use the printed connection URL in a browser or CodeNomad's remote connection screen. The server binds to loopback by default; use the [server guide](https://github.com/NeuralNomadsAI/CodeNomad/blob/dev/packages/server/README.md#remote-access-binding-rules) for remote binding, authentication, and TLS options.

Project paths, commands, and SideCar ports refer to the **server host**, not the client displaying CodeNomad. Device attachments are the exception: they come from the client device.

## CLI updates are not service restarts

Updating OpenCode through CodeNomad changes the installed executable, not the running service. Restart explicitly when you want to activate it; this can interrupt work in all connected clients. Closing CodeNomad leaves the service running.
