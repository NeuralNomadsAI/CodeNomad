# Documentation Index

Start with [README](../README.md) for installation and usage, then
[architecture](architecture.md) for ownership boundaries and code locations.
[AGENTS.md](../AGENTS.md) defines contribution, styling and i18n conventions.

## Runtime and ownership

- [OpenCode compatibility](OPENCODE_V2_COMPATIBILITY.md): qualification policy, consumed contracts and integration limits.
- [Stable-runtime transition](OPENCODE_V2_POST_BETA.md): technical minimum, installation/recovery, retired adapters and migration evidence.
- [Worktree/session placement](WORKTREE_SESSION_PLACEMENT.md): native location identity and authorized conversation movement.
- [Session environment](SESSION_ENVIRONMENT.md): server-only execution-host snapshots and fail-closed per-send synchronization.
- [Cache refresh conventions](CACHE_REFRESH_CONVENTIONS.md): display snapshots, invalidation and authoritative mutation reads.

## History and pruning

- [History queries](SESSION_HISTORY_QUERIES.md): bounded search, counts and cleanup queries.
- [History navigation](SESSION_HISTORY_NAVIGATION.md): structural indexes and anchor windows.
- [Pruning RPC](SESSION_PRUNING_RPC.md): narrow native integration and packaging.
- [Pruning safety](SESSION_PRUNING_SAFETY.md): transactional authorization, identity and replay contracts.

## UI and extensions

- [Files panel](FILES_PANEL.md): workspace editing, Git changes/history and preview lifecycle.
- [Native interruptions](NATIVE_INTERRUPTION_UX.md): permissions/Forms dock, drafts and pending-request recovery.
- [Provider accounts](PROVIDER_ACCOUNTS_UX_PLAN.md): native account selection and bounded quota/rotation policy.
- [Plugin activation](PLUGIN_ACTIVATION_CONTROLS.md): explicit Global/Project controls.
- [Panel extensions](PANEL_EXTENSIONS.md): distribution, trust, consent and sandbox/API boundaries.
- [Palette sources](PALETTE_SOURCES.md): color provenance and validation.

## Missions

- [Missions](MISSIONS.md): one-time Mission maps, native admission, Wayfinder/Debugging playbooks and validation.
- [Recurring Missions](MISSIONS_RECURRING_SIMPLE.md): simple native schedule contract; [qualification](MISSIONS_RECURRING_SIMPLE_QUALIFICATION.md) records the isolated native runs.

## Desktop automation and validation

- [Desktop instrumentation](DEVELOPER_MODE.md): always-available automation and authenticated transport; no Developer Mode gate.
- [Browser automation](BROWSER_AUTOMATION.md): owned native previews and targeting.
- [Device emulation](BROWSER_DEVICE_EMULATION.md): touch profiles and sizing contracts.
- [Tauri backports](../packages/tauri-app/vendor/README.md): upstream provenance, validation commands and override removal criteria.
- [Build guide](../BUILD.md): packaging and platform build commands.
- [Contributing](../CONTRIBUTING.md): development and test workflows.
