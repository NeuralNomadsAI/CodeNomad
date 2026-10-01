# Browser preview device emulation

The viewport menu retains its original six fixed templates: responsive,
desktop 1440 × 900, tablet 768 × 1024, tablet landscape 1024 × 768,
mobile 390 × 844 and mobile landscape 844 × 390 CSS px. There is no separate
rotation button or size catalogue. Native mobile templates automatically apply
Android / Chromium touch, mobile identity and density settings.
Device profiles set CSS viewport, screen orientation, DPR 2.75, touch media and
events, Android user agent and mobile client hints. Switching between profiles
reloads the preview because applications can cache device detection at startup.
Returning to any dimension preset clears all overrides and reloads again.

Electron and Windows Tauri apply overrides to the owned native preview only.
The sandboxed iframe fallback changes dimensions only, with a translated
tooltip explaining that emulation requires the native app. Neither application privileges nor a
general CDP bridge are exposed to preview pages. Tauri's synchronous WebView2
callbacks are awaited off the UI thread. Electron retains its debugger attachment
while emulation is active so accessibility automation does not reset overrides.

Canonical profile data lives in `packages/ui/src/lib/native/browser-emulation.json`.
Native adapters use the installed Chromium version for the simulated user agent.
These generic profiles do not emulate Gecko/Waterfox, Safari, mobile OS text settings,
keyboard occlusion or browser/system bars. They are a reproducible Android/Chromium
layout reference, not a pixel-identical representation of every phone.

The composer keeps selectors and actions on one row at every width, truncating
labels rather than wrapping. Dense toolbar/footer touch targets use 32 px; timeline
markers use 24 px height. Below 460 CSS px of conversation width, the worktree
selector becomes a 32 px arrow-only cell while retaining its accessible label.
The timeline is hidden below 420 CSS px of conversation
width on every platform, independently of header density, status controls or
viewport height. The saved visibility preference is preserved. Conversation-header
actions, including filters, are forced into the overflow menu at the same 420 px
breakpoint, or earlier if their measured layout needs it. Docked side panels reserve
390 CSS px for the conversation before becoming overlays.

Main local and remote desktop windows use a 390 × 600 CSS px content minimum.
Native logical minimums scale with application zoom (312 px wide at 80%, 390 at
100%, 488 at 125%, 585 at 150%), without multiplying monitor DPI twice. Restoring
a local window uses its saved zoom, including widths below 390 native logical px.
Electron seeds those constraints before the first navigation rather than reading
the renderer's transient 100% zoom. Local windows retain their shared authentication
session: host-scoped zoom reconciles each affected window's minimum and saved zoom,
including subsequent reloads. Remote session partitions remain independent.
Zooming in grows an undersized normal window; zooming out relaxes constraints but
does not shrink a larger window. Extreme zoom minimums are capped to the monitor's
work area. Preferences and browser preview guests keep their separate dimensions.
Tauri defers native minimum setters while maximized, fullscreen or minimized to
preserve window state and normal placement. A per-window registration coalesces
move/resize/DPI updates off native callbacks, with a 500 ms read-only environment
fallback for state/work-area changes missing from the pinned runtime's events.
Unchanged minimums perform no native writes; comparisons use physical pixels to
avoid resize loops at fractional DPI. Restore positioning precedes registration.
The isolated Windows regression runs with `cargo run --locked --example
window_constraints_windows` from `packages/tauri-app/src-tauri`; `-- --baseline`
demonstrates the original unmaximize bug. It uses temporary WebView2 profiles and
no backend or shared daemon. Multi-monitor/DPI calculations also have Rust tests;
the native run only covers monitors actually attached to the test host.
Tests cover 360, 390 and 430 px widths
plus 320 px, landscape, mouse/touch media, draft preservation, native profile/reset
behavior and the real viewport menu's native/fallback boundaries.

Composer sizing also follows the visible conversation height (including the
visual viewport when a software keyboard opens). The minimum is 8% of that
height, with a 44 px floor. Width and draft length do not change the limits.
Long drafts scroll inside the field. Manual sizing is saved as a proportion
of the available height, bounded to 8–60%: the field itself scales when the
window or visual viewport changes. The 44 px floor never overwrites that
proportion. Legacy pixel heights convert on the first valid measurement.
Pointer and keyboard
resizing share the same minimum and maximum.
