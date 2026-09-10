# Bundled pruning-plugin lifecycle

CodeNomad ships its pruning plugin with the shared server used by Tauri and
Electron. No user npm install, beta-number allowlist or write-enable option is
required. Loading the plugin does not delete anything.

## Build and automatic provisioning

`npm run build:pruning --workspace @neuralnomads/codenomad` bundles the native
plugin and its dependencies into `packages/server/dist/plugins/session-pruning/plugin.mjs`.
The normal server build includes this step. Both desktop packagers copy the same
artifact into `resources/server/dist/plugins/session-pruning/`.

At server startup, CodeNomad copies this immutable, content-addressed payload to
the CodeNomad data directory (`~/.local/share/codenomad/session-pruning/`, respecting
`XDG_DATA_HOME`). It provisions a small managed entry at
`~/.config/opencode/plugins/codenomad-session-pruning.ts`, respecting
`XDG_CONFIG_HOME` and `OPENCODE_CONFIG_DIR`. Existing user-authored entries are
preserved. No configuration document is rewritten.

The entry imports the copied payload, never a checkout, worktree or application
installation path. CodeNomad upgrades publish a new hash-named payload and
atomically update the entry. Identical launches do not rewrite it. Normal OpenCode
plugin discovery/reload handles the entry; CodeNomad never restarts the shared daemon.

For a WSL workspace, the same backend provisions inside the selected distro's
Linux directories before opening the native location. Windows uses UNC filesystem
access; the native entry contains Linux paths. WSL runtime validation remains a
separate release check.

## Presence and shutdown

- Each CodeNomad backend owns a unique presence file outside watched config paths,
  refreshed every 2 seconds. All windows of that backend share it.
- The native module registers pruning RPCs when at least one fresh presence exists.
- Closing one window/backend leaves other backends' presence intact. Closing the
  last backend removes its presence; RPC disposal follows within the 2-second check.
- A crash leaves a stale file: it expires after 15 seconds, plus up to one check
  interval. Reopening CodeNomad automatically registers RPC again.
- Plugin unload serializes pending registration and disposal, so it cannot recreate
  RPC after cleanup. Lease expiration never modifies content or stops OpenCode.

The small module remains visible in OpenCode's plugin list while inactive. It
registers no model tools, commands or model hooks. While active its RPCs belong to
the shared daemon and are discoverable by its other clients. Deletions affect the
shared session; third-party clients may need to reload their cached transcript.

## Database selection and mutations

The plugin resolves the daemon-side path from `XDG_DATA_HOME`, `OPENCODE_DB`,
channel-specific filenames and `OPENCODE_DISABLE_CHANNEL_DB`. No per-project path
is normally needed. A fresh `ctx.storage` challenge verifies the selected file
before a write. The only mutation trigger is an explicit pruning request.

Selection revisions, session ownership and native execution claims are checked in
the transaction. A committed receipt makes retrying the same selection idempotent.
Pruning never interrupts native execution, clears claims or rewrites checkpoints.
It does not run VACUUM or restore databases.

## Isolated verification

```powershell
npm run build:pruning --workspace @neuralnomads/codenomad
node --import tsx --test packages/server/src/opencode/pruning-installation.test.ts
node scripts/test-session-pruning-native.mjs C:/isolated-cli/opencode2.exe
```

The native fixture uses a private daemon, config, database and mock provider. It
exercises the shipped bundle through automatic discovery, then preview/prune,
concurrent execution, receipts, subscribers, payloads, history, forks, restart and
the presence lifecycle. An optional second argument tests an independently packed
source plugin directory instead. Tests never discover or modify the shared daemon.
