# Soft palette sources and adaptation

CodeNomad's soft collection adapts the referenced editor themes' surface
relationships under its own localized names and semantic roles; it ships only
CodeNomad color values in `soft-color-schemes.ts`. The picker is flat and
filters by fixed mode; Auto exposes both slots for editing.

| CodeNomad family | Light ID | Dark ID | Visual reference |
| --- | --- | --- | --- |
| Mist / Brume | `porcelain` | `mist` | Zed One Light / One Dark |
| Slate / Ardoise | `dawn` | `slate` | Zed Ayu Light / Ayu Mirage |
| Clay / Argile | `parchment` | `clay` | Zed Gruvbox, soft earth-gray surfaces |
| Linen / Lin | `linen` | — | Solarized's paper/gray-green relationship |
| Iris | `iris` | — | Catppuccin Latte's lavender-gray structure |
| Sage / Sauge | `sage-light` | `sage` | Everforest Soft's gray-green structure |

The first three light IDs stay stable so saved selections and overrides remain
addressable. Classic (with its canvas/panel/tool relationship), Basalt, Fjord,
Lichen, Velvet and Ember use their declared surface colors in normal contrast.
Saved palette values and editable swatches remain the source of every rendering;
high contrast adapts a rendering copy, independently of palette-color saving.

Every built-in palette places Base closer to its appearance's extreme than
Secondary: the light input field is brighter than its panels, and the dark
input field is darker.

The soft light canvases are darker than the original editor whites. Dark
canvases use mid-dark grays instead of near-black. `palette-quality.test.ts`
checks text at 4.5:1 on base, panel, muted, user-message and assistant/tool
surfaces, with exact `textMuted` exceptions: Slate `#9DB5D2` on `#404E65`
uses 3.99:1; Clay `#C6B9A5` on `#55524E` uses 4.02:1. Participant colors
use 3:1, except Porcelain `compactionAccent` `#A07AFF` on `#CFD1D4`,
`#E1E3E5`, `#BDC1C6` or `#C5CBD0`, which uses 1.72:1.

The 3:1 emphasis check on base/panel surfaces exempts these exact pairs:

- Porcelain `compactionAccent` `#A07AFF` on `#CFD1D4` / `#E1E3E5`.
- Dawn `accentPrimary` `#7F69E2` on `#BCD2E5`.
- Parchment `accentPrimary` `#A9BA45` on `#D5C09E` / `#E2CEB0`.
- Linen `accentPrimary` `#9D8325` and `statusSuccess` `#699245` on `#E6E0CE`.
- Iris `accentPrimary` `#6B7CFF` on `#E0D4E5` / `#EDDFEF`.
- Sage Light `accentPrimary` `#6C7FCB` on `#CBD8C1` / `#DCE6D2`.

These thresholds apply at full opacity in normal contrast; decorative resting
icons keep their partial opacity.

High contrast copies the palette inputs and moves only `surfaceBase` and
`surfaceSecondary` toward black in dark appearance and white in light appearance,
using OKLCH lightness in `lib/high-contrast.ts`. Base moves by a fraction of its
distance to the extreme, set by the central
`HIGH_CONTRAST_SURFACE_STRENGTH = { dark: 0.2, light: 0.8 }`.
Secondary moves in the same direction by half Base's absolute lightness change,
set by `HIGH_CONTRAST_SECONDARY_DELTA_RATIO = 0.5` and clamped to the 0–1 range.
This expands the Base/Secondary gap in both appearances. Classic Light's
already-white Base leaves both inputs unchanged.
Built-in palettes, embedded overrides and custom palettes
share this path. `surfaceMuted` and every other input retain their saved values.
Normal token derivation, including Classic adaptations, then calculates the
surface roles. Field uses Base; canvas, overlay and inset share the existing
25% Secondary / 75% Base OKLab mix. Control uses its existing 72% Secondary mix.
Foregrounds then move minimally in OKLCH lightness toward the central 7.5:1 text /
3.5:1 primary-boundary targets. Lighter borders preserve their normal relative
contrast excess (contrast ratio minus 1) on Secondary: muted stays below secondary,
secondary below base, and strong above base. Equal source colors use the semantic
72% / 50% secondary/muted weights. Fine row separators retain their 78% paint weight;
group dividers retain their stronger 82% border / 18% text mix. Focus retains its
existing color and geometry. Hue stays fixed, with source chroma reduced only as needed
to fit sRGB; byte-quantized colored text stays within 12° of its source hue on the
built-in palettes. State tints preserve the existing worst surface's ink headroom.
Accent and filled danger colors retain their source hues and values;
their paired text uses white below OKLab L 0.68 and black otherwise. Disabling
contrast restores normal rendering exactly. `palette-quality.test.ts` covers
all 17 rendering palettes, including the 7:1 text / 3:1 primary-boundary floors
and strict lighter-border ordering. Secondary non-text roles retain their hierarchy
and can remain below 3:1. The shared `--contrast-opacity-*` ladder in
`components/high-contrast.css` increases deliberately dimmed text groups and
resting/disabled icons through the same ordered levels:
25% → 45%, 30% → 50%, 35% → 60%, 40% → 65%, 45% → 70%, 50% → 72%,
55% → 78%, 60% → 82%, 65% → 85%, 70% → 87%, 72% → 88%, 75% → 90%, 80% → 94%.
Git counters, secondary headings, empty states and disabled controls retain their
partial opacity and visual hierarchy. Their composed text is more readable than
in normal mode; the 7:1 text floor applies to text without deliberate dimming.
Hover-revealed containers and zero-opacity content retain their visibility rules.
Unchanged bright Muted surfaces in dark palettes constrain colored text to pale
tints at these targets. Opposing or intermediate custom surfaces can make the
targets unattainable; their surfaces stay faithful to the input rule and the
foreground adjustment chooses the strongest attainable endpoint.

## Source references

- Zed One, Ayu and Gruvbox: `zed-industries/zed` commit
  `6f73c7d0a4aae8e32afb5d01b0fcb89e5e3642ff`, under `assets/themes/`.
- [Catppuccin for Zed](https://github.com/catppuccin/zed).
- [Everforest for Zed](https://github.com/albertsko/zed-everforest).
- [Original Solarized](https://github.com/altercation/solarized), MIT licensed.
  The GPL Zed Solarized extension was inspected as a visual reference only;
  none of its code, JSON or color values is included in Linen's definition.

## Theme attribution and MIT notices

The following MIT-licensed references informed the adaptation. Copyright
notices are retained here; the common permission and warranty text below
applies to each reference independently.

- One: Copyright (c) 2014 GitHub Inc.
- Ayu: Copyright (c) 2016 Ike Ku
- Catppuccin: Copyright (c) 2021 Catppuccin
- Everforest Zed port: Copyright (c) 2025 Albert Skonieczny
- Solarized: Copyright (c) 2011 Ethan Schoonover
- Zed's Gruvbox `LICENSE` contains the literal placeholder notice:
  `Copyright (c) <YEAR> <COPYRIGHT HOLDER>`.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Agent conventions

- Soft palette families live in `packages/ui/src/lib/soft-color-schemes.ts`. Participant identity colors are shared within each appearance; selection uses a neutral surface tint, never a participant color; transcript/composer surfaces stay distinct. Run `palette-quality.test.ts` and inspect real rendered captures when changing palette colors or their token mapping.
- Filled accent text uses white when the final fill's OKLab lightness L is below `TEXT_ON_COLOR_LIGHTNESS_THRESHOLD = 0.68`, black otherwise (`lib/color-contrast.ts`), in both contrast modes. Custom fills and filled danger actions use the same rule. `palette-quality.test.ts` lists measured lightness and WCAG 2 ratios for all 17 built-in accents and their hovers, checks the chosen ink and enforces a ≥ 3:1 guardrail in normal/high contrast and Auto appearance. Pair `--accent-primary` with `--text-on-accent` and `--accent-hover` with `--text-on-accent-hover`. The `--accent-hover-text` role is colored foreground on a reading surface. High-contrast text without deliberate dimming keeps its WCAG 2 ≥ 7:1 criterion; dimmed groups keep their opacity hierarchy and improve on normal contrast. Primary boundaries keep ≥ 3:1 while secondary non-text roles preserve their lighter hierarchy.
- Palette settings follow the resolved appearance in Auto mode. Keep the picker, square swatches and trailing actions on one line while they fit at their natural width, measured by `settings/palette-strip-fit.ts` rather than a breakpoint because the actions change with edits; otherwise the swatch strip moves below the picker and its actions (`data-stacked`) and wraps onto further lines instead of scrolling. Swatch names use tooltips and accessible input labels. Swatch styles live in `styles/components/theme-scheme-swatches.css`.
