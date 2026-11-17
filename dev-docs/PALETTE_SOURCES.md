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
Lichen, Velvet and Ember keep their declared surface colors. Custom colors are
never silently recolored.

The soft light canvases are darker than the original editor whites. Dark
canvases use mid-dark grays instead of near-black. `palette-quality.test.ts`
checks text at 4.5:1 on base, panel, muted, user-message and assistant/tool
surfaces, with exact `textMuted` exceptions: Slate `#9DB5D2` on `#404E65`
uses 3.99:1; Clay `#C6B9A5` on `#55524E` uses 4.02:1. Participant colors
use 3:1, except Porcelain `compactionAccent` `#A07AFF` on `#CFD1D4`,
`#E1E3E5`, `#BDC1C6` or `#D6DCE0`, which uses 1.72:1.

The 3:1 emphasis check on base/panel surfaces exempts these exact pairs:

- Porcelain `compactionAccent` `#A07AFF` on `#CFD1D4` / `#E1E3E5`.
- Dawn `accentPrimary` `#7F69E2` on `#BCD2E5`.
- Parchment `accentPrimary` `#A9BA45` on `#D5C09E` / `#E2CEB0`.
- Linen `accentPrimary` `#9D8325` and `statusSuccess` `#699245` on `#E6E0CE`.
- Iris `accentPrimary` `#6B7CFF` on `#E0D4E5` / `#EDDFEF`.
- Sage Light `accentPrimary` `#6C7FCB` on `#CBD8C1` / `#DCE6D2`.

These thresholds apply at full opacity; decorative resting icons keep their
partial opacity.

## Reference revisions

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
- Palette settings follow the resolved appearance in Auto mode. Keep the picker, square swatches and trailing actions on one line while they fit at their natural width, measured by `settings/palette-strip-fit.ts` rather than a breakpoint because the actions change with edits; otherwise the swatch strip moves below the picker and its actions (`data-stacked`) and wraps onto further lines instead of scrolling. Swatch names use tooltips and accessible input labels. Swatch styles live in `styles/components/theme-scheme-swatches.css`.
