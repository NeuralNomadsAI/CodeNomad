# Browser preview device emulation

The viewport menu has exactly six fixed templates: responsive,
desktop 1440 × 900, tablet 768 × 1024, tablet landscape 1024 × 768,
mobile 390 × 844 and mobile landscape 844 × 390 CSS px; landscape templates
stand in for rotation, so never add a separate rotation button. Native mobile templates automatically apply
Android / Chromium touch, mobile identity and density settings.
Device profiles set CSS viewport, screen orientation, DPR 2.75, touch media and
events, Android user agent and mobile client hints. Switching between profiles
reloads the preview because applications can cache device detection at startup.
Returning to any dimension preset clears all overrides and reloads again.

Electron and Windows Tauri apply overrides to the owned native preview only.
The sandboxed iframe fallback changes dimensions only, with a translated
tooltip explaining that emulation requires the native app. Never expose application
privileges or a general CDP bridge to preview pages. Tauri's synchronous WebView2
callbacks are awaited off the UI thread. Electron retains its debugger attachment
while emulation is active so the overrides survive accessibility automation.

Canonical profile data lives in `packages/ui/src/lib/native/browser-emulation.json`.
Native adapters use the installed Chromium version for the simulated user agent.
These generic profiles are a reproducible Android/Chromium layout reference;
Gecko/Waterfox, Safari, mobile OS text settings, keyboard occlusion and
browser/system bars are outside their scope.

Main local and remote desktop windows use a 390 × 600 CSS px content minimum.
Native logical minimums scale with application zoom (312 px wide at 80%, 390 at
100%, 488 at 125%, 585 at 150%), without multiplying monitor DPI twice. Restoring
a local window uses its saved zoom, including widths below 390 native logical px.
Electron seeds those constraints before the first navigation rather than reading
the renderer's transient 100% zoom. Local windows retain their shared authentication
session: host-scoped zoom reconciles each affected window's minimum and saved zoom,
including subsequent reloads. Remote session partitions are independent.
Zooming in grows an undersized normal window; zooming out relaxes constraints and
keeps a larger window's size. Extreme zoom minimums are capped to the monitor's
work area. Preferences and browser preview guests keep their separate dimensions.
Electron handles outer-frame offsets in `window-state.ts`, Tauri in
`window_constraints.rs`; native logical dimensions round up.
Tauri defers native minimum setters while maximized, fullscreen or minimized to
preserve window state and normal placement. A per-window registration coalesces
move/resize/DPI updates off native callbacks, with a 500 ms read-only environment
fallback for state/work-area changes missing from the pinned runtime's events.
Unchanged minimums perform no native writes; comparisons use physical pixels to
avoid resize loops at fractional DPI. Restore positioning precedes registration.
The isolated Windows regression runs with `cargo run --locked --example
window_constraints_windows` from `packages/tauri-app/src-tauri`; `-- --baseline`
runs the unmaximize negative control. It uses temporary WebView2 profiles and
no backend or shared daemon. Multi-monitor/DPI calculations also have Rust tests;
the native run only covers monitors actually attached to the test host.
On macOS/Linux, `window_zoom.js` routes keyboard and Ctrl-wheel input through the
relative-only `owned_webview_zoom` command rather than Tauri's generic zoom command.
The host validates the registered primary webview and its origin, then updates
native zoom, bookkeeping and constraints together. Windows keeps native input.
Never give preview children this input script or application capability
authority. The shipped and pinned-runtime scripts are exercised by
`node --test packages/tauri-app/tests/window-zoom-script.test.mjs` after Cargo has
downloaded the locked Tauri source; CI runs this on all three desktop platforms.
Tests cover 360, 390 and 430 px widths
plus 320 px, landscape, mouse/touch media, draft preservation, native profile/reset
behavior and the real viewport menu's native/fallback boundaries.
