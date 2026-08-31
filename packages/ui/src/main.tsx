import { render } from "solid-js/web"
import type { Component } from "solid-js"
import { PreferencesWindow } from "./components/preferences-window"
import { ThemeProvider } from "./lib/theme"
import { ConfigProvider } from "./stores/preferences"
import { InstanceConfigProvider } from "./stores/instance-config"
import { runtimeEnv } from "./lib/runtime-env"
import { I18nProvider, preloadLocaleMessages } from "./lib/i18n"
import { storage } from "./lib/storage"
import { applyColorScheme, normalizeColorScheme } from "./lib/theme-scheme"
import { usesClientState } from "./lib/runtime-env"
import "./index.css"
import "@git-diff-view/solid/styles/diff-view-pure.css"

const root = document.getElementById("root")

if (!root) {
  throw new Error("Root element not found")
}

const mount = root

if (typeof document !== "undefined") {
  document.documentElement.dataset.runtimeHost = runtimeEnv.host
  document.documentElement.dataset.runtimePlatform = runtimeEnv.platform
}

async function bootstrap() {
  let RootComponent: Component = PreferencesWindow
  if (usesClientState(runtimeEnv)) {
    const [{ initializeClientState }, appModule] = await Promise.all([
      import("./stores/client-state"),
      import("./App"),
    ])
    await initializeClientState()
    RootComponent = appModule.default
  }

  if (typeof document !== "undefined") {
    try {
      const [uiConfig, uiState] = await Promise.all([
        storage.loadConfigOwner("ui"),
        storage.loadStateOwner("ui"),
      ])
      const theme = (uiState as any)?.theme ?? (uiConfig as any)?.theme
      const colorScheme = (uiState as any)?.colorScheme ?? (uiConfig as any)?.colorScheme
      const locale = typeof (uiConfig as any)?.settings?.locale === "string" ? (uiConfig as any).settings.locale : undefined

      applyColorScheme(normalizeColorScheme(colorScheme, theme), {
        systemDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      })

      await preloadLocaleMessages(locale)
    } catch {
      applyColorScheme(normalizeColorScheme("system"), {
        systemDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
      })
      await preloadLocaleMessages()
    }
  }

  render(
    () => (
      <ConfigProvider>
        <InstanceConfigProvider>
          <I18nProvider>
            <ThemeProvider>
              <RootComponent />
            </ThemeProvider>
          </I18nProvider>
        </InstanceConfigProvider>
      </ConfigProvider>
    ),
    mount,
  )
}

void bootstrap()
