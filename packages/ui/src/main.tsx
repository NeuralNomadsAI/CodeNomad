import { render } from "solid-js/web"
import App from "./App"
import TransportBench from "./transport-bench"
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
const bootParams = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : new URLSearchParams()
const isPerf242TransportBenchBuild = import.meta.env.VITE_PERF242_TRANSPORT_BENCH === "1"
const isPerf242TransportBench =
  isPerf242TransportBenchBuild
  && bootParams.get("perf242TransportBench") === "1"

if (typeof document !== "undefined") {
  document.documentElement.dataset.runtimeHost = runtimeEnv.host
  document.documentElement.dataset.runtimePlatform = runtimeEnv.platform

  if (isPerf242TransportBench) {
    const payload = {
      stage: "frontend-bootstrap",
      host: runtimeEnv.host,
      search: window.location.search,
    }

    void fetch("/api/perf-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "include",
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {
      console.info("[perf242] frontend-bootstrap", {
        host: runtimeEnv.host,
        search: window.location.search,
      })
    })
  }
}

async function bootstrap() {
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

  render(
    () => (
      <ConfigProvider>
        <InstanceConfigProvider>
          <I18nProvider>
            <ThemeProvider>
              <App />
              {isPerf242TransportBench ? <TransportBench /> : null}
            </ThemeProvider>
          </I18nProvider>
        </InstanceConfigProvider>
      </ConfigProvider>
    ),
    mount,
  )
}

void bootstrap()
