import type { ColorSchemeColors, ColorSchemeDefinition } from "./theme-scheme"

// Adapted surface families, not complete copies of the editor themes.
// Reference mapping and licenses: dev-docs/PALETTE_SOURCES.md.
export const SOFT_COLOR_SCHEME_IDS = [
  "porcelain", "dawn", "parchment", "linen", "iris", "sage-light",
  "mist", "slate", "clay", "sage",
] as const

// Identity colors stay stable across families, independently of selection/status.
export const DARK_IDENTITY_COLORS = {
  userAccent: "#79BCE0",
  agentAccent: "#D89DBD",
  compactionAccent: "#AC9DDD",
} as const
export const LIGHT_IDENTITY_COLORS = {
  userAccent: "#24688B",
  agentAccent: "#93466F",
  compactionAccent: "#67529B",
} as const

function palette(
  id: (typeof SOFT_COLOR_SCHEME_IDS)[number],
  family: string,
  appearance: "light" | "dark",
  colors: Omit<ColorSchemeColors, "userAccent" | "agentAccent" | "compactionAccent">
    & Partial<Pick<ColorSchemeColors, "userAccent" | "agentAccent" | "compactionAccent">>,
): ColorSchemeDefinition {
  return {
    id, appearance, editable: false,
    labelKey: `settings.appearance.palette.${family}`,
    colors: { ...(appearance === "dark" ? DARK_IDENTITY_COLORS : LIGHT_IDENTITY_COLORS), ...colors },
  }
}

export const SOFT_COLOR_SCHEMES: readonly ColorSchemeDefinition[] = [
  // One: softened light canvas / original mid-gray dark surfaces.
  palette("porcelain", "mist", "light", {
    surfaceBase: "#E1E3E5", surfaceSecondary: "#CFD1D4", surfaceMuted: "#BDC1C6",
    borderBase: "#A9AEB6", textPrimary: "#3D4148", textMuted: "#484E58",
    accentPrimary: "#665BA3", statusSuccess: "#426F49", statusWarning: "#81641D",
    statusError: "#AC4547", compactionAccent: "#A07AFF",
  }),
  palette("mist", "mist", "dark", {
    surfaceBase: "#282C33", surfaceSecondary: "#343A44", surfaceMuted: "#404754",
    borderBase: "#525B69", textPrimary: "#CED2DA", textMuted: "#ADB5C3",
    accentPrimary: "#D0ED9C", statusSuccess: "#81C1A8", statusWarning: "#DEC184",
    statusError: "#E8987D",
  }),
  // Ayu Light / Mirage: cooler, slate-tinted surfaces, not Ayu's near-black.
  palette("dawn", "slate", "light", {
    surfaceBase: "#CFE2F1", surfaceSecondary: "#BCD2E5", surfaceMuted: "#A5BFD4",
    borderBase: "#92AEC4", textPrimary: "#35424D", textMuted: "#3F4D59",
    accentPrimary: "#7F69E2", statusSuccess: "#4B733C", statusWarning: "#805C20",
    statusError: "#AB4849",
  }),
  palette("slate", "slate", "dark", {
    surfaceBase: "#272F40", surfaceSecondary: "#333E52", surfaceMuted: "#404E65",
    borderBase: "#53647C", textPrimary: "#C9D1DF", textMuted: "#9DB5D2",
    accentPrimary: "#C6B58C", statusSuccess: "#A5BD86", statusWarning: "#E0B778",
    statusError: "#E58D8A",
  }),
  // Gruvbox Soft: earth-gray rather than a black canvas or yellow-white paper.
  palette("parchment", "clay", "light", {
    surfaceBase: "#E2CEB0", surfaceSecondary: "#D5C09E", surfaceMuted: "#CFB994",
    borderBase: "#AC906A", textPrimary: "#3D352B", textMuted: "#4D4235",
    accentPrimary: "#A9BA45", statusSuccess: "#496C42", statusWarning: "#7B551B",
    statusError: "#A33D36",
  }),
  palette("clay", "clay", "dark", {
    surfaceBase: "#32302F", surfaceSecondary: "#41403E", surfaceMuted: "#55524E",
    borderBase: "#645C50", textPrimary: "#D8CBB3", textMuted: "#C6B9A5",
    accentPrimary: "#87BC5C", statusSuccess: "#B9BF69", statusWarning: "#D8B574",
    statusError: "#E39380", compactionAccent: "#AA91FD",
  }),
  // Solarized paper, desaturated and darkened slightly to avoid a white canvas.
  palette("linen", "linen", "light", {
    surfaceBase: "#F0EAD9", surfaceSecondary: "#E6E0CE", surfaceMuted: "#D8D1BD",
    borderBase: "#BDB6A2", textPrimary: "#3B494C", textMuted: "#4D5A5C",
    accentPrimary: "#9D8325", statusSuccess: "#699245", statusWarning: "#835B1E",
    statusError: "#AF4740",
  }),
  // Catppuccin Latte: the lavender-gray structure without the bright accent fill.
  palette("iris", "iris", "light", {
    surfaceBase: "#EDDFEF", surfaceSecondary: "#E0D4E5", surfaceMuted: "#CDBCD6",
    borderBase: "#B39DBF", textPrimary: "#42394F", textMuted: "#534961",
    accentPrimary: "#6B7CFF", statusSuccess: "#477343", statusWarning: "#825B20",
    statusError: "#AD424D",
  }),
  // Everforest Soft: gray-green rather than a second warm paper palette.
  palette("sage-light", "sage", "light", {
    surfaceBase: "#DCE6D2", surfaceSecondary: "#CBD8C1", surfaceMuted: "#B8C8AC",
    borderBase: "#9BAF8D", textPrimary: "#374532", textMuted: "#44543B",
    accentPrimary: "#6C7FCB", statusSuccess: "#496E3C", statusWarning: "#80591D",
    statusError: "#A9453E",
  }),
  palette("sage", "sage", "dark", {
    surfaceBase: "#2D3530", surfaceSecondary: "#39463D", surfaceMuted: "#47564A",
    borderBase: "#5A6A5C", textPrimary: "#D2D5C2", textMuted: "#C0CAB5",
    accentPrimary: "#CCC092", statusSuccess: "#81C182", statusWarning: "#DBBC7F",
    statusError: "#E8987D",
  }),
]

export const SOFT_SYSTEM_LIGHT = SOFT_COLOR_SCHEMES.find((scheme) => scheme.id === "porcelain")!.colors!
export const SOFT_SYSTEM_DARK = SOFT_COLOR_SCHEMES.find((scheme) => scheme.id === "mist")!.colors!
