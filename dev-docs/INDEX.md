# Documentation Index

Start with [README](../README.md) for installation and usage, then
[architecture](architecture.md) for ownership boundaries and
[technical implementation](technical-implementation.md) for API examples and code locations.
[AGENTS.md](../AGENTS.md) defines contribution, styling and i18n conventions.

## Runtime and ownership

- [OpenCode compatibility](OPENCODE_V2_COMPATIBILITY.md): qualification policy, consumed contracts and integration limits.
- [Stable-runtime transition](OPENCODE_V2_POST_BETA.md): technical minimum, installation/recovery, retired adapters and historical migration evidence.
- [First-install recovery](OPENCODE_FIRST_INSTALL_RECOVERY.md): setup failure diagnosis and recovery.
- [Worktree/session placement](WORKTREE_SESSION_PLACEMENT.md): native location identity and authorized conversation movement.
- [Event relay ownership](EVENT_RELAY_OWNERSHIP.md): routing, ordering and connection fences.
- [Session environment](SESSION_ENVIRONMENT.md): server-only execution-host snapshots and fail-closed per-send synchronization.
- [Cache refresh conventions](CACHE_REFRESH_CONVENTIONS.md): display snapshots, invalidation and authoritative mutation reads.

## History and pruning

- [History queries](SESSION_HISTORY_QUERIES.md) and [navigation](SESSION_HISTORY_NAVIGATION.md): bounded search, structural indexes and anchor windows.
- [Pruning RPC](SESSION_PRUNING_RPC.md), [safety](SESSION_PRUNING_SAFETY.md) and [deployment](SESSION_PRUNING_DEPLOYMENT.md): narrow native integration, transactional authorization and packaging.
- [Transcript replay](TRANSCRIPT_REPLAY.md): native message projection and reconciliation.

## UI and extensions

- [Files panel](FILES_PANEL.md): workspace editing, Git changes/history and preview lifecycle.
- [Native interruptions](NATIVE_INTERRUPTION_UX.md): permissions/Forms dock, drafts and pending-request recovery.
- [Attachments](ATTACHMENT_UX_PLAN.md): device bytes, project references and skills.
- [Provider accounts](PROVIDER_ACCOUNTS_UX_PLAN.md): native account selection and bounded quota/rotation policy.
- [Plugin activation](PLUGIN_ACTIVATION_CONTROLS.md): explicit Global/Project controls.
- [Panel extensions](PANEL_EXTENSIONS.md): distribution, trust, consent and sandbox/API boundaries.
- [Palette sources](PALETTE_SOURCES.md): color provenance and validation.

## Desktop automation and validation

- [Desktop instrumentation](DEVELOPER_MODE.md): always-available automation and authenticated transport; no Developer Mode gate.
- [Browser automation](BROWSER_AUTOMATION.md) and [device emulation](BROWSER_DEVICE_EMULATION.md): owned native previews, targeting and touch profiles.
- [Tauri Windows input](TAURI_WINDOWS_INPUT_DEADLOCK.md) and [macOS startup](TAURI_MACOS_STARTUP.md): upstream backports, failure evidence and removal criteria.
- [CI reliability](CI_RELIABILITY.md): isolated regression and release fixtures.
