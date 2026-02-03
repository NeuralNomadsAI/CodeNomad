import { createContext, createEffect, createMemo, createSignal, onMount, useContext, type JSX } from "solid-js"
import { createTheme, ThemeProvider as MuiThemeProvider } from "@suid/material/styles"
import CssBaseline from "@suid/material/CssBaseline"
import { useConfig } from "../stores/preferences"

export type ThemeMode = "system" | "light" | "dark"

interface ThemeContextValue {
  isDark: () => boolean
  themeMode: () => ThemeMode
  setThemeMode: (mode: ThemeMode) => void
  cycleThemeMode: () => void
}

const ThemeContext = createContext<ThemeContextValue>()

function applyThemeMode(mode: ThemeMode) {
  if (typeof document === "undefined") return
  if (mode === "system") {
    document.documentElement.removeAttribute("data-theme")
    return
  }
  document.documentElement.setAttribute("data-theme", mode)
}

interface ResolvedPaletteColors {
  backgroundDefault: string
  backgroundPaper: string
  primary: string
  primaryContrast: string
  textPrimary: string
  textSecondary: string
  divider: string
}

const lightPaletteFallbacks: ResolvedPaletteColors = {
  backgroundDefault: "#ffffff",
  backgroundPaper: "#f5f5f5",
  primary: "#0066ff",
  primaryContrast: "#ffffff",
  textPrimary: "#1a1a1a",
  textSecondary: "#666666",
  divider: "#e0e0e0",
}

const darkPaletteFallbacks: ResolvedPaletteColors = {
  backgroundDefault: "#1a1a1a",
  backgroundPaper: "#2a2a2a",
  primary: "#0080ff",
  primaryContrast: "#1a1a1a",
  textPrimary: "#cfd4dc",
  textSecondary: "#999999",
  divider: "#3a3a3a",
}

const readCssVar = (token: string, fallback: string, rootStyle: CSSStyleDeclaration | null) => {
  if (!rootStyle) return fallback
  const value = rootStyle.getPropertyValue(token)
  if (!value) return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

const resolvePaletteColors = (dark: boolean): ResolvedPaletteColors => {
  const fallbackSet = dark ? darkPaletteFallbacks : lightPaletteFallbacks
  const rootStyle = typeof window !== "undefined" ? getComputedStyle(document.documentElement) : null

  return {
    backgroundDefault: readCssVar("--surface-base", fallbackSet.backgroundDefault, rootStyle),
    backgroundPaper: readCssVar("--surface-secondary", fallbackSet.backgroundPaper, rootStyle),
    primary: readCssVar("--accent-primary", fallbackSet.primary, rootStyle),
    primaryContrast: readCssVar("--text-inverted", fallbackSet.primaryContrast, rootStyle),
    textPrimary: readCssVar("--text-primary", fallbackSet.textPrimary, rootStyle),
    textSecondary: readCssVar("--text-secondary", fallbackSet.textSecondary, rootStyle),
    divider: readCssVar("--border-base", fallbackSet.divider, rootStyle),
  }
}

export function ThemeProvider(props: { children: JSX.Element }) {
  const mediaQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null
  const { themePreference } = useConfig()
  const [isDark, setIsDarkSignal] = createSignal(true)
  const [themeMode, setThemeModeSignal] = createSignal<ThemeMode>(themePreference())
  const [hasUserOverride, setHasUserOverride] = createSignal(false)
  const [themeRevision, setThemeRevision] = createSignal(0)

  const resolveDarkTheme = () => {
    const mode = themeMode()
    if (mode === "dark") return true
    if (mode === "light") return false
    return mediaQuery?.matches ?? false
  }

  const applyResolvedTheme = () => {
    const mode = themeMode()
    const dark = resolveDarkTheme()
    if (mode === "system") {
      applyThemeMode("system")
    } else {
      applyThemeMode(mode)
    }
    setIsDarkSignal(dark)
    if (typeof window !== "undefined") {
      requestAnimationFrame(() => setThemeRevision((v) => v + 1))
    } else {
      setThemeRevision((v) => v + 1)
    }
  }

  createEffect(() => {
    applyResolvedTheme()
  })

  createEffect(() => {
    const preference = themePreference()
    if (hasUserOverride()) return
    setThemeModeSignal(preference)
  })

  onMount(() => {
    if (!mediaQuery) return
    const handleSystemThemeChange = () => {
      applyResolvedTheme()
    }

    mediaQuery.addEventListener("change", handleSystemThemeChange)

    return () => {
      mediaQuery.removeEventListener("change", handleSystemThemeChange)
    }
  })

  const setThemeMode = (mode: ThemeMode) => {
    setHasUserOverride(true)
    setThemeModeSignal(mode)
    // Persistence is intentionally implemented later.
    // When we wire it up, this should call `setThemePreference(mode)`.
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
        },
        divider: paletteColors.divider,
      },
      typography: {
        fontFamily: "var(--font-family-sans)",
      },
      shape: {
        borderRadius: 8,
      },
      components: {
        MuiIconButton: {
          styleOverrides: {
            root: {
              color: "inherit",
              "&.Mui-disabled": {
                color: "var(--text-muted)",
                opacity: 0.55,
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
              minHeight: "56px",
            },
          },
        },
      } as any,
    })
  })

  return (
    <ThemeContext.Provider value={{ isDark, themeMode, setThemeMode, cycleThemeMode }}>
      <MuiThemeProvider theme={muiTheme()}>
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
