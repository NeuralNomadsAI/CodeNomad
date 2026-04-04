import { render } from "solid-js/web"
import App from "./App"
import { ThemeProvider } from "./lib/theme"
import { ConfigProvider } from "./stores/preferences"
import { InstanceConfigProvider } from "./stores/instance-config"
import { runtimeEnv } from "./lib/runtime-env"
import { I18nProvider, preloadLocaleMessages } from "./lib/i18n"
import { storage } from "./lib/storage"
import { beginPerfTrace, getPerfTrace, markPerf, measurePerf } from "./lib/perf"
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
  const existingTrace = getPerfTrace()
  if (existingTrace.some((entry) => entry.name === "loading.screen.mounted")) {
    markPerf("ui.main.entry")
    markPerf("ui.bootstrap.start")
  } else {
    beginPerfTrace("ui.main.entry", { source: "direct-ui-entry" })
    markPerf("ui.bootstrap.start")
  }

  if (typeof document !== "undefined") {
    // renderer/index.html currently seeds a dark theme to avoid a white flash.
    // Reset to CSS defaults immediately so the first render matches system
    // (and then refine once persisted config loads).
    document.documentElement.removeAttribute("data-theme")

    try {
      const uiConfig = await storage.loadConfigOwner("ui")
      const theme = (uiConfig as any)?.theme
      const locale = typeof (uiConfig as any)?.settings?.locale === "string" ? (uiConfig as any).settings.locale : undefined

      if (theme === "light" || theme === "dark") {
        document.documentElement.setAttribute("data-theme", theme)
      } else {
        document.documentElement.removeAttribute("data-theme")
      }

      await preloadLocaleMessages(locale)
    } catch {
      // If config fails to load, fall back to CSS defaults.
      await preloadLocaleMessages()
    }
  }

  markPerf("ui.bootstrap.config.ready")

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

  markPerf("ui.render.scheduled")
  measurePerf("ui.bootstrap_to_render_schedule", "ui.bootstrap.start", "ui.render.scheduled")

  queueMicrotask(() => {
    markPerf("ui.app.mounted")
    measurePerf("ui.bootstrap_to_app_mount", "ui.bootstrap.start", "ui.app.mounted")

    if (typeof requestAnimationFrame === "function") {
      requestAnimationFrame(() => {
        markPerf("ui.app.first-frame")
        measurePerf("ui.bootstrap_to_first_frame", "ui.bootstrap.start", "ui.app.first-frame")
      })
    }
  })
}

void bootstrap()
