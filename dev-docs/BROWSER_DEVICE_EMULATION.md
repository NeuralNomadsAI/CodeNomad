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
viewport height. The saved visibility preference is preserved. Header filters join the other actions in the overflow
menu when space runs out. Main local and remote desktop windows can shrink to
390 logical pixels and restore at that width. Tests cover 360, 390 and 430 px widths
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
