import { createMemo, type Component } from "solid-js"
import { Laptop, Moon, Sun } from "lucide-solid"
import { useI18n } from "../lib/i18n"
import { useTheme } from "../lib/theme"

interface ThemeModeToggleProps {
  class?: string
}

export const ThemeModeToggle: Component<ThemeModeToggleProps> = (props) => {
  const { t } = useI18n()
  const { themeMode, cycleThemeMode } = useTheme()

  const modeLabel = () => {
    const mode = themeMode()
    if (mode === "system") return t("theme.mode.system")
    if (mode === "light") return t("theme.mode.light")
    return t("theme.mode.dark")
  }

  const icon = createMemo(() => {
    const mode = themeMode()
    if (mode === "system") return <Laptop class="w-4 h-4" />
    if (mode === "light") return <Sun class="w-4 h-4" />
    return <Moon class="w-4 h-4" />
  })

  return (
    <button
      type="button"
      class={props.class ?? "new-tab-button"}
      onClick={cycleThemeMode}
      aria-label={t("theme.toggle.ariaLabel", { mode: modeLabel() })}
      title={t("theme.toggle.title", { mode: modeLabel() })}
    >
      {icon()}
    </button>
  )
}
