# Contributing to CodeNomad

Thank you for your interest in contributing! This guide will help you get started.

## Quick Start

```bash
git clone https://github.com/NeuralNomadsAI/CodeNomad.git
cd CodeNomad
npm install
npm run dev
```

## Finding Issues to Work On

Browse [open issues](https://github.com/NeuralNomadsAI/CodeNomad/issues) and look for these labels:

| Label | Meaning |
|---|---|
| `ready-to-work` | Clear scope, ready for anyone to pick up |
| `good-first-issue` | Good for first-time contributors |
| `enhancement` | New feature requests |
| `bug` | Bug reports |

**Before starting:** comment on the issue so we can discuss approach and avoid duplicate work.

## Development Workflow

### 1. Fork and Branch

```bash
# Fork the repo on GitHub, then clone your fork
git clone https://github.com/YOUR_USERNAME/CodeNomad.git
cd CodeNomad

# Add the upstream remote
git remote add upstream https://github.com/NeuralNomadsAI/CodeNomad.git

# Create a branch from upstream/dev
git fetch upstream
git checkout -b fix/your-branch-name upstream/dev
```

### 2. Branch Naming

| Prefix | Use for |
|---|---|
| `fix/` | Bug fixes |
| `feat/` | New features |
| `docs/` | Documentation changes |
| `refactor/` | Code refactoring |
| `chore/` | Build, config, maintenance |

Examples: `fix/question-queue-ordering`, `feat/retry-tool-call`, `docs/contributing-guide`

### 3. Make Your Changes

```bash
# Install dependencies
npm install

# Run the dev server
npm run dev

# Run type checking
npm run typecheck --workspace @codenomad/ui
```

### 4. Commit

Write clear, descriptive commit messages. Explain **what** changed and **why**.

```bash
git add .
git commit -m "fix(ui): preserve question queue order when upserting duplicate requests

When a question arrives as a global entry and later resolves to a tool
part with a newer timestamp, the original enqueue time was lost, causing
the question to move behind newer entries and break interruption order."
```

### 5. Push and Create a PR

```bash
git push origin your-branch-name
```

Then open a pull request on GitHub targeting the `dev` branch.

**PR checklist:**
- [ ] Branch is based on latest `upstream/dev`
- [ ] One issue per PR (don't mix unrelated changes)
- [ ] `npm run typecheck --workspace @codenomad/ui` passes
- [ ] Tests pass (if applicable)
- [ ] PR description explains the change and links the issue

## Project Structure

| Package | Description |
|---|---|
| `packages/server` | Core logic & CLI — workspaces, OpenCode proxy, API, auth |
| `packages/ui` | SolidJS frontend — reactive UI components and stores |
| `packages/electron-app` | Electron desktop shell |
| `packages/tauri-app` | Tauri desktop shell (experimental) |

### Key UI Files

| Path | Purpose |
|---|---|
| `packages/ui/src/stores/session-events.ts` | SSE event handlers (idle, status, permissions, questions) |
| `packages/ui/src/stores/session-actions.ts` | User actions (send message, abort, revert, fork) |
| `packages/ui/src/stores/message-v2/` | Message store (v2 architecture) |
| `packages/ui/src/stores/instances.ts` | Instance management and interruption queues |
| `packages/ui/src/components/tool-call.tsx` | Tool call rendering |
| `packages/ui/src/components/message-block.tsx` | Message display blocks |
| `packages/ui/src/components/session/session-view.tsx` | Main session view |
| `packages/ui/src/lib/i18n/messages/` | Translation files (en, es, fr, ja, ru, he, zh-Hans) |

### Styling

- Tokens: `src/styles/tokens.css`
- Utilities: `src/styles/utilities.css`
- Component styles: `src/styles/components/`, `src/styles/messaging/`, `src/styles/panels/`
- Keep style files under ~150 lines; split by component

### Internationalization (i18n)

- Use `useI18n()` in components, `tGlobal()` in stores
- Messages live in `packages/ui/src/lib/i18n/messages/<locale>/`
- When adding a string: add to `en/` first, then add the same key to every other locale
- Placeholders use `{name}` syntax (word characters only)

## Code Principles

- **KISS**: Keep modules narrowly scoped
- **DRY**: Share helpers before copy-pasting
- **Single responsibility**: Split files when concerns diverge
- **Composable primitives**: Prefer signals, hooks, utilities over deep inheritance

## Need Help?

- Check existing [issues](https://github.com/NeuralNomadsAI/CodeNomad/issues) and [PRs](https://github.com/NeuralNomadsAI/CodeNomad/pulls)
- Ask in the issue you're working on
- Review the [server documentation](packages/server/README.md) for CLI flags and configuration
