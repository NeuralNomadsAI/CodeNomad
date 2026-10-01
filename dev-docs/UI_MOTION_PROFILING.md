# UI motion profiling (#804)

Connected MCP servers describe a stable state, not active work. Their status
dots stay green without pulsing. Only a pending connect/disconnect retains the
warning pulse and spinner; success and failure both stop that feedback. This is
shared UI behavior for web, Electron and Tauri.

The existing global `prefers-reduced-motion: reduce` rule limits animations to
one near-instant iteration and shortens transitions. The MCP fix does not add a
second motion policy or alter refresh/cache semantics.

## Regression and bounded profiling

```powershell
node --import tsx --test --test-concurrency=1 packages/ui/tests/browser/mcp-motion.test.ts packages/ui/tests/browser/status-panel.test.ts
node scripts/profile-ui-motion.mjs eb1bf48e
```

The optional Git revision substitutes only the historical MCP component. The
remaining source and installed frontend dependencies are identical. The script
writes Chromium traces, screenshots and `results.json` under a temporary
`opencode/issue804-motion-*` directory. No native daemon or user data is used.

Fixtures use the real StatusTab, SUID switches, full stylesheet and SessionView
with the native event dispatcher. MCP calls and session HTTP are simulated. The
session fixture seeds 620 short history messages, then samples idle, token-free
single/grouped reasoning, 24 text deltas with a 50 ms delay between deliveries,
and completion. Both motion settings use a 150% device scale.

Observed in the September 30 isolated Chromium run:

| State | Infinite animations | Layout activity in ~1.2 s sample |
| --- | --- | --- |
| Eight connected MCPs, before fix | 8 | 0 layouts (opacity animation) |
| Eight connected MCPs, after fix | 0 | 0 layouts |
| Collapsed MCP section | 0 | 0 layouts |
| Single reasoning step, no deltas | 0 | 0 layouts |
| Grouped reasoning, no deltas | 1 spinner | 0 layouts |
| Grouped reasoning, reduced motion | 0 | 0 layouts |
| Session complete | 0 | 0 layouts |

Text streaming still generates rendering work with reduced motion: 52 layouts
were recorded for 24 deliveries in both settings (~1.7 s including delivery
overhead). The mounted transcript remained at 16 rows, rather than 620. These
observations do not establish a full-transcript redraw on every animation frame.

## Limits / follow-up

This is a **headless Chromium rendering sample**, not a WebView2/NVIDIA GPU
measurement. Compositor-only animation can consume GPU without producing main
thread layout/paint counters. No GPU percentage reduction is claimed.

The session fixture omits application/sidebar chrome and does not supply the
full-history timeline RPC. Long reasoning, large tool results, remote HTTP
bursts and full-app freezes still require a representative native recording.
The generation symptom of #804 and the remote Electron freeze in #805 remain
separate, unconfirmed problems; this change must not close either as fully fixed.
