# Era Code App

This package contains the native desktop application shell for Era Code, built with [Electron](https://www.electronjs.org/).

## Overview

The Electron app wraps the Era Code UI and Server into a standalone executable. It provides deeper system integration, such as:
- Native window management
- Global keyboard shortcuts
- Application menu integration

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
