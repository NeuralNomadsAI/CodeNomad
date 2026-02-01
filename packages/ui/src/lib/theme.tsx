import { createContext, createEffect, createSignal, onMount, useContext, type JSX } from "solid-js"
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

  return (
    <ThemeContext.Provider value={{ isDark, toggleTheme, setTheme }}>
      {props.children}
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
