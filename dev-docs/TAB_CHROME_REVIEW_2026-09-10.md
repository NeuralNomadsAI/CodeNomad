# Tab chrome and zoom review — 2026-09-10

## Cause and correction

Project and right-panel tab strips overrode the shared thin scrollbar with
`scrollbar-width: auto` and forced `scrollbar-color: auto`. Two `scaleY(-1)`
transforms moved that scrollbar to the top and restored the text orientation.
Negative margins, extra one-pixel heights and active-tab cover pseudo-elements
then attempted to reconnect the strip to its panel. These independently rounded
and composited layers made fractional zoom fragile.

Both strips now use `components/tab-scroll.tsx`. A native scrollbar above the
upright tab viewport inherits the common scrollbar style. Scroll offsets are
synchronized in both directions, including negative RTL offsets. ResizeObserver
updates the scrollbar extent as tabs or the available width change. The viewport
retains native wheel/touch and focus scrolling; no custom thumb is painted.

Borders no longer overlap with negative margins or extend via an extra
active-tab pseudo-element. Each adjoining edge has one owner. The strip baseline
is painted on its container and the active tab covers it in normal layout.
Permanent `will-change: transform` is removed; actual drag transforms remain.

## Validation

- Real `InstanceTabs`, `InstanceTab`, and `RightPanel` in deterministic browser
  fixtures; no calls to a user's backend from these fixtures.
- Edge: 80/90/100/110/125/150% CSS zoom, DPR 1/1.25/1.5/2, LTR and RTL.
- Electron 39: real isolated BrowserWindow using native
  `webContents.setZoomFactor`, the same zoom range, LTR/RTL, Classic dark/light.
- Tauri: separate copy of the existing release executable/resources, a new
  configuration profile, and the rebuilt UI. Native WebView2 zoom via
  `plugin:webview|set_webview_zoom`, the same zoom range, LTR/RTL: 12 cases passed.
  No existing CodeNomad process or shared OpenCode daemon was stopped/restarted.
- Assert adjoining tab edges, baseline alignment, shared scrollbar style,
  scroll-range parity, synchronization, no overflow for a short tab list,
  native wheel and keyboard selection/reveal, and resize behavior.
- Full browser suite: 29 tests passed before adding the final sidecar,
  pointer-reorder and touch cases. UI and Electron typechecks and UI build passed.
- Final focused suite: all 5 tests passed, including sidecar selection, native
  pointer reordering and touch layout. The matrix includes 48 zoom/DPI/direction
  cases in Edge and 24 native zoom/palette/direction cases in Electron.

Local screenshots are in `%LOCALAPPDATA%/Temp/opencode/pr667-tab-zoom/`, including
native Tauri images and `tauri-native-report.json`. Browser/Electron fixtures
close only their own test windows. The isolated Tauri test host is left open.

Optional Electron run:

```powershell
$env:CODENOMAD_TEST_ELECTRON = "$PWD/node_modules/electron/dist/electron.exe"
$env:CODENOMAD_BROWSER_PATH = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node --import tsx --test packages/ui/tests/browser/tab-chrome.test.ts
```

`CODENOMAD_TAB_SCREENSHOTS` optionally saves the capture matrix.
`CODENOMAD_TEST_TEMP` optionally selects the Electron test-profile parent.

## Follow-up: phantom overflow at fractional zoom

The first implementation copied integer `scrollWidth` into the scrollbar extent.
At fractional zoom that could make a fitting lane fractionally wider than its
viewport. A fitting extent now remains `100%` wide with horizontal overflow
hidden; genuinely overflowing content keeps its computed fractional CSS width.
The fitting-tab assertion now runs at every zoom/DPI/direction/palette combination
in Edge and Electron, not just at the end of each series. All five focused tests,
UI typecheck and production build passed again. The earlier Tauri test host was
already closed, so its previous native capture matrix does not validate this
follow-up; no user window was reloaded for that check.
