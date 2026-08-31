import {
  isColorSchemeColors,
  validateColorSchemeColors,
  type ColorSchemeColors,
} from "./theme-scheme.ts"

export interface UserColorSchemePreset {
  name: string
  appearance: "light" | "dark"
  colors: ColorSchemeColors
}

export type UserColorSchemePresets = Record<string, UserColorSchemePreset>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function normalizeColorSchemePresets(value: unknown): UserColorSchemePresets {
  if (!isRecord(value)) return {}
  const presets: UserColorSchemePresets = {}
  for (const [id, candidate] of Object.entries(value).slice(0, 50)) {
    if (!id || id.length > 128 || !isRecord(candidate)) continue
    const name = typeof candidate.name === "string" ? candidate.name.trim().slice(0, 80) : ""
    const appearance = candidate.appearance === "light" ? "light" : candidate.appearance === "dark" ? "dark" : undefined
    if (!name || !appearance || !isColorSchemeColors(candidate.colors) || !validateColorSchemeColors(candidate.colors)) continue
    presets[id] = { name, appearance, colors: { ...candidate.colors } }
  }
  return presets
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
