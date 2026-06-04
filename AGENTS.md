# AGENTS.md

Project harness for reliable agent-assisted development in a typescript codebase.

## Startup Workflow

Before writing code:

1. **Confirm working directory** with `pwd`
2. **Read this file** completely
3. **Read project docs if present** (`docs/ARCHITECTURE.md`, `docs/PRODUCT.md`, README, or equivalent)
4. **Run `./init.sh`** to verify environment is healthy
5. **Read `feature_list.json`** to see current feature state
6. **Review recent commits** with `git log --oneline -5`

If baseline verification is failing, repair that first before adding new scope.

## Working Rules

- **One feature at a time**: Pick exactly one unfinished feature from `feature_list.json`
- **Verification required**: Don't claim done without running verification commands
- **Update artifacts**: Before ending session, update `progress.md` and `feature_list.json`
- **Stay in scope**: Don't modify files unrelated to the current feature
- **Leave clean state**: Next session must be able to run `./init.sh` immediately

## Required Artifacts

- `feature_list.json` — Feature state tracker (source of truth)
- `progress.md` — Session continuity log
- `init.sh` — Standard startup and verification path
- `session-handoff.md` — Optional, for larger sessions

## Definition of Done

A feature is done only when ALL of the following are true:

- [ ] Target behavior is implemented
- [ ] Required verification actually ran (tests / lint / type-check)
- [ ] Evidence recorded in `feature_list.json` or `progress.md`
- [ ] Repository remains restartable from standard startup path

## End of Session

Before ending a session:

1. Update `progress.md` with current state
2. Update `feature_list.json` with new feature status
3. Record any unresolved risks or blockers
4. Commit with descriptive message once work is in safe state
5. Leave repo clean enough for next session to run `./init.sh` immediately

## Verification Commands

```bash
# Full verification (recommended)
./init.sh
```

Required checks:
- `pnpm test`
- `pnpm build`

## Styling Guidelines
- Reuse the existing token & utility layers before introducing new CSS variables or custom properties. Extend `src/styles/tokens.css` / `src/styles/utilities.css` if a shared pattern is needed.
- Keep aggregate entry files (e.g., `src/styles/controls.css`, `messaging.css`, `panels.css`) lean—they should only `@import` feature-specific subfiles located inside `src/styles/{components|messaging|panels}`.
- When adding new component styles, place them beside their peers in the scoped subdirectory (e.g., `src/styles/messaging/new-part.css`) and import them from the corresponding aggregator file.
- Prefer smaller, focused style files (≈150 lines or less) over large monoliths. Split by component or feature area if a file grows beyond that size.
- Co-locate reusable UI patterns (buttons, selectors, dropdowns, etc.) under `src/styles/components/` and avoid redefining the same utility classes elsewhere.
- Document any new styling conventions or directory additions in this file so future changes remain consistent.

## Coding Principles
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
- **Adding a new string:** add it to the appropriate `.../messages/en/*.ts` part file, then add the same key to each other locale's corresponding file.
  - Missing translations fall back to English (and finally to the key), so gaps can be easy to miss.
- **Interpolation:** placeholders are simple `{name}` replacements (word characters only). Avoid placeholders like `{file-name}`.
- **Pluralization:** handle manually via separate keys like `something.one` / `something.other` and choose in code.
- **Adding a new language:** add a new `messages/<locale>/` folder + `index.ts`, register it in `packages/ui/src/lib/i18n/index.tsx`, and add it to the language picker in `packages/ui/src/components/folder-selection-view.tsx`.
- **Locale persistence:** the selected locale is stored in app preferences (`locale`) and persisted via the server config (default `~/.config/codenomad/config.json`).
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

## Commit Message Guidelines
- When creating commits, use detailed commit messages: a concise conventional-style subject followed by body paragraphs that explain the user-visible behavior change, the implementation approach, important edge cases or platform considerations, and the validation or test coverage added.
- Prefer messages that explain why the change exists and how regressions are prevented, not just a list of touched files.

## Escalation

If you encounter:
- **Architecture decisions**: Consult project architecture docs if present, otherwise ask user
- **Unclear requirements**: Check product/requirements docs if present, otherwise ask user
- **Repeated test failures**: Update progress, flag for human review
- **Scope ambiguity**: Re-read `feature_list.json` for definition of done
