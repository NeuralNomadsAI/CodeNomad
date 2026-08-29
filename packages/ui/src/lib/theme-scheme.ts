export const COLOR_SCHEME_IDS = ["system", "light", "classic", "basalt", "fjord", "lichen", "velvet", "ember", "custom"] as const

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
}

export interface ColorSchemeDefinition {
  id: ColorSchemeId
  labelKey: string
  descriptionKey: string
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
]

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
}

export const BUILT_IN_COLOR_SCHEMES: readonly ColorSchemeDefinition[] = [
  {
    id: "system",
    labelKey: "settings.appearance.colorScheme.option.system",
    descriptionKey: "settings.appearance.colorScheme.description.system",
    appearance: "system",
    editable: false,
  },
  {
    id: "light",
    labelKey: "settings.appearance.colorScheme.option.light",
    descriptionKey: "settings.appearance.colorScheme.description.light",
    appearance: "light",
    editable: false,
  },
  {
    id: "classic",
    labelKey: "settings.appearance.colorScheme.option.codeNomadClassic",
    descriptionKey: "settings.appearance.colorScheme.description.codeNomadClassic",
    appearance: "dark",
    editable: false,
    colors: {
      surfaceBase: "#1A1A1A",
      surfaceSecondary: "#2A2A2A",
      surfaceMuted: "#212529",
      borderBase: "#3A3A3A",
      textPrimary: "#CFD4DC",
      textMuted: "#999999",
      accentPrimary: "#0080FF",
      statusSuccess: "#4CAF50",
      statusWarning: "#FF9800",
      statusError: "#F44336",
    },
  },
  {
    id: "basalt",
    labelKey: "settings.appearance.colorScheme.option.basalt",
    descriptionKey: "settings.appearance.colorScheme.description.basalt",
    appearance: "dark",
    editable: false,
    colors: DEFAULT_CUSTOM_COLORS,
  },
  {
    id: "fjord",
    labelKey: "settings.appearance.colorScheme.option.fjord",
    descriptionKey: "settings.appearance.colorScheme.description.fjord",
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
      statusSuccess: "#72C497",
      statusWarning: "#D8B36A",
      statusError: "#E28181",
    },
  },
  {
    id: "lichen",
    labelKey: "settings.appearance.colorScheme.option.lichen",
    descriptionKey: "settings.appearance.colorScheme.description.lichen",
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
    },
  },
  {
    id: "velvet",
    labelKey: "settings.appearance.colorScheme.option.velvet",
    descriptionKey: "settings.appearance.colorScheme.description.velvet",
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
    },
  },
  {
    id: "ember",
    labelKey: "settings.appearance.colorScheme.option.ember",
    descriptionKey: "settings.appearance.colorScheme.description.ember",
    appearance: "dark",
    editable: false,
    colors: {
      surfaceBase: "#1B1714",
      surfaceSecondary: "#27211D",
      surfaceMuted: "#312923",
      borderBase: "#493D34",
      textPrimary: "#F1ECE7",
      textMuted: "#BDB1A6",
      accentPrimary: "#D79A66",
      statusSuccess: "#78C296",
      statusWarning: "#D8AE62",
      statusError: "#DE817A",
    },
  },
  {
    id: "custom",
    labelKey: "settings.appearance.colorScheme.option.custom",
    descriptionKey: "settings.appearance.colorScheme.description.custom",
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

export const isCanonicalHexColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9A-F]{6}$/.test(value)

export function isColorSchemeColors(value: unknown): value is ColorSchemeColors {
  return isRecord(value) && COLOR_KEYS.every((key) => isCanonicalHexColor(value[key]))
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
    ...(definition.colors ? { colors: copyColors(colors ?? definition.colors) } : {}),
  }
}

export function normalizeColorScheme(value: unknown, legacyTheme?: unknown): NormalizedColorScheme {
  const id = typeof value === "string" ? value : isRecord(value) ? value.id : undefined

  if (typeof id === "string" && COLOR_SCHEME_IDS.includes(id as ColorSchemeId)) {
    const schemeId = id as ColorSchemeId
    if (schemeId !== "custom") return selectionFor(schemeId)
    const colors = isRecord(value) && isColorSchemeColors(value.colors) ? value.colors : DEFAULT_CUSTOM_COLORS
    const appearance = isRecord(value) && value.appearance === "light" ? "light" : "dark"
    return selectionFor("custom", colors, appearance)
  }

  if (legacyTheme === "light") return selectionFor("light")
  if (legacyTheme === "dark") return selectionFor("classic")
  return selectionFor("system")
}

const channel = (color: string, offset: number) => Number.parseInt(color.slice(offset, offset + 2), 16)

const luminance = (color: string) => {
  const linear = (value: number) => {
    const normalized = value / 255
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * linear(channel(color, 1)) + 0.7152 * linear(channel(color, 3)) + 0.0722 * linear(channel(color, 5))
}

export function contrastRatio(first: string, second: string): number {
  if (!isCanonicalHexColor(first) || !isCanonicalHexColor(second)) return 0
  const [bright, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (bright + 0.05) / (dark + 0.05)
}

export function validateColorSchemeColors(value: unknown): value is ColorSchemeColors {
  if (!isColorSchemeColors(value)) return false
  const textPairs: Array<[string, string]> = [
    [value.textPrimary, value.surfaceBase],
    [value.textPrimary, value.surfaceSecondary],
    [value.textMuted, value.surfaceBase],
    [value.textMuted, value.surfaceSecondary],
  ]
  const emphasis = [value.accentPrimary, value.statusSuccess, value.statusWarning, value.statusError]
  const emphasisSurfaces = [value.surfaceBase, value.surfaceSecondary]
  return (
    textPairs.every(([foreground, background]) => contrastRatio(foreground, background) >= 4.5) &&
    emphasis.every((foreground) => emphasisSurfaces.every((background) => contrastRatio(foreground, background) >= 3))
  )
}

const mix = (first: string, second: string, firstWeight: number) => {
  const mixed = [1, 3, 5].map((offset) =>
    Math.round(channel(first, offset) * firstWeight + channel(second, offset) * (1 - firstWeight)),
  )
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`
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
] as const

function derivedProperties(colors: ColorSchemeColors, dark: boolean): Record<(typeof APPLIED_PROPERTIES)[number], string> {
  const textOnAccent = textOnColor(colors.accentPrimary)
  return {
    "--surface-base": colors.surfaceBase,
    "--surface-primary": colors.surfaceBase,
    "--surface-secondary": colors.surfaceSecondary,
    "--surface-muted": colors.surfaceMuted,
    "--surface-code": dark ? colors.surfaceBase : colors.surfaceMuted,
    "--surface-hover": mix(colors.textPrimary, colors.surfaceSecondary, dark ? 0.12 : 0.08),
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
    "--focus-ring-offset": colors.surfaceBase,
    "--list-item-highlight-bg": alpha(colors.accentPrimary, dark ? 0.2 : 0.1),
    "--list-item-highlight-bg-solid": mix(colors.accentPrimary, colors.surfaceSecondary, dark ? 0.22 : 0.1),
    "--list-item-highlight-border": alpha(colors.accentPrimary, dark ? 0.4 : 0.25),
    "--attachment-chip-bg": alpha(colors.accentPrimary, 0.1),
    "--attachment-chip-text": colors.accentPrimary,
    "--attachment-chip-ring": alpha(colors.accentPrimary, dark ? 0.2 : 0.1),
    "--badge-neutral-bg": alpha(colors.accentPrimary, dark ? 0.15 : 0.05),
    "--badge-neutral-text": colors.accentPrimary,
    "--env-vars-bg": alpha(colors.accentPrimary, dark ? 0.2 : 0.1),
    "--env-vars-border": alpha(colors.accentPrimary, dark ? 0.3 : 0.2),
    "--env-vars-text": colors.accentPrimary,
    "--dropdown-highlight-bg": alpha(colors.accentPrimary, dark ? 0.2 : 0.1),
    "--selection-highlight-bg": alpha(colors.accentPrimary, dark ? 0.18 : 0.12),
    "--selection-highlight-strong-bg": alpha(colors.accentPrimary, dark ? 0.28 : 0.18),
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
  }
}

export function applyColorScheme(
  scheme: NormalizedColorScheme,
  options: { target?: ColorSchemeTarget; systemDark?: boolean } = {},
): boolean {
  const dark = scheme.appearance === "dark" || (scheme.appearance === "system" && Boolean(options.systemDark))
  const target = options.target ?? (typeof document === "undefined" ? undefined : document.documentElement)
  if (!target) return dark

  for (const property of APPLIED_PROPERTIES) target.style.removeProperty(property)
  target.dataset.colorScheme = scheme.id

  if (scheme.appearance === "system") target.removeAttribute("data-theme")
  else target.setAttribute("data-theme", dark ? "dark" : "light")

  if (scheme.colors && scheme.id !== "classic") {
    for (const [property, value] of Object.entries(derivedProperties(scheme.colors, dark))) {
      target.style.setProperty(property, value)
    }
  }

  return dark
}
