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

# Help home tour

The help home page's `{{tour-video}}` block uses two files from the CodeNomad 1.0
tour (https://youtu.be/IGuOApJ6-Kc), cut from its raw screen recordings of the
1.0 demo projects without the film's caption overlays and title cards.

`codenomad-tour.mp4` (46.2 s, 1280x720, 30 fps, H.264 High yuv420p, no audio
track, `+faststart`, about 2.7 MB) joins six scenes with 0.4 s crossfades and a
0.3 s fade from and to black at the loop point. Times are in each source recording:

- a Mission in `orbit-api` (16.8 s), from the first coordinator steps after the
  empty conversation screen: planning and parallel subagents (8.5-189 s at 36x), a
  subagent's tool output (226-238 s at 4.8x), the added "Fix native TypeScript runtime
  compatibility" task (250-276 s at 8x), the reports (276-403 s at 50x) and the
  overview (415-418.5 s at 1x). The skipped 189-226 s holds a provider error
  notification (about 190-196 s);
- the **Compare two models** mission in `tinyqueue` (6.7 s): its overview (2-4.6 s)
  and the blind judge's verdict and scores by criterion (10.9-15.4 s at 1.1x). The
  evidence line showing a local temporary path is box-blurred, and the segment ends
  before the panel scrolls to the criterion notes that repeat that path;
- **Files → Changes** and a split diff in `orbit-api` (3-14 s at 1.6x, 6.9 s);
- an **Entire workspace** history search in `trailcast` that opens an earlier message
  (2-15.6 s at 2x, 6.8 s);
- project tabs and session families in the session list (1-11 s at 2x, 5 s);
- the palette montage (0.5-9.5 s at 1.5x, 6 s), blended over 9 frames so each
  palette switch becomes a short fade.

Frame-to-frame mean luma changes stay under 5 of 255 (no flashes), and no frame shows
the red error notification. Encode with
`libx264 -preset veryslow -crf 21 -profile:v high -pix_fmt yuv420p -an -movflags +faststart`.

`codenomad-tour-poster.jpg` (1280x720, about 105 KB) is the v1.0.0 release board
`codenomad-1.0-showcase.png` (2400x1450). The local temporary path in the Compare
window's evidence list (lower right) is box-blurred, the bottom 100 px are cropped
to 16:9 and the result is scaled with Lanczos and saved as baseline JPEG
(`ffmpeg -q:v 5`).

Keep the clip at 40-50 s and at most 3.5 MB and the poster at most 200 KB; `scripts/test-help.mjs`
checks size, duration, dimensions, codec, the absent audio track and the faststart layout.
