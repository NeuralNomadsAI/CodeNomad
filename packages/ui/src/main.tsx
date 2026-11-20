import { render } from "solid-js/web"
import type { Component } from "solid-js"
import { PreferencesWindow } from "./components/preferences-window"
import { ThemeProvider } from "./lib/theme"
import { ConfigProvider, ensureLoaded, getAppearancePalette, highContrastPreference, preferences, themePreference } from "./stores/preferences"
import { InstanceConfigProvider } from "./stores/instance-config"
import { runtimeEnv } from "./lib/runtime-env"
import { getLocaleDirection, I18nProvider, preloadLocaleMessages, type Locale } from "./lib/i18n"
import { applyColorScheme } from "./lib/theme-scheme"
import { effectiveAppearance } from "./lib/appearance-preferences"
import { effectiveHighContrast } from "./lib/high-contrast"
import { isNativeApplicationWindow, isTauriHost, isWebHost, usesClientState } from "./lib/runtime-env"
import { webTabTitle } from "./lib/web-tab-title"
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
  if (isWebHost()) document.title = webTabTitle(window.location)
}

async function bootstrap() {
  if (isTauriHost() && isNativeApplicationWindow()) {
    const { installExternalLinkClicks } = await import("./lib/native/external-link-clicks")
    installExternalLinkClicks(window)
  }
  const dictation = runtimeEnv.windowContext === "dictation"
  let RootComponent: Component = PreferencesWindow
  if (dictation) {
    RootComponent = (await import("./components/remote-dictation-window")).RemoteDictationWindow
  } else if (usesClientState(runtimeEnv)) {
    const [{ initializeClientState }, { runStartupStateCommand }, { installNativeStartupStateCommandHandler }, appModule] = await Promise.all([
      import("./stores/client-state"),
      import("./stores/client-state-owner-commands"),
      import("./lib/native/client-state"),
      import("./App"),
    ])
    await initializeClientState()
    await installNativeStartupStateCommandHandler(runStartupStateCommand).catch(() => undefined)
    const [{ installMemoryCleanupHandler }, { runMemoryCleanup }] = await Promise.all([
      import("./lib/native/memory-cleanup"), import("./stores/agent-memory-cleanup"),
    ])
    await installMemoryCleanupHandler(runMemoryCleanup)
    RootComponent = appModule.default
  }

  let locale: Locale = "en"
  if (typeof document !== "undefined") {
    const applyInitialTheme = () => {
      const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false
      applyColorScheme(getAppearancePalette(effectiveAppearance(themePreference(), systemDark)), {
        systemDark,
        highContrast: effectiveHighContrast(highContrastPreference(), window.matchMedia?.("(prefers-contrast: more)").matches),
      })
    }
    try {
      await ensureLoaded()
      applyInitialTheme()
      locale = await preloadLocaleMessages(preferences().locale)
    } catch {
      applyInitialTheme()
      locale = await preloadLocaleMessages()
    }
  }

  if (dictation) {
    document.documentElement.lang = locale
    document.documentElement.dir = getLocaleDirection(locale)
    render(() => <RootComponent />, mount)
    return
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
