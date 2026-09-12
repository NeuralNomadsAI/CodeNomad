import { normalizeColorScheme, type NormalizedColorScheme } from "./theme-scheme"

export type Appearance = "light" | "dark"
export type AppearanceMode = "system" | Appearance
export interface AppearancePalette {
  scheme: NormalizedColorScheme
  presetId: string | null
}
export interface AppearancePreferences {
  mode: AppearanceMode
  light: AppearancePalette
  dark: AppearancePalette
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Migrate without writes: keep the previous fixed selection in its own slot. */
export function normalizeAppearancePreferences(value: unknown, legacy: NormalizedColorScheme, presetId?: string): AppearancePreferences {
  const input = record(value)
  const slot = (appearance: Appearance): AppearancePalette => {
    const saved = record(input[appearance])
    const scheme = normalizeColorScheme(saved.scheme)
    if (scheme.appearance === appearance) {
      return { scheme, presetId: typeof saved.presetId === "string" ? saved.presetId : null }
    }
    return legacy.appearance === appearance
      ? { scheme: legacy, presetId: presetId ?? null }
      : { scheme: normalizeColorScheme(appearance === "light" ? "porcelain" : "mist"), presetId: null }
  }
  return {
    mode: input.mode === "light" || input.mode === "dark" || input.mode === "system" ? input.mode : legacy.appearance,
    light: slot("light"),
    dark: slot("dark"),
  }
}

export function effectiveAppearance(mode: AppearanceMode, systemDark: boolean): Appearance {
  return mode === "system" ? systemDark ? "dark" : "light" : mode
}

export function selectAppearancePalette(current: AppearancePreferences, scheme: NormalizedColorScheme, presetId: string | null = null): AppearancePreferences {
  return scheme.appearance === "system"
    ? { ...current, mode: "system" }
    : { ...current, [scheme.appearance]: { scheme, presetId } }
}
