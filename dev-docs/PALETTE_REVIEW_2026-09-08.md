# Palette review — 2026-09-08

## Scope and evidence

- Compare `feat/ui-harmonization` at `b11e85c0` with fetched `origin/dev` at `e5115fe8`.
- Review definitions, derived CSS tokens, palette persistence, editor behavior and tests.
- Read the isolated validation profile without changing its palette or preferences.
- `D:\zed` is absent on this machine. Zed preferences are in `%APPDATA%/Zed/settings.json` and select **Ayu Light** / **One Dark**. No theme JSON files were found in the local installation or installed extensions.
- Reference the official Zed theme JSON at commit `6f73c7d0a4aae8e32afb5d01b0fcb89e5e3642ff`, rather than claiming it is the exact installed binary revision.
- Additional light-theme references are Zed extensions linked from the official extension registry.
- This is an audit and proposed correction plan: no palette definitions or user settings were changed during the review.

## Findings

### 0. Flattened dark surface hierarchy — high priority

The review must not reduce the dark-theme regression to accent collisions or similarity between palette swatches. Comparing the actual CSS consumers with `origin/dev` confirms a separate rendering regression:

- In `dev`, `--message-assistant-bg` resolves through `--message-tool-bg` (the dark CSS default is `#212529`). The UI branch replaces it with `surfaceBase`, both in static tokens and in generated palette properties.
- `.message-item-base` and multiple assistant/reasoning/tool surfaces consume `--message-assistant-bg`. The prompt wrapper and input consume `--surface-base`. They now receive exactly the same background, where `dev` distinguished them. This is a direct cause of darker, flattened message surfaces.
- The user-message background lost its role tint: `mix(userAccent, surfaceSecondary, …)` became plain `surfaceSecondary`.
- Tool surfaces now use a generated mix of `surfaceMuted` and `surfaceBase`, while sidebar controls moved from `surfaceSecondary` to a blend towards `surfaceBase`. These changes also need comparison on the rendered application, not independent approval based on their formulas.
- The three declared surface colors of the inherited Basalt, Fjord, Lichen, Velvet and Ember palettes were not changed by this branch. Their appearance nevertheless changed because the mapping of colors to UI regions changed. Unchanged hex values do **not** demonstrate preserved palette behavior.

**Correction priority:** use `dev` as the baseline for the inherited dark palettes and restore readable separation of conversation, composer, panels and nested blocks. Preserve the user's validated geometry and quiet chrome. Zed references should inform the mapping, not justify replacing established dark palettes or making every surface equally dark. Validate both differentiation *within* each palette and differentiation *between* palettes with matching real screenshots before claiming a fix.

### 1. Introduced semantic collisions — high priority

`packages/ui/src/lib/theme-scheme.ts` now assigns the same color to distinct roles:

| Palette | Colliding roles | Value |
| --- | --- | --- |
| Fjord | user / primary accent / Yolo | `#67C9BA` |
| Lichen | user / primary accent / Yolo | `#A9C47F` |
| Velvet | agent / primary accent / Yolo | `#E5A77D` |
| Ember | user / primary accent / Yolo | `#D79A66` |
| Dawn (new) | user / primary accent / Yolo | `#287DB5` |
| Parchment (new) | user / primary accent / Yolo | `#0B6678` |

Highlight, focus, selected lists and dropdowns are all derived from `accentPrimary`. Therefore these are real semantic collisions, not just similar swatches. The first four exact user/agent collisions were absent in `dev`. Some older palettes already had perceptually close blue or orange role/accent families, so a blind reset to `dev` is insufficient.

**Correction:** reserve distinct user and agent colors independently of interaction, status, compaction and Yolo colors. Check perceptual similarity as well as exact equality; keep text/icons readable on their actual rendered surfaces.

### 2. Zed reference mapping is incomplete

The added palettes reuse Zed surface/text values but do not preserve all of its role separation:

| CodeNomad ID | Closest direct reference | Exact matching examples |
| --- | --- | --- |
| porcelain | One Light | editor `#FAFAFA`, panels `#EBEBEC`, text `#242529` |
| dawn | Ayu Light | editor `#FCFCFC`, panels `#ECECED`, border `#CFD1D2` |
| parchment | Gruvbox Light | editor `#FBF1C7`, text `#282828`, accent `#0B6678` |

Some source colors were deliberately darkened for contrast, but that adaptation is not identified in the picker. More importantly, Zed models `element.selected` independently from `text.accent`: One Light uses `#CACACA` versus `#5C78E2`; Ayu Light uses `#CFD0D2` versus `#3B9EE5`. CodeNomad instead synthesizes selection from the accent for every palette. Zed also distinguishes window, panel and editor surfaces more explicitly than the shared derived formulas do.

**Correction:** document the source and mapping for each palette, retain the reference surface character, and make selection independent where the reference requires it. Do not undo the validated tab geometry or restore bright tab fills as a workaround.

### 3. Redundant choices, especially Custom

- `dev` has nine catalog entries; the UI branch has twelve. These counts include System and Custom, not just distinct ready-made palettes.
- Basalt and default Custom share **all ten core colors**; only three of the four semantic fields differ. On `dev`, they were fully identical, so this duplication predates the latest changes.
- System Dark, Basalt and Fjord have very close large-area surfaces. Porcelain and Dawn have almost identical neutral surface brightness. The quieter tab and message treatment reduces their remaining visible differences further.
- Custom is unconditionally listed in `BUILT_IN_COLOR_SCHEMES` and the editor options. The inspected profile has default Custom selected with no named presets or overrides: this entry is not evidence of a user-created duplicate.

**Correction:** present System as an automatic mode and customization as an action, not as additional near-duplicate palettes. Preserve named presets and legacy Custom colors when migrating; never delete user data merely because two palettes look similar.

### 4. Classic editor changes can be saved but ignored — high priority

The UI allows built-in overrides and saves them through `saveColorSchemeOverride()`. However, `applyColorScheme()` skips all derived properties whenever `id === "classic"`, including explicit overrides.

Reproduction with the real normalizer/renderer and a mock target: set Classic's `accentPrimary` to `#FF00FF`; the renderer applies **zero properties** and falls back to static CSS. The exact default Classic rendering can remain protected without discarding an explicit saved override.

### 5. Edited System colors can freeze across appearances

System overrides store one color set, while its appearance remains `system`. The renderer prefers saved colors over its light/dark defaults. Supplying System Light colors and then resolving with `systemDark: true` still applies surface `#F7F8FA`.

**Correction:** either maintain separate light/dark selections for automatic mode or save an edited System appearance as a named fixed palette. Do not silently create a mixed light-palette/dark-mode configuration.

### 6. Current tests do not protect visual identity

The 21 existing palette/preset tests pass. They cover schema, contrast and selected token assignments, but not user/agent collisions, catalog duplicates, Classic overrides, or System overrides across appearances. The editor and preset loader now accept syntactically valid colors without contrast validation. Loading should preserve user data; saving can offer non-destructive warnings instead of rejecting or deleting it.

## Proposed light collection

Start with six named, source-backed light palettes, rather than filling the picker with Soft/Medium/Hard variants of one family:

| Reference | Intended character |
| --- | --- |
| One Light | neutral white/gray, clear separation between panels and content |
| Ayu Light | airy near-white, softer blue-gray text |
| Catppuccin Latte | cool gray/lavender, mauve accent |
| Solarized Light | ivory paper, blue-gray text |
| Gruvbox Light | visibly warm ochre paper and stronger text |
| Everforest Light | muted paper/olive family; choose one variant after contact-sheet comparison |

Existing light IDs should have a deliberate compatibility mapping; additional entries should not overwrite saved colors. This is a proposed collection, not an assertion that all six are already implemented or visually accepted.

## Validation gate for the correction pass

1. Reproduce and test persistence/rendering defects before changing the catalog.
2. Keep reference metadata and role mapping together; retain necessary licenses/attribution if copying theme data.
3. Test role separation, contrast on actual surfaces, palette migration and independent light/dark automatic behavior.
4. Compare every candidate on the same conversation, sidebar, selected row, prompt and Status panel, in both normal and interaction states.
5. Test render after selection, editing, save, reload and reset. A correct swatch alone is not enough.
6. Validate in the isolated UI profile only; do not restart existing desktop hosts or the shared OpenCode service.

## Implementation follow-up

The findings above record the pre-change audit. The subsequent correction pass
is implemented in the UI worktree and included in PR #667's reconciliation:

- Six soft light palettes: Mist, Slate, Clay, Linen, Iris and Sage.
- Four soft dark palettes: Mist, Slate, Clay and Sage. Their canvases are
  mid-dark grays rather than the near-black surfaces of the legacy collection.
- The existing six dark palettes and original Light remain in an explicitly
  separate **Original palettes** group. Their declared surface values from
  `dev` are preserved; participant roles and the surface mapping are corrected.
- Transcript/message surfaces use the panel surface, not the composer canvas;
  user messages regain a slight identity tint and tools use the third surface.
- Neutral selection is independent of user/agent identity. The new families
  share separate, contrast-tested identity colors per appearance.
- System is a separate automatic-mode button, not another duplicate palette.
  Editing it creates a named fixed palette; historical embedded System colors
  are preserved as a fixed customization instead of mixed light/dark rendering.
- Default-only Custom is represented by Basalt without rewriting its stored
  data. Named and genuinely edited custom palettes are kept. There is no empty
  Custom entry in a clean picker; New remains directly available.
- Classic edits now reach the renderer. Deleting a named preset retains its
  current colors and the swatches correctly reflect those retained colors.
- Palette selection awaits persistence, disables competing edits during the
  write, and reports save failure rather than hiding it behind optimistic state.

### Review iterations and validation

The initial candidate colors were **not** accepted unchanged. The review
corrected weak muted-text contrast on tool surfaces, near-identical Mist/Slate
light surfaces, two dark agent/function collisions, and almost identical
primary/muted text in Linen and several other light palettes.

- **69 targeted tests passed**: palette definitions/rendering/persistence
  helpers/quality plus transcript visibility, timeline and drawer regressions.
- UI typecheck and production build passed; `git diff --check` passed.
- **17 actual native palette selections and screenshots** were taken in the
  isolated profile, with separate transcript/composer backgrounds verified for
  every choice. Tool-header hover and composer focus were exercised for each.
- The same screenshot sets were compared as contact sheets; full-size views
  were also reviewed. The six new light families must differ on large-area
  surfaces alone. Legacy palettes may retain close surfaces differentiated by
  their established accent; they are not advertised as new soft variants.
- **14 native settings checks passed**: Classic save/reselect/reload/reset,
  System light/dark changes, named creation/deletion/retained swatches and
  420/960px LTR/RTL layout.
- **8 independent Edge layout cases passed** with the compiled stylesheet:
  fine/coarse pointer × LTR/RTL × 420/960px. Coarse-pointer controls measured
  at least 40px. WebView2 touch emulation did not expose a coarse pointer, so
  these touch measurements are not claimed as native touch-device testing.
- New labels and group names are present in all ten locales.

New palette definitions and attribution are documented in
[`PALETTE_SOURCES.md`](./PALETTE_SOURCES.md). Test colors and the temporary named
test preset were not left in the catalog. Only the isolated build's UI assets
were refreshed; no desktop executable or shared OpenCode service was restarted.

### Local visual evidence

Artifacts under `%LOCALAPPDATA%/Temp/opencode/`:

- `palette-native-review.json`, `palette-review-<id>.png`
- `palette-sheet-soft-dark.png`, `palette-sheet-legacy-dark.png`, `palette-sheet-light.png`
- `palette-controls-native.json`, `palette-touch-report.json`
- `palette-final-tests.log`, `ui-palettes-build.log`

## Source links

- [Zed One](https://github.com/zed-industries/zed/blob/6f73c7d0a4aae8e32afb5d01b0fcb89e5e3642ff/assets/themes/one/one.json)
- [Zed Ayu](https://github.com/zed-industries/zed/blob/6f73c7d0a4aae8e32afb5d01b0fcb89e5e3642ff/assets/themes/ayu/ayu.json)
- [Zed Gruvbox](https://github.com/zed-industries/zed/blob/6f73c7d0a4aae8e32afb5d01b0fcb89e5e3642ff/assets/themes/gruvbox/gruvbox.json)
- [Catppuccin for Zed](https://github.com/catppuccin/zed/blob/main/themes/catppuccin-mauve.json)
- [Solarized for Zed](https://github.com/harmtemolder/Solarized.zed/blob/main/themes/solarized.json)
- [Everforest for Zed](https://github.com/albertsko/zed-everforest/blob/main/themes/everforest-regular.json)
- [Official Zed extension registry](https://github.com/zed-industries/extensions)
