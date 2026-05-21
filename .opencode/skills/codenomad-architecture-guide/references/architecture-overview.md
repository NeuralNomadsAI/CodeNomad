# Architecture Overview

## Package Structure

| Package | Purpose | Key Subdirectories |
|---------|---------|-------------------|
| `packages/server/` | Fastify backend | `src/server/routes/`, `src/workspaces/`, `src/auth/`, `src/speech/` |
| `packages/ui/` | SolidJS frontend | `src/components/`, `src/stores/`, `src/lib/`, `src/types/` |
| `packages/electron-app/` | Electron desktop wrapper | `electron/main/`, `electron/preload/`, `electron/resources/` |
| `packages/tauri-app/` | Tauri desktop wrapper | `src-tauri/src/`, `src-tauri/capabilities/` |
| `packages/opencode-plugin/` | OpenCode plugin integration | `plugin/lib/`, `plugin/codenomad.ts` |
| `packages/cloudflare/` | Edge deployment | `src/`, `scripts/` |

## Functional Areas (from RPG)

### UserInterface (613 entities)
- **Components:** JSX components in `packages/ui/src/components/`
- **Stores:** Signal-based state in `packages/ui/src/stores/`
- **Hooks:** Reusable logic in `packages/ui/src/lib/hooks/`
- **i18n:** 7-locale translation system in `packages/ui/src/lib/i18n/`
- **API Client:** SDK wrapper in `packages/ui/src/lib/sdk-manager.ts`

### ServerBackend (418 entities)
- **API Routes:** Fastify route handlers in `packages/server/src/server/routes/`
- **Authentication:** Auth manager, session manager, token manager in `packages/server/src/auth/`
- **Background Processes:** Process spawn and management in `packages/server/src/background-processes/`
- **Configuration:** YAML-based settings in `packages/server/src/settings/`
- **Filesystem:** Restricted file browser in `packages/server/src/filesystem/`
- **Workspaces:** Git worktrees, runtime management in `packages/server/src/workspaces/`

### SpeechAndAudio (74 entities)
- **Speech Synthesis:** OpenAI-compatible provider in `packages/server/src/speech/`
- **Voice Mode:** Real-time voice state management in `packages/server/src/plugins/voice-mode.ts`
- **Conversation Mode:** Client-side speech queue in `packages/ui/src/stores/conversation-speech.ts`

### DesktopClient (59 entities)
- **Electron Main:** Process manager, menu, IPC in `packages/electron-app/electron/main/`
- **Tauri Rust:** CLI manager, certificate management in `packages/tauri-app/src-tauri/src/`
- **Preload:** API exposure layer in `packages/electron-app/electron/preload/`

### BuildAndPackaging (28 entities)
- **Build Scripts:** Version sync, icon generation, resource copying
- **Packaging:** Server resource bundling, node runtime preparation

### CloudflareDeployment (3 entities)
- **Edge Functions:** Asset serving with cache headers in `packages/cloudflare/src/index.ts`

## Key Entry Points

| Entry Point | File | Purpose |
|-------------|------|---------|
| Server CLI | `packages/server/src/index.ts` | Parses CLI options, starts HTTP server |
| UI Bootstrap | `packages/ui/src/main.tsx` | Initializes SolidJS app, mounts to DOM |
| Electron Main | `packages/electron-app/electron/main/main.ts` | Creates window, starts CLI process |
| Tauri Main | `packages/tauri-app/src-tauri/src/main.rs` | Rust entry, sets up window and CLI |
| Plugin Entry | `packages/opencode-plugin/plugin/codenomad.ts` | Initializes CodeNomad plugin tools |

## Inter-Area Dependencies

```
UserInterface → ServerBackend (via SDK HTTP calls)
UserInterface → SpeechAndAudio (via conversation-speech store)
DesktopClient → UserInterface (hosts the UI in a native window)
DesktopClient → ServerBackend (spawns and manages server process)
ServerBackend → SpeechAndAudio (delegates to speech providers)
ServerBackend → CloudflareDeployment (fetches remote assets)
```

## Finding Code by Area

| Area | Directory Patterns | Search Command |
|------|------------------|----------------|
| UserInterface | `packages/ui/src/components/`, `packages/ui/src/stores/` | `grep "query" packages/ui/src/` |
| ServerBackend | `packages/server/src/server/routes/`, `packages/server/src/workspaces/` | `grep "query" packages/server/src/` |
| DesktopClient | `packages/electron-app/electron/main/`, `packages/tauri-app/src-tauri/src/` | `grep "query" packages/*-app/` |
| SpeechAndAudio | `packages/server/src/speech/`, `packages/ui/src/stores/conversation-speech.ts` | `grep "query" packages/**/speech*` |
