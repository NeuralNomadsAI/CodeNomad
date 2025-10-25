import { createContext, createSignal, useContext, onMount, type JSX } from "solid-js"
import { storage } from "./storage"

interface ThemeContextValue {
  isDark: () => boolean
  toggleTheme: () => void
  setTheme: (dark: boolean) => void
}

const ThemeContext = createContext<ThemeContextValue>()

export function ThemeProvider(props: { children: JSX.Element }) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
  const [isDark, setIsDarkSignal] = createSignal(prefersDark)

  async function loadTheme() {
    try {
      const config = await storage.loadConfig()
      const savedTheme = (config as any).theme
      const initialDark = savedTheme ? savedTheme === "dark" : prefersDark
      setIsDarkSignal(initialDark)
    } catch (error) {
      console.warn("Failed to load theme from config:", error)
    }
  }

  async function saveTheme(dark: boolean) {
    try {
      const config = await storage.loadConfig()
      ;(config as any).theme = dark ? "dark" : "light"
      await storage.saveConfig(config)
    } catch (error) {
      console.warn("Failed to save theme to config:", error)
    }
  }

  onMount(() => {
    loadTheme()

    // Listen for config changes from other instances
    const unsubscribe = storage.onConfigChanged(() => {
      loadTheme()
    })

    return unsubscribe
  })

  const setTheme = (dark: boolean) => {
    setIsDarkSignal(dark)
    saveTheme(dark)
    if (dark) {
      document.documentElement.setAttribute("data-theme", "dark")
    } else {
      document.documentElement.removeAttribute("data-theme")
    }
  }

  const toggleTheme = () => {
    setTheme(!isDark())
  }

  return <ThemeContext.Provider value={{ isDark, toggleTheme, setTheme }}>{props.children}</ThemeContext.Provider>
}

export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider")
  }
  return context
}
