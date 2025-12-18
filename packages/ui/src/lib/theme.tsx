import { createContext, createEffect, createMemo, createSignal, onMount, useContext, type JSX } from "solid-js"
import { createTheme, ThemeProvider as MuiThemeProvider } from "@suid/material/styles"
import CssBaseline from "@suid/material/CssBaseline"
import { useConfig } from "../stores/preferences"

interface ThemeContextValue {
  isDark: () => boolean
  toggleTheme: () => void
  setTheme: (dark: boolean) => void
}

const ThemeContext = createContext<ThemeContextValue>()

function applyTheme(dark: boolean) {
  if (typeof document === "undefined") return
  if (dark) {
    document.documentElement.setAttribute("data-theme", "dark")
    return
  }

  document.documentElement.removeAttribute("data-theme")
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
  const { themePreference, setThemePreference } = useConfig()
  const [isDark, setIsDarkSignal] = createSignal(true)

  const resolveDarkTheme = (): boolean => {
    const pref = themePreference()
    if (pref === "light") return false
    if (pref === "dark") return true
    // "system" preference - use media query
    return mediaQuery?.matches ?? true
  }

  const applyResolvedTheme = () => {
    const dark = resolveDarkTheme()
    setIsDarkSignal(dark)
    applyTheme(dark)
  }

  createEffect(() => {
    applyResolvedTheme()
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

  const setTheme = (dark: boolean) => {
    setThemePreference(dark ? "dark" : "light")
  }

  const toggleTheme = () => {
    setTheme(!isDark())
  }

  const muiTheme = createMemo(() => {
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
        MuiDrawer: {
          styleOverrides: {
            paper: {
              backgroundColor: paletteColors.backgroundPaper,
              color: paletteColors.textPrimary,
            },
          },
        },
        MuiAppBar: {
          styleOverrides: {
            root: {
              backgroundColor: paletteColors.backgroundPaper,
              color: paletteColors.textPrimary,
              boxShadow: "none",
              borderBottom: `1px solid ${paletteColors.divider}`,
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
    <ThemeContext.Provider value={{ isDark, toggleTheme, setTheme }}>
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
