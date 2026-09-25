import type { ColorSchemeColors } from "./theme-scheme"

/** CodeNomad V1: tokens.css at 52f0e629^ (before the native V2 migration).
 * V1 had separate tool/code/secondary-text tokens. Restore their defaults
 * without overriding explicitly customized semantic fields. */
export function classicLightSurfaces(colors: Readonly<ColorSchemeColors>): Record<string, string> {
  return {
    ...(colors.surfaceMuted === "#F8FAFC" ? {
      "--message-assistant-bg": "#F8F8F8",
      "--message-tool-bg": "#F8F8F8",
      ...(colors.surfaceBase === "#FFFFFF" ? { "--surface-code": "#F1F5F9" } : {}),
    } : {}),
    ...(colors.textMuted === "#475569" ? { "--text-secondary": "#334155" } : {}),
    ...(colors.accentPrimary === "#0066FF" ? { "--accent-hover": "#0052CC" } : {}),
  }
}
