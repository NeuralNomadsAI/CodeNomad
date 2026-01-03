# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CodeNomad is a multi-instance desktop application for running OpenCode sessions. Built with Electron, SolidJS, and Fastify, it provides a premium workspace for AI-powered coding sessions. The app is structured as an npm workspace monorepo with specialized packages.

## Architecture

### Monorepo Structure

```
packages/
├── electron-app/          # Electron shell (windows, IPC, packaging)
├── server/               # Core CLI, OpenCode session management, Fastify API
├── ui/                   # SolidJS frontend (reactive UI components)
├── tauri-app/            # Experimental Tauri-based alternative
└── opencode-config/      # OpenCode config template + plugins
```

### Package Relationships

- **electron-app** depends on **server** and **ui**
- **server** provides the CLI (`codenomad`), Fastify API server, and OpenCode integration
- **ui** is the web frontend served by both electron-app and server
- **opencode-config** is copied into the app bundle at build time for OpenCode plugin integration

### Key Technologies

- **Frontend**: SolidJS 1.8, Vite 5, TailwindCSS 3, Kobalte UI components
- **Desktop**: Electron 39.0.0, electron-vite, electron-builder
- **Backend**: Fastify, Node.js test framework, Commander.js
- **OpenCode**: Uses `@opencode-ai/sdk` for session management

## Development Commands

### Running the App

```bash
# Start Electron app (default)
npm run dev

# Start Tauri app (experimental)
npm run dev:tauri

# Start CLI server directly
npm run dev --workspace @neuralnomads/codenomad
```

### Building

```bash
# Build Electron app
npm run build

# Build UI only
npm run build:ui

# Platform-specific binary builds
npm run build:mac-x64        # macOS Intel only
npm run build:mac-arm64      # macOS Apple Silicon only
npm run build:mac            # macOS universal
npm run build:win            # Windows x64
npm run build:linux          # Linux x64
npm run build:binaries       # Build for current platform (defaults to mac)
```

### Testing & Type Checking

```bash
# Type check all packages
npm run typecheck

# Run specific test files
node --test packages/server/src/filesystem/__tests__/*.test.ts
```

## Important Architecture Notes

### Event System

The server uses an event bus pattern for real-time updates. Events are streamed to the UI via Server-Sent Events (SSE). Key event types include:
- Message events from OpenCode sessions
- Background process status updates
- Workspace state changes

### OpenCode Integration

- The app spawns `opencode serve --port 0` instances for each workspace
- A plugin system bridges events between CodeNomad and OpenCode
- The `opencode-config` package provides the plugin that runs inside OpenCode sessions

### IPC Communication (Electron)

Electron main process handles:
- Window management (creating, closing, focusing)
- Menu bar
- File dialogs
- Deep linking

The preload script exposes a controlled API to the renderer.

### UI State Management

SolidJS stores handle reactive state:
- `workspacesStore`: Active sessions and their status
- `settingsStore`: User preferences
- Components use Solid's reactivity system directly

## Build Requirements

- **Node.js 18+** required
- **npm 7+** or **pnpm** for workspace support
- **OpenCode CLI** must be in PATH for the app to function
- **Xcode Command Line Tools** on macOS for building

## Local Build (macOS Only)

For local development builds targeting only macOS:

```bash
npm run build:mac-x64    # Intel Macs
npm run build:mac-arm64  # Apple Silicon Macs
```

The build script (`packages/electron-app/scripts/build.js`) orchestrates three steps:
1. Builds the server package (`@neuralnomads/codenomad`)
2. Builds the Electron app with `electron-vite`
3. Packages binaries with `electron-builder`

Binaries are output to `packages/electron-app/release/`

## File Structure Notes

- UI components in `packages/ui/src/components/`
- Server routes in `packages/server/src/server/`
- Electron main process in `packages/electron-app/electron/main/`
- Shared types may exist in individual packages' `src/types/` directories
