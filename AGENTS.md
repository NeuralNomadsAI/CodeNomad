# AGENT NOTES

This file loads into every agent session, so it keeps only rules that apply everywhere. Area contracts live in the documents listed under [Area conventions](#area-conventions): before changing code in one of those areas, read that document's **Agent conventions** section. Those rules bind exactly like this file; they moved there only to keep this file short.

## Styling Guidelines
- Reuse the existing token & utility layers before introducing new CSS variables or custom properties. Extend `src/styles/tokens.css` / `src/styles/utilities.css` if a shared pattern is needed.
- Keep aggregate entry files (e.g., `src/styles/controls.css`, `messaging.css`, `panels.css`) lean—they should only `@import` feature-specific subfiles located inside `src/styles/{components|messaging|panels}`.
- When adding new component styles, place them beside their peers in the scoped subdirectory (e.g., `src/styles/messaging/new-part.css`) and import them from the corresponding aggregator file.
- Prefer smaller, focused style files (≈150 lines or less) over large monoliths. Split by component or feature area if a file grows beyond that size.
- Co-locate reusable UI patterns (buttons, selectors, dropdowns, etc.) under `src/styles/components/` and avoid redefining the same utility classes elsewhere.
- Use the shared `.window-*` primitives from `src/styles/components/window.css` for dialog, popover, and floating-window headers, toolbars, bodies, footers, titles, and actions.
- Persistent utility windows and transcript-covering previews expose an upper-right close button in their existing top toolbar; do not add a dedicated row just for dismissal. Use `components/window-close-button.tsx` with shared window chrome. Transient popups such as transcript filters dismiss on outside interaction and have no close button.
- Never use rounded corners in UI styling; keep corners square unless the user explicitly requests otherwise for a specific change.
- Explicit round exceptions: Yolo, MCP and plugin activation switches and the Settings on/off switch for a lone setting (`settings/settings-switch.tsx`), all sharing `styles/components/switches.css` geometry, and floating message scroll buttons. Other chrome, including the fixed panel toggles, remains square.
- Tags and numeric/context/token labels also use rounded geometry via `--chip-radius` (`--pill-radius` is an alias). Register badge variants in `styles/components/badges.css`; use `.badge-shape` for utility-styled labels rather than adding a local radius.
- Pick backgrounds by surface role (`styles/tokens.css`), never by a colour that merely looks close: `--surface-field` (the base colour) is reserved for what users type into (composer, inputs, textareas, search rows); `--surface-canvas` for reading areas (transcript, editors, diffs, main panel bodies); `--surface-overlay` for floating windows, dialogs, popovers, tooltips and every menu or list picker; `--surface-inset` (also `--surface-code`) for code, shell, log and diagnostics output and status cards; `--surface-control` for buttons, segmented controls and select triggers; icon controls that rest flush on a canvas (Files panel toolbars, session header buttons) take the canvas they sit on. The three non-field roles follow the title-bar tint (`--surface-shade-strong`). Utilities `.bg-surface-{field,canvas,overlay,inset}` mirror them; consumers that need concrete colours (Monaco, MUI, extension frames) resolve roles through `lib/css-color.ts`.
- Menus share one item treatment (`--menu-item-hover-bg`/`--menu-item-selected-bg`) across Kobalte menus, selectors and native `<select>`. `styles/components/native-select.css` styles every native select globally: the closed control matches selector triggers (control surface, chevron) and, where `appearance: base-select` and content-box clipping are supported (Electron, WebView2), the open list matches the shared menus and long values stay on one line, clipped before a background-drawn chevron; elsewhere the native select remains. Customizable selects size to the shown value, so auto-width selects need a stable feature width (container units, not percentages of shrink-to-fit parents). Do not style individual selects as fields.
- The `.icon-toggle` active state (`aria-pressed`/`aria-expanded`/`data-active`) is one shared rule in `styles/utilities.css` for every palette; never add per-button or per-palette active overrides (exact tint, exception and contrast test in `dev-docs/UI_CONVENTIONS.md`).
- SUID buttons never animate on press (`MuiButtonBase` `disableTouchRipple` theme default in `lib/theme.tsx`), like the Message content trigger; the keyboard focus ripple remains their focus-visible cue, squared in `styles/components/buttons.css`. Do not re-enable press ripples per component, nor disable the focus ripple without another focus cue.
- Document new conventions where agents will find them: rules that apply everywhere belong in this file; an area's contract belongs in that area's document under **Agent conventions** (create the document and add it to the index below when none fits).

## Coding Principles
- Favor KISS by keeping modules narrowly scoped and limiting public APIs to what callers actually need.
- Uphold DRY: share helpers via dedicated modules before copy/pasting logic across stores, components, or scripts.
- Enforce single responsibility; split large files when concerns diverge (state, actions, API, events, etc.).
- Prefer composable primitives (signals, hooks, utilities) over deep inheritance or implicit global state.
- When adding platform integrations (SSE, IPC, SDK), isolate them in thin adapters that surface typed events/actions.
- Follow `dev-docs/CACHE_REFRESH_CONVENTIONS.md` for display snapshots, coalesced trailing refreshes, stale-response fencing and authoritative mutation reads. Check existing feature semantics before adding another cache or refresh policy.
- Distinguish two production models: (1) a product built and shipped with a controlled, pinned toolchain/library set, where pins define the reproducible build; (2) an application integrating with an independently installed and updated service, where compatibility depends on the API/capability contracts actually consumed. CodeNomad connecting to OpenCode is model (2), even when its SDK/build dependencies are pinned. Never turn the versions used to build or test CodeNomad into an allowlist for the external daemon. Review upstream changes against actual callers; private API use requires contract scrutiny, not automatic exclusion of unfamiliar versions. "Tested with" does not mean "works only with".
- Never block a runtime or feature solely because its version is untested. A version-specific restriction requires either a demonstrated failing test or an identified breaking API change affecting a contract actually consumed by CodeNomad; cite the evidence and explain why the restriction is necessary. Review upstream changes and affected callers rigorously; exhaustive testing of unchanged contracts is not required. Distinguish untested from incompatible and prefer validated capabilities/contracts over speculative version allowlists. Missing capabilities must fail safely without destructive or mass-loading fallbacks.
- The user explicitly forbids modifying OpenCode for Missions autonomy. Use and qualify existing native service/plugin mechanisms; do not infer an upstream-extension requirement from the absence of a named scheduling API or replace the target with a persistent CodeNomad backend.

## Area conventions
Read the **Agent conventions** section of the matching document before changing these areas (paths are under `packages/ui/src/` or `packages/server/src/` unless stated).

- **Missions** (`missions/`, `opencode/missions-plugin.ts`, `server/routes/mission-*`, `host-lifetime/`; UI `components/mission-*`, `components/settings/missions-settings-section.tsx`, `stores/mission-*`, `styles/panels/mission-*`): `dev-docs/MISSIONS.md`; recurring schedules `dev-docs/MISSIONS_RECURRING_SIMPLE.md`; Wayfinder human gates `dev-docs/MISSIONS_HUMAN_ANSWER_RECEIPTS.md`.
- **Questions, permissions and pending-request recovery** (interruption dock, permission receipts, `question-data.ts`, `server/routes/pending-requests.ts`, `workspaces/pending-discovery.ts`, `stores/pending-recovery-*`): `dev-docs/NATIVE_INTERRUPTION_UX.md`.
- **Composer** (`components/prompt-input*`, `prompt-input/`, `PromptContextControls`, `/btw`): `dev-docs/COMPOSER.md`.
- **Transcript** (message rendering, Message content and presets, token lines, tool renderers, `stores/message-v2/`, `stores/opencode-data.ts`, `lib/native-execution-events.ts`): `dev-docs/TRANSCRIPT.md`; long-text bounds `dev-docs/TEXT_DISPLAY_BOUNDS.md`.
- **Timeline, transcript scrolling and history search** (`virtual-follow-list.tsx`, `timeline-*`, `stores/timeline-previews.ts`, history search): `dev-docs/SESSION_HISTORY_NAVIGATION.md`, `dev-docs/SESSION_HISTORY_QUERIES.md`.
- **Shell, panels, tabs, session sidebar and native menus** (`instance/shell/`, `tab-scroll.tsx`, session list, `lib/native/menu-labels*`): `dev-docs/UI_SHELL.md`.
- **Dialogs, utility windows, icon toggles, surfaces and scrollbars** (`alert-dialog.tsx`, `dismissible-window.tsx`, auth recovery, `styles/utilities.css`, `index.css`): `dev-docs/UI_CONVENTIONS.md`.
- **Settings and Preferences** (settings rows/actions, Preferences window and project context, Providers/Web search, Stats, notifications, bug report): `dev-docs/SETTINGS.md`; provider accounts and usage `dev-docs/PROVIDER_ACCOUNTS_UX_PLAN.md`; hotkeys `dev-docs/HOTKEYS.md`; palettes `dev-docs/PALETTE_SOURCES.md`; plugin controls `dev-docs/PLUGIN_ACTIVATION_CONTROLS.md`; right-panel customization and panel extensions `dev-docs/PANEL_EXTENSIONS.md`.
- **Projects and tabs** (closing tabs, temporary workspaces, new-instance launcher, Git-unavailable mode): `dev-docs/PROJECTS.md`.
- **Files panel and Git** (Workspace/Changes/Commits, file watches, Git init, whitespace filter): `dev-docs/FILES_PANEL.md`.
- **Worktrees and event ownership** (`workspaces/native-worktrees.ts`, `workspaces/worktree-inventory.ts`): `dev-docs/WORKTREE_SESSION_PLACEMENT.md`.
- **OpenCode runtime, setup, upgrades and OpenCode settings**: `dev-docs/OPENCODE_V2_POST_BETA.md`; bundled plugin builds, provisioning, presence readiness and the event relay: `dev-docs/OPENCODE_V2_COMPATIBILITY.md`; connection budget: `dev-docs/CACHE_REFRESH_CONVENTIONS.md`; session environment: `dev-docs/SESSION_ENVIRONMENT.md`; pruning: `dev-docs/SESSION_PRUNING_RPC.md`.
- **Remote Control and Remote Access settings**: `dev-docs/REMOTE_CONTROL.md`; **SideCars**: `dev-docs/architecture.md`.
- **Browser previews and automation**: `dev-docs/BROWSER_AUTOMATION.md`, `dev-docs/BROWSER_DEVICE_EMULATION.md`.
- **Desktop hosts**: data profiles `dev-docs/DESKTOP_DATA_PROFILES.md`; updates and update feed `dev-docs/TAURI_UPDATER.md`; Tao/Tauri backports `packages/tauri-app/vendor/README.md`; bundled Node/npm `dev-docs/RUNTIME_MAINTENANCE.md`.
- **Public help** (`docs/help/`, help entry points): `dev-docs/USER_HELP.md`.

## Multi-Language Support (i18n)

The UI uses a small custom i18n layer (no ICU/messageformat). When building features, never hardcode user-visible strings.

- **Runtime API:** use `useI18n()` in components (`const { t } = useI18n();`) and `tGlobal(...)` in stores/non-component code.
  - Implementation: `packages/ui/src/lib/i18n/index.tsx`
- **Where messages live:** `packages/ui/src/lib/i18n/messages/<locale>/` as TypeScript objects (`"flat.dot.keys": "string"`).
  - Each locale has an `index.ts` that merges message parts; duplicate keys throw at build time.
  - Merge helper: `packages/ui/src/lib/i18n/messages/merge.ts`
- **Adding a new string:** add it to the appropriate `.../messages/en/*.ts` part file, then add the same key to each other locale’s corresponding file.
  - Missing translations fall back to English (and finally to the key), so gaps can be easy to miss.
- **Interpolation:** placeholders are simple `{name}` replacements (word characters only). Avoid placeholders like `{file-name}`.
- **Pluralization:** handle manually via separate keys like `something.one` / `something.other` and choose in code.
- **Adding a new language:** add a new `messages/<locale>/` folder + `index.ts`, register it in `packages/ui/src/lib/i18n/index.tsx`, and add it to the language picker in `packages/ui/src/components/folder-selection-view.tsx`.
- **Locale persistence:** the selected locale is stored in app preferences (`locale`) and persisted via the server config (default `~/.config/codenomad/config.yaml`; `config.json` is migration input only).
- **Avoid English-only paths:** do not import `enMessages` directly in feature code; always go through `t(...)` so locale changes apply.

## File Length Guidelines (Highlight Only)

We track file size as a refactoring signal. When you touch or create files, highlight oversized files so the team can plan refactors when time permits.

- Source files: warn after ~500 lines; target limit ~800 lines
- Test files: highlight after ~1000 lines

Behavior for agents:
- Do not refactor solely to satisfy these thresholds.
- When a change touches a file that exceeds the warning/limit, mention it in your final response and include the file path and approximate line count.
- When creating new files, aim to stay under the thresholds unless there's a clear reason.

## Tooling Preferences
- Use the `edit` tool for modifying existing files; prefer it over other editing methods.
- Use the `write` tool only when creating new files from scratch.
- Browser rendering regressions live in `packages/ui/tests/browser/`, with deterministic HTTP fixtures beside them in `fixtures/`. Exercise the real Solid components and native event dispatcher rather than reimplementing rendering logic.
- Run them with `npm run test:browser --workspace @codenomad/ui` after `npx playwright install chromium`. `CODENOMAD_BROWSER_PATH` optionally selects an existing Chromium executable; it does not target the installed application or user sessions.
- Concurrent Vite browser fixtures use `tests/browser/fixture-cache.ts` for per-server optimized-dependency caches; close the server before disposing its owned temporary cache. Never clear the checkout's shared cache to repair a fixture or make parallel tests share mutable optimizer output.

## V2 Runtime Launch
- Native automation instrumentation starts automatically; no Developer Mode toggle or activation restart is required. Do not configure a fixed CDP port or a manual WebView2 profile.
- Rebuild Electron before calling `codenomad.act({ action: "restart" })`. For Windows Tauri, stop and relaunch the release executable only when the linker cannot replace it; never stop the shared OpenCode daemon.

## Pull Requests
- A PR that changes user-visible behavior (labels, controls, steps, defaults, limitations) updates the affected help pages in the same PR: English first, then the nine translations using each locale's UI labels (`dev-docs/USER_HELP.md`). The help publishes from `dev`; CI checks its structure and links, not whether the text still matches the UI.
- The non-blocking `help-update-reminder.yml` workflow comments on a PR that changes English UI messages without touching `docs/help`, and removes the comment once help changes. Answer it before merging: update the help, or confirm nothing user-facing is documented there.

## Commit Message Guidelines
- When creating commits, use detailed commit messages: a concise conventional-style subject followed by body paragraphs that explain the user-visible behavior change, the implementation approach, important edge cases or platform considerations, and the validation or test coverage added.
- Prefer messages that explain why the change exists and how regressions are prevented, not just a list of touched files.
