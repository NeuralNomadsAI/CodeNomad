import { DARK_IDENTITY_COLORS, LIGHT_IDENTITY_COLORS, SOFT_COLOR_SCHEME_IDS, SOFT_COLOR_SCHEMES, SOFT_SYSTEM_DARK, SOFT_SYSTEM_LIGHT } from "./soft-color-schemes.ts"
import { classicLightSurfaces } from "./classic-light-surfaces"
import { classicDarkSurfaces } from "./classic-dark-surfaces"
import { channel, contrastRatio, isCanonicalHexColor, luminance, mix } from "./color-contrast"
import { highContrastColors } from "./high-contrast"

export { contrastRatio, isCanonicalHexColor } from "./color-contrast"

export const COLOR_SCHEME_IDS = ["system", "light", ...SOFT_COLOR_SCHEME_IDS, "classic", "basalt", "fjord", "lichen", "velvet", "ember", "custom"] as const

export type ColorSchemeId = (typeof COLOR_SCHEME_IDS)[number]
export type ColorSchemeAppearance = "system" | "light" | "dark"

export interface ColorSchemeColors {
  surfaceBase: string
  surfaceSecondary: string
  surfaceMuted: string
  borderBase: string
  textPrimary: string
  textMuted: string
  accentPrimary: string
  statusSuccess: string
  statusWarning: string
  statusError: string
  userAccent: string
  agentAccent: string
  compactionAccent: string
}

export interface ColorSchemeDefinition {
  id: ColorSchemeId
  labelKey: string
  appearance: ColorSchemeAppearance
  editable: boolean
  colors?: Readonly<ColorSchemeColors>
}

export interface NormalizedColorScheme {
  id: ColorSchemeId
  appearance: ColorSchemeAppearance
  colors?: ColorSchemeColors
}

export interface ColorSchemeTarget {
  style: {
    setProperty(name: string, value: string): void
    removeProperty(name: string): unknown
  }
  dataset: Record<string, string | undefined>
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
}

const COLOR_KEYS: readonly (keyof ColorSchemeColors)[] = [
  "surfaceBase",
  "surfaceSecondary",
  "surfaceMuted",
  "borderBase",
  "textPrimary",
  "textMuted",
  "accentPrimary",
  "statusSuccess",
  "statusWarning",
  "statusError",
  "userAccent",
  "agentAccent",
  "compactionAccent",
]

const LEGACY_COLOR_KEYS = COLOR_KEYS.slice(0, 10)

const DEFAULT_SEMANTIC_COLORS = {
  userAccent: "#42A5F5",
  agentAccent: "#D97706",
  compactionAccent: "#C084FC",
} as const

export const DEFAULT_CUSTOM_COLORS: Readonly<ColorSchemeColors> = {
  surfaceBase: "#17181A",
  surfaceSecondary: "#202226",
  surfaceMuted: "#292C31",
  borderBase: "#3B3F46",
  textPrimary: "#F0F1F3",
  textMuted: "#B2B6BE",
  accentPrimary: "#8FA8FF",
  statusSuccess: "#72C497",
  statusWarning: "#D8B36A",
  statusError: "#E28181",
  ...DEFAULT_SEMANTIC_COLORS,
}

export const LIGHT_COLOR_SCHEME_COLORS: Readonly<ColorSchemeColors> = {
  surfaceBase: "#FFFFFF",
  surfaceSecondary: "#F5F5F5",
  surfaceMuted: "#F8FAFC",
  borderBase: "#E0E0E0",
  textPrimary: "#111827",
  textMuted: "#475569",
  accentPrimary: "#0066FF",
  statusSuccess: "#237A43",
  statusWarning: "#9A6700",
  statusError: "#C62828",
  ...LIGHT_IDENTITY_COLORS,
}

export const SYSTEM_LIGHT_COLOR_SCHEME_COLORS = SOFT_SYSTEM_LIGHT
export const SYSTEM_DARK_COLOR_SCHEME_COLORS = SOFT_SYSTEM_DARK

export const BUILT_IN_COLOR_SCHEMES: readonly ColorSchemeDefinition[] = [
  {
    id: "system",
    labelKey: "settings.appearance.colorScheme.option.system",
    appearance: "system",
    editable: false,
  },
  {
    id: "light",
    labelKey: "settings.appearance.colorScheme.option.codeNomadClassic",
    appearance: "light",
    editable: false,
    colors: LIGHT_COLOR_SCHEME_COLORS,
  },
  {
    id: "classic",
    labelKey: "settings.appearance.colorScheme.option.codeNomadClassic",
    appearance: "dark",
    editable: false,
    colors: {
      surfaceBase: "#1A1A1A",
      surfaceSecondary: "#2A2A2A",
      surfaceMuted: "#212529",
      borderBase: "#3A3A3A",
      textPrimary: "#CFD4DC",
      textMuted: "#999999",
      accentPrimary: "#4D7AFE",
      statusSuccess: "#4CAF50",
      statusWarning: "#FF9800",
      statusError: "#F44336",
      userAccent: "#2196F3",
      agentAccent: "#D97706",
      compactionAccent: "#C084FC",
    },
  },
  ...SOFT_COLOR_SCHEMES,
  {
    id: "basalt",
    labelKey: "settings.appearance.colorScheme.option.basalt",
    appearance: "dark",
    editable: false,
    colors: {
      ...DEFAULT_CUSTOM_COLORS,
      ...DARK_IDENTITY_COLORS,
      userAccent: "#88EEFB",
    },
  },
  {
    id: "fjord",
    labelKey: "settings.appearance.colorScheme.option.fjord",
    appearance: "dark",
    editable: false,
    colors: {
      surfaceBase: "#131A1F",
      surfaceSecondary: "#1B252C",
      surfaceMuted: "#243139",
      borderBase: "#354650",
      textPrimary: "#E7EEF1",
      textMuted: "#A8B8BF",
      accentPrimary: "#67C9BA",
      statusSuccess: "#8FC473",
      statusWarning: "#D8B36A",
      statusError: "#E28181",
      ...DARK_IDENTITY_COLORS,
    },
  },
  {
    id: "lichen",
    labelKey: "settings.appearance.colorScheme.option.lichen",
    appearance: "dark",
    editable: false,
    colors: {
      surfaceBase: "#181A15",
      surfaceSecondary: "#22251D",
      surfaceMuted: "#2C3025",
      borderBase: "#41473A",
      textPrimary: "#ECEEE8",
      textMuted: "#B2B8A7",
      accentPrimary: "#A9C47F",
      statusSuccess: "#77C49A",
      statusWarning: "#D6B36D",
      statusError: "#DF8580",
      ...DARK_IDENTITY_COLORS,
    },
  },
  {
    id: "velvet",
    labelKey: "settings.appearance.colorScheme.option.velvet",
    appearance: "dark",
    editable: false,
    colors: {
      surfaceBase: "#160F16",
      surfaceSecondary: "#211721",
      surfaceMuted: "#2B1E2B",
      borderBase: "#443044",
      textPrimary: "#F1EAF0",
      textMuted: "#BAAAB7",
      accentPrimary: "#E5A77D",
      statusSuccess: "#78C59A",
      statusWarning: "#DDB46F",
      statusError: "#E28787",
      ...DARK_IDENTITY_COLORS,
    },
  },
  {
    id: "ember",
    labelKey: "settings.appearance.colorScheme.option.ember",
    appearance: "dark",
    editable: false,
    colors: {
      surfaceBase: "#1B1714",
      surfaceSecondary: "#27211D",
      surfaceMuted: "#312923",
      borderBase: "#493D34",
      textPrimary: "#F1ECE7",
      textMuted: "#BDB1A6",
      accentPrimary: "#D99254",
      statusSuccess: "#78C296",
      statusWarning: "#D8AE62",
      statusError: "#DE817A",
      ...DARK_IDENTITY_COLORS,
    },
  },
  {
    id: "custom",
    labelKey: "settings.appearance.colorScheme.option.custom",
    appearance: "dark",
    editable: true,
    colors: DEFAULT_CUSTOM_COLORS,
  },
]

const SCHEMES_BY_ID = Object.fromEntries(BUILT_IN_COLOR_SCHEMES.map((scheme) => [scheme.id, scheme])) as Record<
  ColorSchemeId,
  ColorSchemeDefinition
>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function isColorSchemeColors(value: unknown): value is ColorSchemeColors {
  return isRecord(value) && COLOR_KEYS.every((key) => isCanonicalHexColor(value[key]))
}

function normalizeColors(value: unknown): ColorSchemeColors | undefined {
  if (!isRecord(value) || !LEGACY_COLOR_KEYS.every((key) => isCanonicalHexColor(value[key]))) return undefined
  const colors: ColorSchemeColors = { ...DEFAULT_CUSTOM_COLORS }
  for (const key of COLOR_KEYS) {
    const color = value[key]
    if (isCanonicalHexColor(color)) colors[key] = color
  }
  return colors
}

const copyColors = (colors: Readonly<ColorSchemeColors>): ColorSchemeColors => ({ ...colors })

function selectionFor(
  id: ColorSchemeId,
  colors?: Readonly<ColorSchemeColors>,
  appearance: ColorSchemeAppearance = SCHEMES_BY_ID[id].appearance,
): NormalizedColorScheme {
  const definition = SCHEMES_BY_ID[id]
  return {
    id,
    appearance,
    ...(colors || definition.colors ? { colors: copyColors(colors ?? definition.colors!) } : {}),
  }
}

export function normalizeColorScheme(value: unknown, legacyTheme?: unknown): NormalizedColorScheme {
  const id = typeof value === "string" ? value : isRecord(value) ? value.id : undefined

  if (typeof id === "string" && COLOR_SCHEME_IDS.includes(id as ColorSchemeId)) {
    const schemeId = id as ColorSchemeId
    if (schemeId !== "custom") {
      const colors = isRecord(value) ? normalizeColors(value.colors) : undefined
      // Old System edits contain only one appearance. Preserve them as fixed
      // colors rather than applying a light canvas with dark-mode rendering.
      if (schemeId === "system" && colors) {
        const appearance = isRecord(value) && (value.appearance === "light" || value.appearance === "dark")
          ? value.appearance
          : luminance(colors.surfaceBase) > 0.4 ? "light" : "dark"
        return selectionFor("custom", colors, appearance)
      }
      return selectionFor(schemeId, colors)
    }
    const colors = isRecord(value) ? normalizeColors(value.colors) ?? DEFAULT_CUSTOM_COLORS : DEFAULT_CUSTOM_COLORS
    const appearance = isRecord(value) && value.appearance === "light" ? "light" : "dark"
    return selectionFor("custom", colors, appearance)
  }

  if (legacyTheme === "light") return selectionFor("light")
  if (legacyTheme === "dark") return selectionFor("classic")
  return selectionFor("system")
}

export function toColorSchemeMergePatch(preference: NormalizedColorScheme): Omit<NormalizedColorScheme, "colors"> & {
  colors: ColorSchemeColors | null
} {
  const normalized = normalizeColorScheme(preference)
  return {
    ...normalized,
    colors: normalized.colors ? { ...normalized.colors } : null,
  }
}

export function validateColorSchemeColors(value: unknown): value is ColorSchemeColors {
  if (!isColorSchemeColors(value)) return false
  const textPairs: Array<[string, string]> = [
    [value.textPrimary, value.surfaceBase],
    [value.textPrimary, value.surfaceSecondary],
    [value.textPrimary, value.surfaceMuted],
    [value.textMuted, value.surfaceBase],
    [value.textMuted, value.surfaceSecondary],
    [value.textMuted, value.surfaceMuted],
  ]
  const emphasis = [
    value.accentPrimary,
    value.statusSuccess,
    value.statusWarning,
    value.statusError,
    value.userAccent,
    value.agentAccent,
    value.compactionAccent,
  ]
  const emphasisSurfaces = [value.surfaceBase, value.surfaceSecondary]
  return (
    textPairs.every(([foreground, background]) => contrastRatio(foreground, background) >= 4.5) &&
    emphasis.every((foreground) => emphasisSurfaces.every((background) => contrastRatio(foreground, background) >= 3))
  )
}

const alpha = (color: string, opacity: number) =>
  `rgba(${channel(color, 1)}, ${channel(color, 3)}, ${channel(color, 5)}, ${opacity})`

export const textOnColor = (color: string): "#000000" | "#FFFFFF" =>
  contrastRatio("#000000", color) >= contrastRatio("#FFFFFF", color) ? "#000000" : "#FFFFFF"

const APPLIED_PROPERTIES = [
  "--surface-base",
  "--surface-primary",
  "--surface-secondary",
  "--surface-muted",
  "--surface-code",
  "--surface-hover",
  "--border-base",
  "--border-secondary",
  "--border-muted",
  "--border-strong",
  "--border-critical",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--text-inverted",
  "--text-on-accent",
  "--accent-primary",
  "--accent-hover",
  "--focus-ring-color",
  "--focus-ring-offset",
  "--list-item-highlight-bg",
  "--list-item-highlight-bg-solid",
  "--list-item-highlight-border",
  "--attachment-chip-bg",
  "--attachment-chip-text",
  "--attachment-chip-ring",
  "--badge-neutral-bg",
  "--badge-neutral-text",
  "--env-vars-bg",
  "--env-vars-border",
  "--env-vars-text",
  "--dropdown-highlight-bg",
  "--selection-highlight-bg",
  "--selection-highlight-strong-bg",
  "--status-success",
  "--status-warning",
  "--status-error",
  "--status-success-bg",
  "--status-warning-bg",
  "--status-error-bg",
  "--status-success-ring",
  "--status-warning-ring",
  "--status-error-ring",
  "--status-ready-fg",
  "--status-ready-bg",
  "--status-starting-fg",
  "--status-starting-bg",
  "--status-error-fg",
  "--message-user-bg",
  "--message-user-border",
  "--message-assistant-bg",
  "--message-assistant-border",
  "--message-tool-bg",
  "--message-tool-border",
  "--session-status-compacting-fg",
  "--session-status-compacting-bg",
  "--tab-active-bg",
  "--tab-active-hover-bg",
  "--tab-active-text",
  "--tab-inactive-bg",
  "--tab-inactive-hover-bg",
  "--tab-inactive-text",
  "--tab-rail-bg",
  "--tab-border",
  "--new-tab-bg",
  "--new-tab-hover-bg",
  "--new-tab-text",
] as const

function derivedProperties(
  colors: ColorSchemeColors,
  dark: boolean,
  // Ink on filled actions follows the palette's own accent, so contrast never flips it.
  inkSource: ColorSchemeColors = colors,
): Record<(typeof APPLIED_PROPERTIES)[number], string> {
  const textOnAccent = textOnColor(inkSource.accentPrimary)
  // Selection is a neutral surface state, not a participant's identity color.
  const selection = colors.textMuted
  return {
    "--surface-base": colors.surfaceBase,
    "--surface-primary": colors.surfaceBase,
    "--surface-secondary": colors.surfaceSecondary,
    "--surface-muted": colors.surfaceMuted,
    // Output blocks follow the inset role (title-bar tint), not the input base.
    "--surface-code": "var(--surface-inset)",
    "--surface-hover": mix(colors.textPrimary, colors.surfaceSecondary, 0.04),
    "--border-base": colors.borderBase,
    "--border-secondary": mix(colors.borderBase, colors.surfaceSecondary, 0.72),
    "--border-muted": mix(colors.borderBase, colors.surfaceSecondary, 0.5),
    "--border-strong": mix(colors.textPrimary, colors.borderBase, 0.3),
    "--border-critical": colors.statusError,
    "--text-primary": colors.textPrimary,
    "--text-secondary": colors.textMuted,
    "--text-muted": colors.textMuted,
    "--text-inverted": textOnAccent,
    "--text-on-accent": textOnAccent,
    "--accent-primary": colors.accentPrimary,
    "--accent-hover": mix(dark ? "#FFFFFF" : "#000000", colors.accentPrimary, dark ? 0.14 : 0.18),
    "--focus-ring-color": colors.accentPrimary,
    "--focus-ring-offset": "var(--surface-canvas)",
    "--list-item-highlight-bg": alpha(selection, dark ? 0.2 : 0.12),
    "--list-item-highlight-bg-solid": mix(selection, colors.surfaceSecondary, dark ? 0.22 : 0.12),
    "--list-item-highlight-border": alpha(selection, dark ? 0.4 : 0.25),
    "--attachment-chip-bg": alpha(colors.accentPrimary, 0.1),
    "--attachment-chip-text": colors.accentPrimary,
    "--attachment-chip-ring": alpha(colors.accentPrimary, dark ? 0.2 : 0.1),
    "--badge-neutral-bg": alpha(colors.accentPrimary, dark ? 0.15 : 0.05),
    "--badge-neutral-text": colors.accentPrimary,
    "--env-vars-bg": alpha(colors.accentPrimary, dark ? 0.2 : 0.1),
    "--env-vars-border": alpha(colors.accentPrimary, dark ? 0.3 : 0.2),
    "--env-vars-text": colors.accentPrimary,
    "--dropdown-highlight-bg": alpha(selection, dark ? 0.2 : 0.12),
    "--selection-highlight-bg": alpha(selection, dark ? 0.22 : 0.16),
    "--selection-highlight-strong-bg": alpha(selection, dark ? 0.32 : 0.24),
    "--status-success": colors.statusSuccess,
    "--status-warning": colors.statusWarning,
    "--status-error": colors.statusError,
    "--status-success-bg": alpha(colors.statusSuccess, 0.16),
    "--status-warning-bg": alpha(colors.statusWarning, 0.16),
    "--status-error-bg": alpha(colors.statusError, 0.16),
    "--status-success-ring": alpha(colors.statusSuccess, 0.42),
    "--status-warning-ring": alpha(colors.statusWarning, 0.42),
    "--status-error-ring": alpha(colors.statusError, 0.42),
    "--status-ready-fg": colors.statusSuccess,
    "--status-ready-bg": alpha(colors.statusSuccess, 0.16),
    "--status-starting-fg": colors.statusWarning,
    "--status-starting-bg": alpha(colors.statusWarning, 0.16),
    "--status-error-fg": colors.statusError,
    "--message-user-bg": mix(colors.userAccent, colors.surfaceSecondary, dark ? 0.05 : 0.06),
    "--message-user-border": colors.userAccent,
    "--message-assistant-bg": colors.surfaceMuted,
    "--message-assistant-border": colors.agentAccent,
    "--message-tool-bg": colors.surfaceMuted,
    "--message-tool-border": mix(colors.textMuted, colors.borderBase, 0.28),
    "--session-status-compacting-fg": colors.compactionAccent,
    "--session-status-compacting-bg": alpha(colors.compactionAccent, dark ? 0.28 : 0.18),
    "--tab-active-bg": colors.surfaceBase,
    "--tab-active-hover-bg": mix(colors.textPrimary, colors.surfaceBase, 0.04),
    "--tab-active-text": colors.textPrimary,
    "--tab-inactive-bg": colors.surfaceSecondary,
    "--tab-inactive-hover-bg": mix(colors.textPrimary, colors.surfaceSecondary, 0.04),
    "--tab-inactive-text": colors.textMuted,
    "--tab-rail-bg": colors.surfaceSecondary,
    "--tab-border": colors.borderBase,
    "--new-tab-bg": colors.surfaceSecondary,
    "--new-tab-hover-bg": colors.surfaceMuted,
    "--new-tab-text": colors.textMuted,
  }
}

export function applyColorScheme(
  scheme: NormalizedColorScheme,
  options: { target?: ColorSchemeTarget; systemDark?: boolean; highContrast?: boolean } = {},
): boolean {
  const dark = scheme.appearance === "dark" || (scheme.appearance === "system" && Boolean(options.systemDark))
  const target = options.target ?? (typeof document === "undefined" ? undefined : document.documentElement)
  if (!target) return dark

  for (const property of APPLIED_PROPERTIES) target.style.removeProperty(property)
  target.dataset.colorScheme = scheme.id
  if (options.highContrast) target.dataset.contrast = "more"
  else delete target.dataset.contrast

  if (scheme.appearance === "system") target.removeAttribute("data-theme")
  else target.setAttribute("data-theme", dark ? "dark" : "light")

  const sourceColors = scheme.id === "system"
    ? scheme.colors ?? (dark ? SYSTEM_DARK_COLOR_SCHEME_COLORS : SYSTEM_LIGHT_COLOR_SCHEME_COLORS)
    : scheme.colors
  if (sourceColors) {
    const colors = options.highContrast ? highContrastColors(sourceColors, dark) : sourceColors
    for (const [property, value] of Object.entries(derivedProperties(colors, dark, sourceColors))) {
      target.style.setProperty(property, value)
    }
    if (scheme.id === "light") {
      for (const [property, value] of Object.entries(classicLightSurfaces(colors))) target.style.setProperty(property, value)
    }
    if (scheme.id === "classic") {
      for (const [property, value] of Object.entries(classicDarkSurfaces(colors))) target.style.setProperty(property, value)
    }
  }

  return dark
}
