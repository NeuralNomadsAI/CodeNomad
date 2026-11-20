# Installing the Rust backend as a user service

A release is a `codenomad-rs-<version>/` folder: the binary (its `--version` is the release version), `plugins/{session-pruning, automation, missions (+ provider.mjs), memory}/plugin.mjs`, `VERSION`, `MANIFEST`, `SHA256SUMS` and `SHA256SUMS.minisig` (minisign; the version is bound in the trusted comment). Before any install or update, `cnrs-release admit` checks the signature against the pinned key and every hash, refuses unlisted files, and checks the `releases/<v>.tmp` copy again before renaming it. Releases sit side by side; `current` and `previous` name the active release and the rollback target. Identity, TLS and paired devices live outside releases.

The binary provisions the bundled plugins itself on every daemon connection (`CNRS_PROVISION_PLUGINS=1`: pruning, Missions, memory, and automation with `CODENOMAD_NATIVE_PARENT=1`; or an explicit list) and answers per-location preparation (`<lease>.prepare/<nonce>.json` → `.ack` + `.scope`) before session history. The daemon listens on a fixed loopback port (`DAEMON_PORT`, also its `service set port`). The backend finds it like the TypeScript server, through the pinned CLI (`opencode service status`, `get password`) run with the daemon's profile, which `codenomad-rs.env` repeats (home, data, config and cache folders); when none answers, it starts one with `opencode service start` on the same profile and port. After a daemon restart, the backend reconnects and provisions again without restarting.

Key: `cnrs-release keygen <dir>` writes `release.pub` and an unencrypted `release.key`, kept outside the repository. Signing: `cnrs-release sign <release> <release.key>` (run by `package.*`). Plugin payloads: `node install/build-plugins.mjs <dir>` copies them from the built TypeScript server (`npm run build --workspace @neuralnomads/codenomad`).

## Release serial and key rotation

Every release carries `MANIFEST` (listed in `SHA256SUMS`, hence signed): `serial <n>` and optionally `next-key <key>`. The install keeps a trust state (`release-trust`: pinned key, highest accepted serial, accepted releases) in its configuration and a copy in its state (`<root>\config` and `<root>\state`; `~/.config/codenomad-rs` and `~/.local/state/codenomad-rs`). The copy with the higher serial wins; each is replaced atomically.

- A new release must be signed by the pinned key with a strictly higher serial; only the release that set the serial can be reinstalled as is. This holds after an uninstall without `-Purge`/`--purge`; a purge erases the trust state, and the next install pins a key again.
- Serial and key advance as soon as the release is accepted (verified copy, before restart), even if it then fails its health check.
- A release announcing `next-key` rotates the key: later releases must be signed by the announced key, and the old one is refused.
- An update interrupted after the copy or after the state write completes when the same update is run again; any other release waits for it.
- A copied or restored state is refused while a copied release has a higher serial.
- Local rollback (`rollback.*`, automatic or manual) keeps the serial and only targets a release already accepted by this install and unchanged since, whatever key signed it. Going further back than `previous` requires publishing a higher serial.

Release N+1 for an install (version from the binary's `--version`, built with `CNRS_BUILD_VERSION=<v>`); `--rotate <dir>` announces that folder's key (created if needed), which signs the following releases:

```powershell
node install\next-release.mjs --trust <root>\config\release-trust --binary <codenomad-rs.exe> --plugins <plugins> --out <dir> --tool <cnrs-release.exe> --key <release.key> [--rotate <key dir>]
pwsh -NoProfile -File install\windows\update.ps1 -Root <root> -Release <printed release>
```

## Ubuntu (systemd --user)

Requirements: `curl`, `jq`, `sha256sum`, Rust to build. Two units: `codenomad-opencode.service` (isolated daemon) and `codenomad-rs.service` (`Wants=`/`After=` the daemon; `ExecStartPre=check-private.sh` refuses to start unless the release, `bin`, OpenCode and the configuration are private). Secrets go in `~/.config/codenomad-rs/*.env` (0600) with `umask 077` throughout. The unit sets `GLIBC_TUNABLES=glibc.malloc.mmap_threshold=131072`: without it each password login (scrypt, 16 MiB buffer) raises glibc's mmap threshold and the memory stays in the heap. For a manual or WSL launch, export the same variable before `codenomad-rs`.

From `packages/server-rs`, with `$W` a private work folder outside the repository and `$IP` the advertised private address:

```bash
CNRS_BUILD_VERSION=0.2.0 CARGO_TARGET_DIR=$W/target cargo build --release --locked
CARGO_TARGET_DIR=$W/target-tools cargo build --release --locked --manifest-path install/tools/Cargo.toml
node install/build-plugins.mjs $W/plugins
$W/target-tools/release/cnrs-release keygen $W/keys/main
bash install/linux/package.sh 0.2.0 $W/target/release/codenomad-rs $W/plugins $W/releases $W/target-tools/release/cnrs-release $W/keys/main/release.key 2   # serial [next.pub]
bash install/linux/install-opencode.sh <opencode-cli-linux-x64-<version>.tgz> <archive sha256>
bash install/linux/install.sh $W/releases/codenomad-rs-0.2.0 --public-key $W/keys/main/release.pub --verifier $W/target-tools/release/cnrs-release --port 47940 --daemon-port 47941 --https-bind $IP:47943 --https-name $IP
bash install/linux/health.sh                            # version, serverVersion, serverId, plugins, connections
bash install/linux/update.sh <release>                  # 0 updated, 2 rolled back automatically, 1 release refused
bash install/linux/rollback.sh
bash install/linux/check-private.sh ~/.local/share/codenomad-rs ~/.config/codenomad-rs ~/.local/state/codenomad-rs
bash install/linux/admin.sh POST /api/remote-control/pairings "{\"origin\":\"https://$IP:47943\"}"
journalctl --user -u codenomad-rs -n 50 --no-pager
bash install/linux/uninstall.sh                         # --purge also removes releases, secrets, identity, devices and the pinned key
```

Without an open session, `loginctl enable-linger "$USER"` keeps the units running; otherwise they stop cleanly (SIGTERM) when the last session closes.

## Windows (scheduled task, console-less supervisor)

The current user's `CodeNomadRs-<fingerprint>` task (logon trigger, `LogonType Interactive`, `RunLevel Limited`, no elevation) starts `bin\cnrs-supervisor.exe` directly, a Windows-subsystem executable: no console, `wscript` or PowerShell. A Windows service would need administrator rights, so none is installed. The supervisor starts the daemon and the backend without windows (`CREATE_NO_WINDOW`), each in a kill-on-close job object; it restarts whichever stops, handles `run\restart.request` / `run\stop.request` (clean `shutdown` on standard input), and before each launch checks that the root, `bin`, `releases`, the launched release, `opencode` and `config` grant access to the user and SYSTEM only (otherwise it refuses and logs to `run\logs\supervisor.log`). At sign-out Windows ends the supervisor without notice: the job kills the daemon and backend (lease expires within 15 s, writes are atomic) and the task starts them again at the next sign-in.

`install.ps1` creates the root with a protected DACL (user + SYSTEM) before anything else and refuses a root that is a junction or link, owned by another account, cannot be restricted, or whose parent lets other accounts replace it. Run it unelevated: an elevated token would give the files to the Administrators group.

From `packages/server-rs`, with `$W` a private work folder outside the repository and `$OpenCode` the absolute path of the native OpenCode executable:

```powershell
$Root = "$W\root"; $Tools = "$W\target-tools\release"
$Ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias 'vEthernet (Default Switch)').IPAddress   # or any private address of the machine
$env:CARGO_TARGET_DIR = "$W\target-tools"
cargo build --release --locked --manifest-path install\tools\Cargo.toml
$env:CARGO_TARGET_DIR = "$W\target"; $env:CNRS_BUILD_VERSION = '0.2.0'
cargo build --release --locked
node install\build-plugins.mjs "$W\plugins"
& "$Tools\cnrs-release.exe" keygen "$W\keys\main"
pwsh -NoProfile -File install\windows\package.ps1 -Version 0.2.0 -Binary "$W\target\release\codenomad-rs.exe" -Plugins "$W\plugins" -Out "$W\releases" -Tool "$Tools\cnrs-release.exe" -Key "$W\keys\main\release.key" -Serial 2   # [-NextKey next.pub]
pwsh -NoProfile -File install\windows\install.ps1 -Root $Root -Release "$W\releases\codenomad-rs-0.2.0" -OpenCode $OpenCode -Tools $Tools -PublicKey "$W\keys\main\release.pub" -Port 47911 -DaemonPort 47913 -HttpsBind "${Ip}:47912" -HttpsName $Ip
pwsh -NoProfile -File install\windows\health.ps1 -Root $Root
pwsh -NoProfile -File install\windows\check-acl.ps1 -Root $Root
pwsh -NoProfile -File install\windows\update.ps1 -Root $Root -Release <release>
pwsh -NoProfile -File install\windows\rollback.ps1 -Root $Root
pwsh -NoProfile -File install\windows\uninstall.ps1 -Root $Root     # -Purge also removes the folder
```

Direct pairing requires a private, non-loopback origin (here the Default Switch address).

`CNRS_HOME`, `CNRS_CONFIG`, `CNRS_STATE`, `CNRS_RUST_UNIT` and `CNRS_DAEMON_UNIT` install a second copy beside the default one (separate roots and units).

Tool tests (signing, serials, rotation, resumption): `cargo test --release --locked --manifest-path install/tools/Cargo.toml`.
