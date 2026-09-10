# Explicit pruning-plugin deployment

No automatic install, runtime upgrade or service restart is part of CodeNomad's
pruning commands. This remains experimental and defaults to read-only. Review
[safety](SESSION_PRUNING_SAFETY.md) and the remaining validation in
[SESSION_PRUNING_RPC.md](SESSION_PRUNING_RPC.md) before enabling writes.

## Build an installable package

From the repository root, with an existing absolute output directory:

```powershell
npm pack ./packages/server/src/opencode/session-pruning --pack-destination C:/isolated-packages
```

Install the resulting `.tgz` into a dedicated plugin installation directory with
`npm install <absolute-tgz-path> --ignore-scripts`. This installs the pinned plugin
API and Zod independently of CodeNomad. Nothing is published to npm. The package
contains source TS entrypoints supported by OpenCode, no fixture DB, and no Core fork.

Run the isolated native test against that installed directory:

```powershell
node scripts/test-session-pruning-native.mjs C:/isolated-cli/opencode2.exe C:/isolated-plugins/node_modules/@neuralnomads/codenomad-session-pruning
```

The CLI must be exactly beta-19419. This command runs a private server with generated
data and a local provider, and never uses the ordinary background-service discovery.

## Activation, only after explicit approval

Before using any real session: obtain agreement from users of the shared daemon,
make and verify a coherent backup, and validate restart/read/resume on an isolated
copy. If stopping the daemon is needed for backup/installation, schedule that as
separate maintenance; it affects TUI and other clients too. Do not silently restart
or upgrade a running service just to meet this plugin's version gate.

Merge an entry into the appropriate OpenCode `opencode.json(c)` **without replacing
existing configuration**. Start with preview (omit `mode`, or use `"preview"`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "C:/isolated-plugins/node_modules/@neuralnomads/codenomad-session-pruning",
      "options": {
        "databasePath": "C:/explicitly-approved-state/opencode.db",
        "mode": "preview"
      }
    }
  ]
}
```

These are placeholders, not the current user's database path. The package value is
a **directory**. A `plugin.ts` file configured as a package is rejected by beta-19419.
Database paths are interpreted on the **daemon's** OS, never the browser's. The fresh
storage challenge rejects a mistaken snapshot or different daemon DB for mutation.

After the deployment gates and backup are satisfied, an operator may change only
`mode` to `"prune"`. Busy/unsupported sessions still refuse the operation; this is
not a force flag. A runtime update automatically closes the exact-version write gate
until that version is audited and tested. Never relax it to `startsWith("beta")`.

The `./tui` companion is exposed beside the main plugin for native automatic loading.
Remote TUI clients must have the package available locally as described by the V2 CLI
plugin documentation. Other unmodified clients must reload history after pruning;
receiving custom events does not teach them how to invalidate their caches.

## Failure and recovery

- Not confirmed / timeout: re-read the message. Retry the identical revision/indices
  to recover an acknowledgement; do not assume the DB was unchanged.
- Busy: let native work settle and retry; the plugin never interrupts it for you.
- Unsupported storage/version: leave writes disabled. Do not delete event rows,
  triggers or native claims to bypass the gate.
- Disable: return to preview or remove only this plugin entry through the normal
  plugin/config workflow. This does not undo prior deletions.
- Restore: requires a separately approved, all-clients maintenance window and a
  validated backup. No automatic replacement of the active DB is supplied.

Deleting technical blocks is not universal database repair and does not perform
VACUUM. Credentials, unrelated conversations, legacy V1 parts and retained events
must never be copied into bug reports or package artifacts.
