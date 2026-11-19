import { channel, isCanonicalHexColor } from "./color-contrast"
import type { ColorSchemeColors } from "./theme-scheme"

export type HighContrastPreference = "auto" | "on" | "off"
export const normalizeHighContrastPreference = (value: unknown): HighContrastPreference =>
  value === "on" || value === "off" ? value : "auto"
export const effectiveHighContrast = (preference: HighContrastPreference, systemMore = false): boolean =>
  preference === "on" || (preference === "auto" && systemMore)

/** An image editor's contrast, applied to each sRGB channel of every palette color. The pivot is
 * mirrored around 0.5 by `pivotShift`: lower for dark palettes, higher for light ones. */
export const HIGH_CONTRAST_CURVE = { contrast: 1.3, pivotShift: 0.3 } as const

/** Apply the channel contrast to every palette input before token derivation. */
export function highContrastColors(colors: Readonly<ColorSchemeColors>, dark: boolean): ColorSchemeColors {
  const { contrast, pivotShift } = HIGH_CONTRAST_CURVE
  const pivot = dark ? 0.5 - pivotShift : 0.5 + pivotShift
  const stretch = (color: string) => `#${[1, 3, 5].map(offset => {
    const value = Math.max(0, Math.min(1, pivot + (channel(color, offset) / 255 - pivot) * contrast))
    return Math.round(value * 255).toString(16).padStart(2, "0")
  }).join("").toUpperCase()}`
  return Object.fromEntries(Object.entries(colors).map(([key, color]) => [
    key, isCanonicalHexColor(color) ? stretch(color) : color,
  ])) as unknown as ColorSchemeColors
}
