# README workspace capture

`workspace-0.20.png` is a Chromium capture of the real CodeNomad project tabs,
instance shell, session tree, transcript, composer, timeline, and Status panel.
The fixture supplies synthetic project names, conversations, tool output, and
service metadata. No personal sessions or provider credentials are used.

The scene contains eight project tabs, 40 sessions (including nested agent
sessions), and a selected conversation with 244 native history records across
61 exchanges. Transcript reads are paginated; the timeline uses the complete
structural outline. The capture shows the latest exchange in that longer task.

Regenerate from the repository root after installing workspace dependencies:

```sh
npx playwright install chromium
node packages/ui/scripts/capture-readme.mjs
```

`CODENOMAD_BROWSER_PATH` can select an existing Chromium executable. The script
uses a fresh browser context, an isolated loopback Vite server, a 1600×900 viewport,
the dark palette, English labels, and UTC timestamps. API responses are fixtures;
external requests are blocked. It does not connect to a CodeNomad backend or an
OpenCode daemon. It verifies the rendered conversation, connected state,
agent control, eight project tabs, populated session list, long timeline and MCP
row, then checks for uncaught renderer errors before saving.

The shell-only scene applies the page-level keyboard-hint preference normally
set by `App.tsx`. The capture verifies that shortcut hints are hidden, matching
the default application setting.

The scene is maintained in
`packages/ui/tests/browser/fixtures/readme-workspace.tsx`, with the longer history
and session/project names in the adjacent `readme-workspace-data.ts`. Update this
data when refreshing documentation; keep product layout and styling in the real
components.
