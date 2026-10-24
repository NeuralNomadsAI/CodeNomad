# CodeNomad UI

This package contains the frontend user interface for CodeNomad, built with [SolidJS](https://www.solidjs.com/) and [Tailwind CSS](https://tailwindcss.com/).

## Overview

The UI is designed to be a high-performance, low-latency cockpit for managing OpenCode sessions. It connects to the CodeNomad server (either running locally via CLI or embedded in the Electron app).

## Features

- **SolidJS**: Fine-grained reactivity for high performance.
- **Tailwind CSS**: Utility-first styling for rapid development.
- **Vite**: Fast build tool and dev server.

## Development

To run the UI in standalone mode (connected to a running server):

```bash
npm run dev
```

This starts the Vite dev server at `http://localhost:3000`.

## Building

To build the production assets:

```
npm run build
```

The output will be generated in the `dist` directory, which is then consumed by the Server or Electron app.

## Debug Logging

The UI routes logging through a lightweight wrapper around [`debug`](https://github.com/debug-js/debug). Its namespaces can be toggled at runtime:

- `sse` – Server-sent event transport and handlers
- `api` – HTTP/API calls and workspace lifecycle
- `session` – Session/model state, prompt handling, tool calls
- `actions` – User-driven interactions in UI components
- `foreground-refresh` – Visible-state reconciliation
- `scroll` – Transcript position writes, follow-mode transitions and unclaimed (`unowned`) scrolls; see `dev-docs/SESSION_HISTORY_NAVIGATION.md`

You can enable or disable namespaces from DevTools (in dev or production builds) via the global `window.codenomadLogger` helpers:

```js
window.codenomadLogger?.listLoggerNamespaces() // => [{ name: "sse", enabled: false }, ...]
window.codenomadLogger?.enableLogger("sse") // turn on SSE logs
window.codenomadLogger?.disableLogger("sse") // turn them off again
window.codenomadLogger?.enableAllLoggers() // optional helper
```

Enabled namespaces are persisted in `localStorage` under `opencode:logger:namespaces`, so your preference survives reloads.

