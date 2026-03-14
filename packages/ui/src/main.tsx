import { render } from "solid-js/web"
import App from "./App"
import { ThemeProvider } from "./lib/theme"
import { ConfigProvider } from "./stores/preferences"
import { InstanceConfigProvider } from "./stores/instance-config"
import { runtimeEnv } from "./lib/runtime-env"
import { I18nProvider, preloadLocaleMessages } from "./lib/i18n"
import { storage } from "./lib/storage"
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
  if (typeof document !== "undefined") {
    // renderer/index.html currently seeds a dark theme to avoid a white flash.
    // Reset to CSS defaults immediately so the first render matches system
    // (and then refine once persisted config loads).
    document.documentElement.removeAttribute("data-theme")

    try {
      const uiConfig = await storage.loadConfigOwner("ui")
      const theme = (uiConfig as any)?.theme ?? "system"
      const locale = (uiConfig as any)?.settings?.locale

      if (theme === "system") {
        document.documentElement.removeAttribute("data-theme")
      } else {
        document.documentElement.setAttribute("data-theme", theme)
      }

      await preloadLocaleMessages(typeof locale === "string" ? locale : undefined)
    } catch {
      // If config fails to load, fall back to CSS defaults.
      await preloadLocaleMessages(undefined)
    }
  }

  render(
    () => (
      <ConfigProvider>
        <InstanceConfigProvider>
          <I18nProvider>
            <ThemeProvider>
              <App />
            </ThemeProvider>
          </I18nProvider>
        </InstanceConfigProvider>
      </ConfigProvider>
    ),
    mount,
  )
}

void bootstrap()
