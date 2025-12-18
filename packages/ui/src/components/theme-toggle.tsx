import { type Component } from "solid-js"
import { Sun, Moon } from "lucide-solid"
import { useTheme } from "../lib/theme"

interface ThemeToggleProps {
  compact?: boolean
}

const ThemeToggle: Component<ThemeToggleProps> = (props) => {
  const { isDark, toggleTheme } = useTheme()

  return (
    <button
      type="button"
      class={`theme-toggle ${props.compact ? "theme-toggle--compact" : ""}`}
      onClick={toggleTheme}
      aria-label={isDark() ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark() ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark() ? (
        <Sun class="theme-toggle-icon" />
      ) : (
        <Moon class="theme-toggle-icon" />
      )}
    </button>
  )
}

export default ThemeToggle
