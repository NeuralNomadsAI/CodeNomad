import { type Component } from "solid-js"
import { Sun, Moon } from "lucide-solid"
import { useTheme } from "../lib/theme"
import { cn } from "../lib/cn"

interface ThemeToggleProps {
  compact?: boolean
}

const ThemeToggle: Component<ThemeToggleProps> = (props) => {
  const { isDark, toggleTheme } = useTheme()

  return (
    <button
      type="button"
      class={cn(
        "flex items-center justify-center rounded-md border border-border bg-secondary text-muted-foreground cursor-pointer transition-all duration-200",
        "hover:bg-accent hover:text-foreground hover:border-info",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        props.compact ? "w-7 h-7" : "w-8 h-8",
      )}
      onClick={toggleTheme}
      aria-label={isDark() ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark() ? "Switch to light mode" : "Switch to dark mode"}
    >
      {isDark() ? (
        <Sun class={cn(props.compact ? "w-3.5 h-3.5" : "w-4 h-4")} />
      ) : (
        <Moon class={cn(props.compact ? "w-3.5 h-3.5" : "w-4 h-4")} />
      )}
    </button>
  )
}

export default ThemeToggle
