import { contrastRatio, isCanonicalHexColor, luminance, mix, oklabLightness, textOnColor, withOklabLightness } from "./color-contrast"
import type { ColorSchemeColors } from "./theme-scheme"

export type HighContrastPreference = "auto" | "on" | "off"
export const normalizeHighContrastPreference = (value: unknown): HighContrastPreference =>
  value === "on" || value === "off" ? value : "auto"
export const effectiveHighContrast = (preference: HighContrastPreference, systemMore = false): boolean =>
  preference === "on" || (preference === "auto" && systemMore)

export const HIGH_CONTRAST_TARGETS = { text: 7.5, nonText: 3.5 } as const
export const HIGH_CONTRAST_SURFACE_STRENGTH = { dark: 0.2, light: 0.8 } as const
const HIGH_CONTRAST_SECONDARY_DELTA_RATIO = 0.5

/** Smallest OKLCH lightness move that passes AFTER byte quantization.
 * Unattainable targets use whichever endpoint maximizes the weakest pair. */
export function strengthenContrast(color: string, backgrounds: readonly string[], target: number): string {
  if (!isCanonicalHexColor(color) || !backgrounds.length || backgrounds.some(bg => !isCanonicalHexColor(bg))
    || !Number.isFinite(target) || target < 1 || target > 21) throw new RangeError("Invalid contrast input")
  const passes = (value: string) => backgrounds.every(bg => contrastRatio(value, bg) >= target)
  if (passes(color)) return color
  const lightness = oklabLightness(color)
  const at = (endpoint: number, weight: number) => withOklabLightness(color, lightness + (endpoint - lightness) * weight)
  const candidates = ["#000000", "#FFFFFF"].filter(passes).map(endpoint => {
    const pole = endpoint === "#000000" ? 0 : 1
    let low = 0, high = 1
    for (let i = 0; i < 24; i++) {
      const middle = (low + high) / 2
      if (passes(at(pole, middle))) high = middle
      else low = middle
    }
    const result = at(pole, high)
    return { color: result, distance: Math.abs(luminance(result) - luminance(color)) }
  })
  // Opposing surfaces can admit a middle color even when neither pole passes.
  // ponytail: 4096 lightness steps cover the 3.5 border target; use analytic
  // luminance intervals if callers need arbitrarily narrow feasible bands.
  if (!candidates.length && target <= Math.sqrt(21)) {
    for (const endpoint of [0, 1]) {
      for (let step = 1; step <= 4096; step++) {
        const result = at(endpoint, step / 4096)
        if (!passes(result)) continue
        candidates.push({ color: result, distance: Math.abs(luminance(result) - luminance(color)) })
        break
      }
    }
  }
  candidates.sort((a, b) => a.distance - b.distance)
  if (!candidates.length) return ["#000000", "#FFFFFF"].sort((a, b) =>
    Math.min(...backgrounds.map(bg => contrastRatio(b, bg))) - Math.min(...backgrounds.map(bg => contrastRatio(a, bg))))[0]
  return candidates[0].color
}

/** Adapt the two palette inputs before normal token/Classic derivation. */
export function highContrastColors(
  colors: Readonly<ColorSchemeColors>,
  dark: boolean,
  surfaceStrength: number = HIGH_CONTRAST_SURFACE_STRENGTH[dark ? "dark" : "light"],
): ColorSchemeColors {
  if (!Number.isFinite(surfaceStrength) || surfaceStrength < 0 || surfaceStrength > 1) throw new RangeError("Invalid surface strength")
  if (surfaceStrength === 0) return { ...colors }
  const baseLightness = oklabLightness(colors.surfaceBase)
  const delta = ((dark ? 0 : 1) - baseLightness) * surfaceStrength
  return {
    ...colors,
    surfaceBase: withOklabLightness(colors.surfaceBase, baseLightness + delta),
    surfaceSecondary: withOklabLightness(colors.surfaceSecondary,
      Math.max(0, Math.min(1, oklabLightness(colors.surfaceSecondary) + delta * HIGH_CONTRAST_SECONDARY_DELTA_RATIO))),
  }
}

/** Strengthen foregrounds after normal derivation; reading surfaces stay intact. */
export function highContrastProperties(
  finalProperties: Readonly<Record<string, string>>,
  { dark, normalProperties = finalProperties }: { dark: boolean; normalProperties?: Readonly<Record<string, string>> },
): Record<string, string> {
  const p = { ...finalProperties }
  const { text, nonText } = HIGH_CONTRAST_TARGETS
  const ink = dark ? "#FFFFFF" : "#000000"
  const surfaceKeys = ["--surface-base", "--surface-primary", "--surface-secondary", "--surface-muted", "--surface-code",
    "--surface-field", "--surface-canvas", "--surface-overlay", "--surface-inset", "--surface-control",
    "--surface-shade-light", "--surface-shade-strong", "--surface-chrome", "--surface-subtle",
    "--message-user-bg", "--message-assistant-bg", "--message-tool-bg", "--tab-active-bg", "--tab-inactive-bg",
    "--tab-rail-bg", "--new-tab-bg"].filter(key => isCanonicalHexColor(p[key]))

  const backgrounds = [...new Set(surfaceKeys.map(key => p[key]))]
  const foreground = (color: string, target: number = text) => strengthenContrast(color, backgrounds, target)

  // A state tint must leave room for every text color on the brightest/darkest
  // built-in surface (Clay has very little headroom). Its border carries selection.
  const stateBase = backgrounds.reduce((a, b) => ink === "#FFFFFF"
    ? luminance(a) > luminance(b) ? a : b
    : luminance(a) < luminance(b) ? a : b)
  // Cap state lightness at the existing worst surface: stronger Base/Secondary
  // inputs must never relax foreground contrast or consume its chroma headroom.
  const state = strengthenContrast(mix(ink, stateBase, .06), [ink], contrastRatio(ink, stateBase))
  const stateStrong = strengthenContrast(mix(ink, stateBase, .1), [ink], contrastRatio(ink, stateBase))
  backgrounds.push(state, stateStrong)

  for (const key of ["--text-primary", "--text-secondary", "--text-muted", "--tab-active-text", "--tab-inactive-text", "--new-tab-text",
    "--status-success", "--status-warning", "--status-error",
    "--message-user-border", "--message-assistant-border", "--session-status-compacting-fg", "--session-yolo-accent"]) {
    p[key] = foreground(p[key])
  }
  // Accent fills retain the palette source. Colored text uses a distinct role.
  p["--accent-text"] = foreground(p["--accent-primary"])
  p["--accent-hover-text"] = foreground(p["--accent-hover"])
  for (const key of ["--border-base", "--border-strong", "--border-critical", "--message-tool-border", "--tab-border"]) {
    p[key] = foreground(p[key], nonText)
  }
  // Retain the normal hierarchy's contrast excess (ratio minus the invisible 1:1
  // baseline), measured on Secondary where the border roles are derived.
  const reference = p["--surface-secondary"], normalReference = normalProperties["--surface-secondary"]
  const normalBase = normalProperties["--border-base"]
  const baseExcess = contrastRatio(p["--border-base"], reference) - 1
  const normalExcess = Math.max(.001, contrastRatio(normalBase, normalReference) - 1)
  const borderAt = (color: string, ratio: number) => strengthenContrast(
    withOklabLightness(color, oklabLightness(reference)), [reference], Math.min(21, ratio))
  for (const key of ["--border-secondary", "--border-muted"]) {
    const normalWeight = (contrastRatio(normalProperties[key], normalReference) - 1) / normalExcess
    // Equal source colors still keep the semantic distinction between lighter roles.
    const weight = Math.max(.01, normalWeight >= 1 ? key === "--border-secondary" ? .72 : .5 : normalWeight)
    p[key] = borderAt(normalProperties[key], 1 + baseExcess * weight)
  }
  // Fine row separators retain their normal 78% paint weight; group dividers
  // retain their stronger 82% border / 18% text mix.
  p["--border-row"] = mix(p["--border-base"], reference, .78)
  p["--border-divider"] = mix(p["--border-base"], p["--text-primary"], .82)
  if (contrastRatio(p["--border-strong"], reference) <= contrastRatio(p["--border-base"], reference)) {
    p["--border-strong"] = borderAt(p["--border-strong"], 1 + baseExcess + .35)
  }
  for (const key of ["--scrollbar-thumb", "--scrollbar-thumb-hover"]) p[key] = p["--border-base"]
  for (const key of ["--surface-hover", "--surface-interactive-hover", "--surface-hover-overlay", "--selection-neutral-bg",
    "--list-item-highlight-bg", "--list-item-highlight-bg-solid", "--dropdown-highlight-bg", "--menu-item-hover-bg",
    "--menu-item-selected-bg", "--tab-active-hover-bg", "--tab-inactive-hover-bg", "--new-tab-hover-bg"]) p[key] = state
  p["--selection-neutral-strong-bg"] = stateStrong
  p["--list-item-highlight-border"] = p["--border-base"]

  // Selection exposes its paired foreground to native selection consumers.
  p["--selection-highlight-bg"] = state
  p["--selection-highlight-strong-bg"] = stateStrong
  p["--selection-highlight-text"] = p["--text-primary"]
  p["--dropdown-highlight-text"] = p["--text-primary"]

  const pairs = [
    ["--attachment-chip", "--accent-text", "text", "ring"],
    ["--badge-neutral", "--accent-text", "text"],
    ["--env-vars", "--accent-text", "text", "border"],
    ["--status-success", "--status-success", "", "ring"],
    ["--status-warning", "--status-warning", "", "ring"],
    ["--status-error", "--status-error", "fg", "ring"],
    ["--status-ready", "--status-success", "fg"],
    ["--status-starting", "--status-warning", "fg"],
    ["--status-stopped", "--text-muted", "fg"],
    ["--session-status-working", "--status-warning", "fg"],
    ["--session-status-idle", "--status-success", "fg"],
    ["--session-status-permission", "--status-error", "fg"],
    ["--session-status-compacting", "--session-status-compacting-fg", "fg"],
  ]
  for (const [prefix, source, suffix, border] of pairs) {
    p[`${prefix}-bg`] = state
    if (suffix) p[`${prefix}-${suffix}`] = p[source]
    if (border) p[`${prefix}-${border}`] = p[source]
  }
  p["--badge-success-bg"] = state
  for (const key of ["--message-error-bg", "--message-error-bg-strong", "--danger-soft-bg", "--danger-soft-bg-strong",
    "--code-block-header-bg", "--markdown-table-row-even", "--control-ghost-bg"]) p[key] = state
  p["--markdown-table-row-odd"] = "transparent"
  p["--message-part-header-type"] = p["--text-muted"]
  p["--message-part-header-title"] = p["--text-primary"]

  // Filled actions choose their ink by OKLab lightness, independently of text on surfaces.
  const actionText = textOnColor(p["--accent-primary"])
  p["--text-on-accent"] = p["--text-inverted"] = actionText
  p["--button-primary-text"] = dark ? "#FFFFFF" : actionText
  const dangerFill = finalProperties["--status-error"]
  const dangerText = textOnColor(dangerFill)
  for (const key of ["--button-danger-bg", "--button-danger-hover-bg", "--button-danger-active-bg"]) {
    p[key] = dangerFill
  }
  p["--button-danger-text"] = dangerText
  p["--timeline-segment-active-bg"] = state
  p["--timeline-segment-active-text"] = p["--text-primary"]
  p["--timeline-segment-active-ring"] = `inset 0 0 0 1px ${p["--border-base"]}`
  return p
}
