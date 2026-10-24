# Documentation Index

Start with [README](../README.md) for installation and usage, then
[architecture](architecture.md) for ownership boundaries and code locations.
[AGENTS.md](../AGENTS.md) defines the rules that apply everywhere (styling, i18n, contribution) and indexes the area documents whose rules bind each area.

## Runtime and ownership

- [OpenCode compatibility](OPENCODE_COMPATIBILITY.md): qualification policy, consumed contracts and integration limits.
- [Runtime setup and recovery](OPENCODE_RUNTIME_SETUP.md): admission, installation/upgrade and service maintenance.
- [Worktree/session placement](WORKTREE_SESSION_PLACEMENT.md): native location identity and authorized conversation movement.
- [Session environment](SESSION_ENVIRONMENT.md): server-only execution-host snapshots, fresh profile reads at admission and fail-closed per-send synchronization.
- [Session recovery](SESSION_RECOVERY.md): reconciling saved session activity with native state.
- [Cache refresh conventions](CACHE_REFRESH_CONVENTIONS.md): display snapshots, invalidation and authoritative mutation reads.
- [Bundled runtime maintenance](RUNTIME_MAINTENANCE.md): Node/npm pinning, LTS proposals and the dependency audit.

## History and pruning

- [History queries](SESSION_HISTORY_QUERIES.md): bounded search, counts and cleanup queries.
- [History navigation](SESSION_HISTORY_NAVIGATION.md): structural indexes and anchor windows.
- [Text display bounds](TEXT_DISPLAY_BOUNDS.md): rendering windows for long text and tool output.
- [Pruning RPC](SESSION_PRUNING_RPC.md): narrow native integration and packaging.
- [Pruning safety](SESSION_PRUNING_SAFETY.md): transactional authorization, identity and replay contracts.

## UI and extensions

- [UI conventions](UI_CONVENTIONS.md): dialogs, utility windows, icon toggles, surfaces and scrollbars.
- [Application shell](UI_SHELL.md): panel toggles, drawers, tabs, session sidebar and native menus.
- [Composer](COMPOSER.md): context selectors, height, focus, delivery, attachments and mentions.
- [Transcript rendering](TRANSCRIPT.md): Message content presets, token lines, tool renderers and lifecycle signals.
- [Settings and Preferences](SETTINGS.md): settings rows, the Preferences window, Providers/Web search, Stats and notifications.
- [Preview origins and permissions](PREVIEWS.md): token capabilities, origin modes, server CSP sandbox and the iframe frame contract.
- [Projects and tabs](PROJECTS.md): closing tabs, temporary workspaces, the new-instance launcher and Git-unavailable mode.
- [Public user help](USER_HELP.md): multilingual static site, stable anchors, local search, app entry points and Pages validation.
- [Files panel](FILES_PANEL.md): workspace editing, Git changes/history and preview lifecycle.
- [Questions and permissions](NATIVE_INTERRUPTION_UX.md): permissions/Forms dock, drafts and pending-request recovery.
- [Keyboard shortcuts](HOTKEYS.md): the shortcut catalog, recording and dispatch.
- [Provider accounts](PROVIDER_ACCOUNTS.md): native account selection, usage credentials and bounded quota/rotation policy.
- [Plugin controls](PLUGIN_CONTROLS.md): explicit Global/Project activation and native package check/update.
- [Panel extensions](PANEL_EXTENSIONS.md): distribution, trust, consent and sandbox/API boundaries.
- [Palette sources](PALETTE_SOURCES.md): color provenance and validation.

## Missions

- [Missions](MISSIONS.md): one-time Mission maps, native admission, Wayfinder/Debugging/Product delivery playbooks and validation.
- [Recurring Missions](MISSIONS_RECURRING.md): daily native schedule contract; the [qualification fixture](MISSIONS_RECURRING_QUALIFICATION.md) runs its journeys against an isolated runtime.
- [Autonomy requirement](MISSIONS_AUTONOMY.md): Missions run in the OpenCode service with the CodeNomad UI and backend closed.

## Desktop automation and validation

- [Desktop instrumentation and browser automation](BROWSER_AUTOMATION.md): always-available automation tools, authenticated transport, owned native previews and targeting.
- [Device emulation](BROWSER_DEVICE_EMULATION.md): touch profiles and sizing contracts.
- [Desktop data profiles](DESKTOP_DATA_PROFILES.md): profile resolution, isolation and cleanup.
- [Tauri updates](TAURI_UPDATER.md): signed updates, the update feed and Linux AppImage distribution.
- [Remote Control](REMOTE_CONTROL.md): OpenTunnel transport, pairing and device admission.
- [Tauri backports](../packages/tauri-app/vendor/README.md): upstream provenance, validation commands and override removal criteria.
- [Build guide](../BUILD.md): packaging and platform build commands.
- [Contributing](../CONTRIBUTING.md): development and test workflows.
