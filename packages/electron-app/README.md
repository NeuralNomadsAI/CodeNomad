# CodeNomad App

This package contains the native desktop application shell for CodeNomad, built with [Electron](https://www.electronjs.org/).

## Overview

The Electron app wraps the CodeNomad UI and Server into a standalone executable. It provides deeper system integration, such as:
- Native window management
- Global keyboard shortcuts
- Application menu integration

Each channel/config profile runs one native singleton process and one backend. A second launch opens another UUID-backed window by default; Advanced settings can restore most-recent-window focus, while `--new-window` always requests another window. Stable, dev, and non-default config profiles keep native/browser/client state isolated. OpenCode sessions/messages remain shared, while tabs, drafts, and views belong to each window.

Restore state uses a V3 per-window envelope over the V2 content-addressed partition graph, with atomic publication/migration, ownership-fenced writes, and post-commit conservative garbage collection.

## Development

To run the Electron app in development mode:

```bash
npm run dev
```

This will start the renderer (UI) and the main process with hot reloading.

## Building

To build the application for your current platform:

```bash
npm run build
```

To build for specific platforms (requires appropriate build tools):

- **macOS**: `npm run build:mac`
- **Windows**: `npm run build:win`
- **Linux**: `npm run build:linux`

## Structure

- `electron/main`: Main process code (window creation, IPC).
- `electron/preload`: Preload scripts for secure bridge between main and renderer.
- `electron/resources`: Static assets like icons.
