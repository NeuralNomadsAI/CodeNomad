# Saved palette calibration — 2026-09-11

The user requested that built-in defaults reproduce their saved palette edits.
The 14 built-in overrides were read from the active profile before removing the
unrelated legacy Custom entry and the named “Iris 2” experiment from that profile.
Iris uses its saved built-in override, not the Iris 2 experiment. Stable palette
IDs, appearance slots and the other named presets remain supported.

## Changed defaults

| Palette ID | Saved changes |
| --- | --- |
| classic | accentPrimary `#4D7AFE` |
| mist | accentPrimary `#D0ED9C`, statusSuccess `#81C1A8` |
| slate | textMuted `#9DB5D2` |
| clay | surfaceSecondary `#41403E`, surfaceMuted `#55524E`, accentPrimary `#87BC5C`, statusSuccess `#B9BF69`, compactionAccent `#AA91FD` |
| sage | statusSuccess `#81C182` |
| fjord | statusSuccess `#8FC473` |
| ember | accentPrimary `#D99254` |
| porcelain | compactionAccent `#A07AFF` |
| dawn | accentPrimary `#7F69E2` |
| parchment | accentPrimary `#A9BA45` |
| linen | accentPrimary `#9D8325`, statusSuccess `#699245` |
| iris | accentPrimary `#6B7CFF` |
| sage-light | accentPrimary `#6C7FCB` |
| basalt | userAccent `#88EEFB` |

Other saved fields are retained exactly, including the historical `yoloAccent`
field; rendered YOLO already follows `accentPrimary`.

## Quality baseline

These are exact saved choices, not contrast-corrected approximations. The strict
`validateColorSchemeColors` helper is unchanged. Its expected exceptions are
Porcelain, Dawn, Slate, Parchment, Clay, Linen, Iris and Sage Light. Primary text
still meets 4.5:1 on all message/tool surfaces. The targeted quality checks bound
Slate secondary text at 3.99:1, Clay secondary text at 4.02:1 and Porcelain's
compaction accent at 1.72:1; other identity colors retain the 3:1 check. The saved
Clay/Sage surface distance is 2.24 OKLab units (bounded at 2.2 rather than 2.5).

## Settings layout

Language comes first. A single Auto/Dark/Light control sets appearance; Auto's
palette picker follows the resolved system appearance and retains both saved
selections. A dirty draft stays on its original appearance until saved/discarded.
The palette picker and actions form one column beside a 7-column, two-row swatch
grid. Color wells are half their former height (1.375rem); labels remain clickable.
The layout stacks according to available card width rather than window width.

## Validation and gatekeeper review

- UI typecheck and production build passed.
- 60 palette/theme tests passed. Emphasis exceptions are scoped to exact
  palette/field/foreground/background tuples; all other emphasis pairs keep 3:1.
- Both appearance browser tests passed, covering Auto/system changes, persistence
  and the 17-palette local-hover matrix.
- All five tab browser tests passed, including isolated Electron native zoom.
- 24 layout combinations passed: English/French/Hebrew, 320/375/640/1100px,
  light/dark. Two swatch rows, 22px wells and no horizontal overflow.
- The active Tauri profile was checked after restart: both unwanted entries are
  absent, Auto has one mode selector, and the light/dark selections are retained.
- Gatekeeper round 1 found a test-protection regression: palette-wide contrast
  exemptions could hide an unrelated status-color regression. Fixed with exact
  pair exemptions and checks for all eight emphasis fields.
- Gatekeeper round 2: **PASS, no actionable findings**. Its in-memory mutation of
  Slate's error color to its base surface now fails the expected 1:1 contrast check.
