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

## Agent memory preferences

General embeds `components/settings/agent-memory-settings-card.tsx`, using the
server-confirmed `/api/memory/settings` preference and the dedicated
`lib/agent-memory-api.ts` adapter. Project reads use the exact resolved Preferences
context, including its native directory. `stores/agent-memory.ts` fences late
responses and keeps dirty drafts attached to their original context through
project replacement, deletion and the shared Settings discard guard.

UI list responses supply `scopeKey` and `observedAt`. Per-scope consultation
frontiers live in browser storage; each visit freezes its baseline and advances
the stored frontier only after successful reads. The server derives project keys
so linked worktrees share badge state. Reviewable flagged entries carry an
explanation behind an info tip. Explicit revision conflicts retain the draft and
require a confirmed reload. Browser coverage lives in
`tests/browser/agent-memory.test.ts`.

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

