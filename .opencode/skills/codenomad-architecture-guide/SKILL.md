---
name: codenomad-architecture-guide
description: |
  Comprehensive architecture and SDK navigation guide for the CodeNomad codebase.

  **When to use:** Load this skill when you need to navigate the CodeNomad monorepo, understand cross-package dependencies, work with the OpenCode SDK V2, or ensure you don't miss related code when implementing features or fixing bugs. This skill covers the 6 functional areas (ServerBackend, UserInterface, DesktopClient, SpeechAndAudio, BuildAndPackaging, CloudflareDeployment), OpenCode SDK V2 integration patterns, critical schema behaviors, and feature traces with decision branches.

  **Trigger contexts:** Working on CodeNomad features, debugging cross-area issues, integrating OpenCode SDK APIs, adding UI components, implementing server routes, or navigating the monorepo structure.

  **Permission required:** Agent must explicitly request or be granted permission to load this skill.
---

# CodeNomad Architecture & SDK Navigation Skill

## Quick Start (by contribution frequency)

- **UI component/feature (60%)** → Read `references/ui-conventions.md` → Check i18n
- **Server route/feature (25%)** → Read `references/server-conventions.md` → Check `references/feature-traces.md`
- **Bug fix (10%)** → Use Navigation Guide below → Check `references/feature-traces.md`
- **Desktop/Plugin (5%)** → Read `references/desktop-conventions.md`
- **Not covered?** → See "Escape Hatch" at bottom

## 1. Architecture Overview

CodeNomad is a multi-platform desktop application with a Fastify backend and SolidJS frontend.

### 6 Functional Areas (from RPG analysis)

| Area | Entities | Key Responsibility |
|------|----------|-------------------|
| **UserInterface** | 613 | SolidJS components, stores, hooks, i18n, API client |
| **ServerBackend** | 418 | Fastify routes, auth, workspaces, filesystem, speech |
| **SpeechAndAudio** | 74 | Speech synthesis, voice mode, conversation mode |
| **DesktopClient** | 59 | Electron main, Tauri Rust, preload, IPC |
| **BuildAndPackaging** | 28 | Build scripts, packaging, resource bundling |
| **CloudflareDeployment** | 3 | Edge deployment, asset serving |

### Package Map

- `packages/server/` — Fastify backend, workspaces, auth, speech, sidecars
- `packages/ui/` — SolidJS frontend, stores, components, i18n
- `packages/electron-app/` — Electron desktop wrapper
- `packages/tauri-app/` — Tauri desktop wrapper (Rust + webview)
- `packages/opencode-plugin/` — OpenCode plugin integration

### Key Entry Points

- **Server:** `packages/server/src/index.ts` (CLI entry)
- **UI:** `packages/ui/src/main.tsx` (app bootstrap)
- **Electron:** `packages/electron-app/electron/main/main.ts`
- **Tauri:** `packages/tauri-app/src-tauri/src/main.rs`

## 2. Navigation Guide

### Finding Code in the Codebase

Use grep and file search tools to navigate:

**Search by intent:**
- `grep "permission approval" packages/ui/src/components/`
- `grep "session list" packages/ui/src/stores/`
- `grep "workspace create" packages/server/src/server/routes/`

**Search by imports:**
- Find what uses a module: `grep "import.*from.*module-path" packages/`
- Find exports: `grep "^export" packages/server/src/api-types.ts`

**Cross-reference by feature:**
- Server API types: `packages/server/src/api-types.ts`
- UI type mirrors: `packages/ui/src/types/`
- SDK wrappers: `packages/ui/src/lib/sdk-manager.ts`

## 3. SDK Schema Verification (Mandatory)

**SDK Note:** The OpenCode SDK is an external package (`@opencode-ai/sdk/v2/client`). Its implementation lives outside this repository.

- After `npm install`, you can inspect types in `node_modules/@opencode-ai/sdk/v2/client.d.ts`
- **Fallback:** Read the actual usage patterns in CodeNomad code (see `references/sdk-api-reference.md` for file locations)
- When in doubt, check how the SDK is imported and used in existing CodeNomad files

This skill provides navigation and patterns, not definitive schemas.

## 4. Anti-Patterns

### Common Mistakes

| Mistake | Correct Approach | Reference |
|---------|-----------------|-----------|
| Import `enMessages` directly | Use `t()` or `tGlobal()` | `packages/ui/src/lib/i18n/index.tsx` |
| Set `metadata: { flag: true }` on assistant parts | Use client-side registry | `packages/ui/src/stores/session-compaction.ts` |
| Call `client.session.*` directly without worktree routing | Use `getOrCreateWorktreeClient()` | `packages/ui/src/stores/worktrees.ts` |
| Forget SSE disconnection handling | Add handlers | `packages/ui/src/lib/event-source-handlers.ts` |
| Add hardcoded strings without i18n | Add to English + all 7 locales | `packages/ui/src/lib/i18n/messages/` |
| Modify server route without checking UI API client | Trace full feature flow | `references/feature-traces.md` |
| Change API type without checking UI type matches | Check UI types mirror server types | `packages/ui/src/types/` vs `packages/server/src/api-types.ts` |
| Add bilingual/non-English implementation comments | Use **English-only** for all code comments and documentation | pascalandr PR #278 review |
| Write documentation in non-English languages | All docs and comments must be English-only | pascalandr PR #278 review |

## 5. Platform Integration Checklist

### Desktop Platform Rules

- **Existing IPC/handlers (pre-Tauri):** MUST implement in both Electron + Tauri
- **New features:** Implement in Electron first, Tauri if time permits
- **Native APIs (dialogs, notifications):** Use `packages/ui/src/lib/native/` abstraction

### Checklist

- [ ] Electron main-process changes? (`packages/electron-app/electron/main/`)
- [ ] Tauri Rust changes? (`packages/tauri-app/src-tauri/src/`)
- [ ] Preload API exposure? (`packages/electron-app/electron/preload/`)
- [ ] Native abstraction? (`packages/ui/src/lib/native/`)

## 6. Implementation Checklist

Before submitting changes:

- [ ] Run impact analysis: `grep "YOUR_EXPORT_NAME" packages/` to find all usages
- [ ] Check i18n: Search for hardcoded strings in modified files
- [ ] Verify file length: Check line count (warn >500, reject >800 source; >1000 tests)
- [ ] Check DesktopClient: Does this need IPC/main-process changes?
- [ ] Verify SDK compatibility: Check types in `node_modules/@opencode-ai/sdk/v2/client.d.ts`
- [ ] Cross-area check: If modifying server routes, check UI stores and API clients
- [ ] Check anti-patterns: Review "Common Mistakes" section above
- [ ] API compatibility: If changing `api-types.ts`, check UI type matches
- [ ] Comment language: All implementation comments must be **English-only** (no CJK or other languages)

## 7. Escape Hatch + Update Criteria

### Not Covered?

If your change involves areas not documented here:

1. Read package entry points and scan directory structure
2. Ask the user before proceeding with unfamiliar code

### Update This Skill If

- You discover a new SDK gotcha not documented in `references/sdk-critical-behaviors.md`
- You add a new cross-area feature flow (add to `references/feature-traces.md`)
- File paths or conventions change significantly
- You find an anti-pattern occurring repeatedly
- SDK schemas change and examples become outdated

## Reference Files

| File | Purpose |
|------|---------|
| `references/architecture-overview.md` | Package structure, functional areas, entry points |
| `references/ui-conventions.md` | SolidJS, i18n, stores, components, testing |
| `references/server-conventions.md` | Fastify, API types, config, testing |
| `references/desktop-conventions.md` | Electron + Tauri parity, native abstractions |
| `references/sdk-api-reference.md` | OpenCode SDK V2 categories and signatures |
| `references/sdk-critical-behaviors.md` | Schema gotchas, limitations, decision matrix |
| `references/sdk-integration-patterns.md` | Client lifecycle, error handling, optimistic updates |
| `references/feature-traces.md` | End-to-end flows with decision branches |
