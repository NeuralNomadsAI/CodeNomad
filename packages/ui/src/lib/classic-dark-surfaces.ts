import type { ColorSchemeColors } from "./theme-scheme"

/** Explicit dark mode in CodeNomad V1, tokens.css at 52f0e629^.
 * Keep the historical defaults without masking saved color edits. */
export function classicDarkSurfaces(colors: Readonly<ColorSchemeColors>): Record<string, string> {
  return {
    ...(colors.userAccent === "#2196F3" && colors.surfaceBase === "#1A1A1A" && colors.surfaceSecondary === "#2A2A2A"
      ? { "--message-user-bg": "#202734" } : {}),
    ...(colors.accentPrimary === "#0080FF" ? { "--accent-hover": "#0066CC" } : {}),
    ...(colors.borderBase === "#3A3A3A" && colors.textMuted === "#999999" ? {
      "--message-tool-border": "#ADB5BD",
      "--border-secondary": "#3A3A3A",
      "--border-muted": "#3A3A3A",
      "--border-strong": "#3A3A3A",
    } : {}),
  }
}
