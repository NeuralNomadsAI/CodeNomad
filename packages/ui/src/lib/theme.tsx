import { createContext, createRenderEffect, createMemo, createSignal, onCleanup, useContext, type JSX } from "solid-js"
import { createTheme, ThemeProvider as MuiThemeProvider } from "@suid/material/styles"
import CssBaseline from "@suid/material/CssBaseline"
import { useConfig } from "../stores/preferences"
import { effectiveAppearance } from "./appearance-preferences"
import {
  applyColorScheme,
  normalizeColorScheme,
  type NormalizedColorScheme,
} from "./theme-scheme"
import { createCssColorResolver } from "./css-color"
import { effectiveHighContrast } from "./high-contrast"

export type ThemeMode = "system" | "light" | "dark"

interface ThemeContextValue {
  isDark: () => boolean
  themeMode: () => ThemeMode
  setThemeMode: (mode: ThemeMode) => void
  cycleThemeMode: () => void
  colorScheme: () => NormalizedColorScheme
  setColorScheme: (scheme: NormalizedColorScheme) => void
  highContrast: () => boolean
  systemContrast: () => boolean
  forcedColors: () => boolean
  themeRevision: () => number
}

const ThemeContext = createContext<ThemeContextValue>()

interface ResolvedPaletteColors {
  backgroundDefault: string
  backgroundPaper: string
  primary: string
  primaryContrast: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  divider: string
  success: string
  warning: string
  error: string
}

const lightPaletteFallbacks: ResolvedPaletteColors = {
  backgroundDefault: "#ffffff",
  backgroundPaper: "#f5f5f5",
  primary: "#0066ff",
  primaryContrast: "#ffffff",
  textPrimary: "#1a1a1a",
  textSecondary: "#666666",
  textMuted: "#666666",
  divider: "#e0e0e0",
  success: "#2e7d32", warning: "#ed6c02", error: "#d32f2f",
}

const darkPaletteFallbacks: ResolvedPaletteColors = {
  backgroundDefault: "#1a1a1a",
  backgroundPaper: "#2a2a2a",
  primary: "#0080ff",
  primaryContrast: "#1a1a1a",
  textPrimary: "#cfd4dc",
  textSecondary: "#999999",
  textMuted: "#999999",
  divider: "#3a3a3a",
  success: "#66bb6a", warning: "#ffa726", error: "#f44336",
}

const resolvePaletteColors = (dark: boolean): ResolvedPaletteColors => {
  const fallbackSet = dark ? darkPaletteFallbacks : lightPaletteFallbacks
  if (typeof window === "undefined") return fallbackSet
  const resolver = createCssColorResolver()
  try {
    return {
      backgroundDefault: resolver.resolve("--surface-canvas", "background"),
      backgroundPaper: resolver.resolve("--surface-secondary", "background"),
      primary: resolver.resolve("--accent-primary", "selection"),
      primaryContrast: resolver.resolve("--text-on-accent", "selectionText"),
      textPrimary: resolver.resolve("--text-primary"),
      textSecondary: resolver.resolve("--text-secondary"),
      textMuted: resolver.resolve("--text-muted"),
      divider: resolver.resolve("--border-base"),
      success: resolver.resolve("--status-success"),
      warning: resolver.resolve("--status-warning"),
      error: resolver.resolve("--status-error"),
    }
  } finally { resolver.dispose() }
}

export function ThemeProvider(props: { children: JSX.Element }) {
  const media = (query: string) => typeof window !== "undefined" ? window.matchMedia?.(query) : undefined
  const mediaQuery = media("(prefers-color-scheme: dark)")
  const contrastQuery = media("(prefers-contrast: more)")
  const forcedQuery = media("(forced-colors: active)")
  const config = useConfig()
  const [systemDark, setSystemDark] = createSignal(mediaQuery?.matches ?? false)
  const [isDark, setIsDarkSignal] = createSignal(true)
  const [themeRevision, setThemeRevision] = createSignal(0)
  const [systemContrast, setSystemContrast] = createSignal(contrastQuery?.matches ?? false)
  const [forcedColors, setForcedColors] = createSignal(forcedQuery?.matches ?? false)

  const themeMode = () => config.themePreference()
  const colorScheme = createMemo(
    () => config.getAppearancePalette(effectiveAppearance(themeMode(), systemDark())),
    undefined, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  )
  const highContrast = createMemo(() => !forcedColors() && effectiveHighContrast(config.highContrastPreference(), systemContrast()))

  const applyResolvedTheme = () => {
    // System ink can change while the manually selected palette stays identical.
    if (forcedColors()) systemDark()
    const dark = applyColorScheme(colorScheme(), { highContrast: highContrast(), forcedColors: forcedColors() })
    setIsDarkSignal(dark)
    setThemeRevision((v) => v + 1)
  }

  createRenderEffect(() => {
    applyResolvedTheme()
  })

  const handleSystemThemeChange = (event: MediaQueryListEvent) => setSystemDark(event.matches)
  const handleSystemContrastChange = (event: MediaQueryListEvent) => setSystemContrast(event.matches)
  const handleForcedColorsChange = (event: MediaQueryListEvent) => setForcedColors(event.matches)
  mediaQuery?.addEventListener("change", handleSystemThemeChange)
  contrastQuery?.addEventListener("change", handleSystemContrastChange)
  forcedQuery?.addEventListener("change", handleForcedColorsChange)
  onCleanup(() => {
    mediaQuery?.removeEventListener("change", handleSystemThemeChange)
    contrastQuery?.removeEventListener("change", handleSystemContrastChange)
    forcedQuery?.removeEventListener("change", handleForcedColorsChange)
  })

  const setColorScheme = (scheme: NormalizedColorScheme) => {
    void config.setColorSchemePreference(normalizeColorScheme(scheme))
  }

  const setThemeMode = (mode: ThemeMode) => {
    void config.setThemePreference(mode)
  }

  const cycleThemeMode = () => {
    const current = themeMode()
    const next: ThemeMode = current === "system" ? "light" : current === "light" ? "dark" : "system"
    setThemeMode(next)
  }

  const muiTheme = createMemo(() => {
    themeRevision()
    const paletteColors = resolvePaletteColors(isDark())
    return createTheme({
      palette: {
        mode: isDark() ? "dark" : "light",
        primary: {
          main: paletteColors.primary,
          contrastText: paletteColors.primaryContrast,
        },
        secondary: {
          main: paletteColors.primary,
        },
        background: {
          default: paletteColors.backgroundDefault,
          paper: paletteColors.backgroundPaper,
        },
        text: {
          primary: paletteColors.textPrimary,
          secondary: paletteColors.textSecondary,
          ...(highContrast() || forcedColors() ? { disabled: paletteColors.textMuted } : {}),
        },
        divider: paletteColors.divider,
        ...(highContrast() || forcedColors() ? {
          success: { main: paletteColors.success },
          warning: { main: paletteColors.warning },
          error: { main: paletteColors.error },
        } : {}),
      },
      typography: {
        fontFamily: "var(--font-family-sans)",
      },
      shape: {
        borderRadius: 0,
      },
      components: {
        // No press ripple: pointer and touch presses do not animate, like the Message
        // content trigger. The keyboard focus ripple stays as the focus-visible cue.
        MuiButtonBase: { defaultProps: { disableTouchRipple: true } },
        MuiPaper: {
          styleOverrides: {
            root: { backgroundImage: highContrast() || forcedColors() ? "none" : undefined },
          },
        },
        MuiIconButton: {
          styleOverrides: {
            root: {
              color: "inherit",
              borderRadius: 0,
              padding: "6px",
              "&.Mui-disabled": {
                color: "var(--text-muted)",
                opacity: highContrast() ? "var(--contrast-opacity-55)" : 0.55,
              },
            },
          },
        },
        MuiDrawer: {
          styleOverrides: {
            paper: {
              backgroundColor: "var(--surface-secondary)",
              color: "var(--text-primary)",
            },
          },
        },
        MuiAppBar: {
          styleOverrides: {
            root: {
              backgroundColor: "var(--surface-secondary)",
              color: "var(--text-primary)",
              boxShadow: "none",
              borderBottom: "1px solid var(--border-base)",
              zIndex: 10,
            },
          },
        },
        MuiToolbar: {
          styleOverrides: {
            root: {
              minHeight: "40px",
            },
          },
        },
      } as any,
    })
  })

  return (
    <ThemeContext.Provider value={{ isDark, themeMode, setThemeMode, cycleThemeMode, colorScheme, setColorScheme,
      highContrast, systemContrast, forcedColors, themeRevision }}>
      <MuiThemeProvider theme={muiTheme}>
        <CssBaseline />
        {props.children}
      </MuiThemeProvider>
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider")
  }
  return context
}

/** Standalone content renderers may also mount outside the application theme. */
export const useOptionalTheme = () => useContext(ThemeContext)
