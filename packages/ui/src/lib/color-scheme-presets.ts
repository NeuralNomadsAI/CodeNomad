import {
  COLOR_SCHEME_IDS,
  isColorSchemeColors,
  type ColorSchemeColors,
  type ColorSchemeId,
} from "./theme-scheme.ts"

export interface UserColorSchemePreset {
  name: string
  appearance: "light" | "dark"
  colors: ColorSchemeColors
}

export type UserColorSchemePresets = Record<string, UserColorSchemePreset>
export type BuiltInColorSchemeOverrides = Partial<Record<Exclude<ColorSchemeId, "custom">, ColorSchemeColors>>
export const MAX_COLOR_SCHEME_PRESETS = 50

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function normalizeColorSchemePresets(value: unknown): UserColorSchemePresets {
  if (!isRecord(value)) return {}
  const presets: UserColorSchemePresets = {}
  for (const [id, candidate] of Object.entries(value).slice(0, MAX_COLOR_SCHEME_PRESETS)) {
    if (!id || id.length > 128 || !isRecord(candidate)) continue
    const name = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 80) : ""
    const appearance = candidate.appearance === "light" ? "light" : candidate.appearance === "dark" ? "dark" : undefined
    if (!name || !appearance || !isColorSchemeColors(candidate.colors)) continue
    presets[id] = { name, appearance, colors: { ...candidate.colors } }
  }
  return presets
}

export function normalizeColorSchemeOverrides(value: unknown): BuiltInColorSchemeOverrides {
  if (!isRecord(value)) return {}
  const overrides: BuiltInColorSchemeOverrides = {}
  for (const [id, colors] of Object.entries(value)) {
    if (id === "custom" || !COLOR_SCHEME_IDS.includes(id as ColorSchemeId) || !isColorSchemeColors(colors)) continue
    overrides[id as Exclude<ColorSchemeId, "custom">] = { ...colors }
  }
  return overrides
}

export function nextColorSchemePresetName(sourceName: string, existingNames: readonly string[]): string {
  const source = sourceName.trim() || "Custom"
  const match = /^(.*?)(?:\s+(\d+))?$/.exec(source)
  const base = match?.[1]?.trim() || source
  let suffix = match?.[2] ? Number(match[2]) + 1 : 2
  const used = new Set(existingNames.map((name) => name.trim().toLocaleLowerCase()))
  while (used.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix += 1
  return `${base} ${suffix}`
}

export function createColorSchemePresetId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `palette-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
