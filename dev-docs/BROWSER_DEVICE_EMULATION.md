# Browser preview device emulation

The viewport menu has exactly six fixed templates: responsive,
desktop 1440 × 900, tablet 768 × 1024, tablet landscape 1024 × 768,
mobile 390 × 844 and mobile landscape 844 × 390 CSS px; landscape templates
stand in for rotation, so never add a separate rotation button. Electron and Windows Tauri mobile templates automatically apply
Android / Chromium touch, mobile identity and density settings.
Device profiles set CSS viewport, screen orientation, DPR 2.75, touch media and
events, Android user agent and mobile client hints. Switching between profiles
reloads the preview because applications can cache device detection at startup.
Returning to any dimension preset clears all overrides and reloads again.

Electron and Windows Tauri apply overrides to the owned native preview only.
Tauri macOS (WKWebView) and Linux (WebKitGTK) apply all six CSS viewports with native
view geometry and per-view page zoom. Mobile presets use a generic WebKit mobile
user agent, identical in HTTP and `navigator.userAgent`; dimension presets restore
the desktop identity. Profile/template changes and desktop reset reload the guest;
an identical request is a no-op. The sandboxed iframe fallback changes dimensions
only. Translated tooltips distinguish Chromium emulation, native WebKit profiles
and dimensions-only previews. Native display, history, device emulation and agent
automation are separate host capabilities; WebKit previews support manual browsing, while agent browser
automation requires Electron or Tauri Windows. Never expose application
privileges or a general CDP bridge to preview pages. Tauri's synchronous WebView2
callbacks are awaited off the UI thread. Electron retains its debugger attachment
while emulation is active so the overrides survive accessibility automation.

Canonical profile data lives in `packages/ui/src/lib/native/browser-emulation.json`.
Chromium adapters use the installed Chromium version for the simulated user agent.
WebKit uses `Mozilla/5.0 (Mobile) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile Safari/605.1.15`.
These generic profiles provide engine-specific layout references; mobile OS text
settings, keyboard occlusion and browser/system bars are outside their scope.

## Native WebKit profile contract

The UI sends clipped application-CSS bounds with `presentation.css: true` and an
optional fixed `presentation.viewport`; emulation commands carry the same optional
`viewport`. The native host reads primary-renderer page zoom and monitor scale on
the UI thread. It fits the child into that physical canvas and finds integer native
logical dimensions with a common zoom interval yielding the requested integer CSS
width/height on both engines. Responsive uses the available CSS canvas. This keeps
effective viewport dimensions stable across app zoom and monitor DPI, including
clipped/narrow canvases. Pointer positions and wheel deltas scale through guest zoom.

Profile and canvas state belong to the registration. Replacement, unregister and
primary-renderer cleanup clear them; other previews and the application renderer
retain their own UA, scale and input. Commands serialize off the UI thread, revoke
page leases before native changes, fence publication against registration changes
and restore the preceding native configuration on application failure. Dimension
resizes retain the document; profile/template changes reload after native application.

| Property | Chromium mobile | WKWebView | WebKitGTK |
| --- | --- | --- | --- |
| Portrait / landscape CSS viewport | 390 × 844 / 844 × 390 | Same | Same |
| HTTP / JS mobile identity | Android Chromium | Matching generic WebKit | Matching generic WebKit |
| DPR | 2.75 | 2.75 with runtime-checked `_setOverrideDeviceScaleFactor:`; native density if absent | Monitor scale × fitted page zoom |
| Screen / screen orientation | Profile dimensions, portrait-primary/0 or landscape-primary/90 | Native desktop screen/orientation | Native desktop screen; screen.orientation availability follows engine |
| CSS orientation | Viewport | Viewport | Viewport |
| pointer / hover media | coarse / none | Native fine / hover on mouse-equipped desktop | Native fine / hover on mouse-equipped desktop |
| maxTouchPoints | 5 | Native 0 on desktop | Native 0 on mouse-only desktop |
| Input | Native touch from mouse | Native mouse | Per-view GTK left-pointer → native GDK touch, with native compatibility mouse/click events |
| Platform / mobile client hints | Linux armv8l / Android | Native desktop platform / engine hints | Native desktop platform / engine hints |

WKWebView's density selector is optional private SPI and checked before invocation;
core viewport/UA behavior uses public native APIs. Reset clears its override to zero.
GTK's page zoom changes DPR and viewport together; fixing DPR 2.75 would violate
the fitted viewport contract. Pointer/hover media, touch constructors/handlers,
maximum contacts and screen metadata retain engine values. Never shim JS getters.
GTK mouse-to-touch handlers are view-owned, pass native compatibility events through,
and cancel active sequences on profile changes. macOS desktop WebKit keeps mouse input.

Qualify with the shared `tests/browser-parent/mobile.html` reporting fixture via
`mobile-fixture.ts` and `test-browser-parent-webkit.py` on macOS, GTK X11 and Wayland;
repeat with `GDK_SCALE=2` and renderer zoom 1.5. `mobile-trial.ts` isolates density,
page zoom, layout SPI and GDK touch probes. Run `node --import tsx
scripts/compare-webkit-mobile.ts <artifact-directory>` for the production Chromium
profile adapter against the same reporting page. The native harness asserts six
viewports, HTTP/JS UA, reload/no-op/reset, invalid-profile refusal, trusted input,
resize/replacement lifetime and isolation; detailed measurements belong in artifacts.

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
