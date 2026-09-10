# AGENT NOTES

## Styling Guidelines
- Reuse the existing token & utility layers before introducing new CSS variables or custom properties. Extend `src/styles/tokens.css` / `src/styles/utilities.css` if a shared pattern is needed.
- Keep aggregate entry files (e.g., `src/styles/controls.css`, `messaging.css`, `panels.css`) lean—they should only `@import` feature-specific subfiles located inside `src/styles/{components|messaging|panels}`.
- When adding new component styles, place them beside their peers in the scoped subdirectory (e.g., `src/styles/messaging/new-part.css`) and import them from the corresponding aggregator file.
- Prefer smaller, focused style files (≈150 lines or less) over large monoliths. Split by component or feature area if a file grows beyond that size.
- Co-locate reusable UI patterns (buttons, selectors, dropdowns, etc.) under `src/styles/components/` and avoid redefining the same utility classes elsewhere.
- Use the shared `.window-*` primitives from `src/styles/components/window.css` for dialog, popover, and floating-window headers, toolbars, bodies, footers, titles, and actions.
- Keep agent, model, and thinking controls in the composer footer via `PromptContextControls`; adapt that footer with the named `prompt-composer` container rather than viewport-only breakpoints.
- Session rows keep actions inline until their measured title, badges, and controls no longer fit. Keep responsive action styles in `styles/components/session-row-actions.css`; hidden inline controls remain measurable but inert, and an open overflow menu stays mounted until dismissal.
- Session hierarchy geometry lives in `styles/components/session-tree.css`; connector axes follow the parent expander at every depth, including selection mode, RTL and touch layouts.
- Never use rounded corners in UI styling; keep corners square unless the user explicitly requests otherwise for a specific change.
- Explicit round exceptions: the Yolo switch, overlay drawer navigation buttons, and floating message scroll buttons. Other chrome remains square.
- The message-content popup and Chat settings share `components/transcript-visibility.ts`; tool presentation metadata lives independently of renderers in `components/tool-call/tool-presentation.ts`. Popup styles live in `styles/components/transcript-filters.css`.
- Session timeline placement spans the transcript and composer via the session-owned mount; keep its rail layout in `styles/messaging/session-timeline-rail.css` and preserve compact-layout hiding.
- Document any new styling conventions or directory additions in this file so future changes remain consistent.
- Soft palette families live in `packages/ui/src/lib/soft-color-schemes.ts`, with references in `dev-docs/PALETTE_SOURCES.md`. Keep selection independent of participant identity, and keep transcript/composer surfaces distinct. Run `palette-quality.test.ts` and inspect real rendered captures when changing palette colors or their token mapping.
- Appearance mode and the saved light/dark selections are independent (`lib/appearance-preferences.ts`). Message/tool cards use the muted surface, inset output and the composer use the base canvas, and preferences use the same secondary surface as the main panels. Use `--surface-hover-overlay` for a subtle local rollover; preserve selected backgrounds beneath that overlay instead of replacing them with a generic panel color.
- Right-panel base-canvas button rollover overrides live in `styles/panels/control-hover.css`; do not substitute the secondary surface merely to show hover.

## Coding Principles

- Session pruning is a narrow V2 plugin/RPC exception under `packages/server/src/opencode/session-pruning/`; see `dev-docs/SESSION_PRUNING_RPC.md`. Bundle it with the shared server for both desktop hosts and provision through normal native plugin discovery. RPC registrations follow backend presence; clean shutdown removes that backend's lease and crashes expire. Loading never deletes content. Deletion occurs only on an explicit pruning request, without an extra enable-write switch or beta-number gate. Keep generic RPC proxy access closed. Writes validate actual storage, a fresh daemon-storage identity challenge and the native durable execution claim inside a synchronous SQLite transaction. Run isolated native concurrency/payload and client-cache regressions; tests must never target the shared daemon or a user's database.
- Favor KISS by keeping modules narrowly scoped and limiting public APIs to what callers actually need.
- Uphold DRY: share helpers via dedicated modules before copy/pasting logic across stores, components, or scripts.
- Enforce single responsibility; split large files when concerns diverge (state, actions, API, events, etc.).
- Prefer composable primitives (signals, hooks, utilities) over deep inheritance or implicit global state.
- When adding platform integrations (SSE, IPC, SDK), isolate them in thin adapters that surface typed events/actions.

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
- Transcript rows retain pointer hit testing during virtualizer scrolling (`styles/messaging/virtual-follow-list.css`), so nested code/tool scrollers and message controls receive gestures at their visible target.
- Run them with `npm run test:browser --workspace @codenomad/ui` after `npx playwright install chromium`. `CODENOMAD_BROWSER_PATH` optionally selects an existing Chromium executable; it does not target the installed application or user sessions.

## V2 Runtime Launch
- Launch the release executable from PowerShell with the dedicated WebView2 profile, CDP port, Rust backtraces, and Node source maps described in `MIGRATION_V2.md`.
- Stop the running CodeNomad instance before rebuilding the same release path, then relaunch it from the independent OpenCode TUI.

## Commit Message Guidelines
- When creating commits, use detailed commit messages: a concise conventional-style subject followed by body paragraphs that explain the user-visible behavior change, the implementation approach, important edge cases or platform considerations, and the validation or test coverage added.
- Prefer messages that explain why the change exists and how regressions are prevented, not just a list of touched files.
