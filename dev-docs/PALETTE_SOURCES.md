# Soft palette sources and adaptation

CodeNomad's soft collection uses its own localized names and semantic roles.
Appearance mode and the two saved palettes are independent. The picker is flat
and filters by fixed mode; Auto exposes both slots for editing. Classic retains
the dev canvas/panel/tool relationship, and all families use the muted surface
for message/tool cards with base-canvas inset output. Earlier review notes that
mention grouped palettes or panel-colored assistant cards are superseded.
These are adaptations, not exact editor-theme ports. No Zed syntax definitions,
theme loader, extension code, or complete theme JSON is shipped.

| CodeNomad family | Light ID | Dark ID | Visual reference |
| --- | --- | --- | --- |
| Mist / Brume | `porcelain` | `mist` | Zed One Light / One Dark |
| Slate / Ardoise | `dawn` | `slate` | Zed Ayu Light / Ayu Mirage |
| Clay / Argile | `parchment` | `clay` | Zed Gruvbox, soft earth-gray surfaces |
| Linen / Lin | `linen` | — | Solarized's paper/gray-green relationship |
| Iris | `iris` | — | Catppuccin Latte's lavender-gray structure |
| Sage / Sauge | `sage-light` | `sage` | Everforest Soft's gray-green structure |

The first three light IDs stay stable so saved selections and overrides remain
addressable. Existing Classic, Basalt, Fjord, Lichen, Velvet and Ember retain
their declared surface colors from `dev`. Their message surfaces are no longer
collapsed onto the composer background. Participant identity colors are shared
within each appearance, and selection uses a neutral surface tint rather than
borrowing a participant color. Custom colors are never silently recolored.

The soft light canvases are darker than the original editor whites. Dark
canvases use mid-dark grays instead of near-black. Text is adjusted for at least
4.5:1 on base, panel, tool and user-message surfaces; participant colors are
checked at full opacity for at least 3:1. Decorative resting icon opacity is
unchanged and is not claimed to meet that full-opacity contrast threshold.

## Reference revisions

- Zed One, Ayu and Gruvbox: `zed-industries/zed` commit
  `6f73c7d0a4aae8e32afb5d01b0fcb89e5e3642ff`, under `assets/themes/`.
- [Catppuccin for Zed](https://github.com/catppuccin/zed), reviewed 2026-09-08.
- [Everforest for Zed](https://github.com/albertsko/zed-everforest), reviewed 2026-09-08.
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
