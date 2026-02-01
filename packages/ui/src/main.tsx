import { render } from "solid-js/web"
import App from "./App"
import { ThemeProvider } from "./lib/theme"
import { ConfigProvider } from "./stores/preferences"
import { InstanceConfigProvider } from "./stores/instance-config"
import { runtimeEnv } from "./lib/runtime-env"
import { initTestInjection } from "./lib/test-injection"
import "./index.css"
import "@git-diff-view/solid/styles/diff-view-pure.css"

initTestInjection()

const root = document.getElementById("root")

if (!root) {
  throw new Error("Root element not found")
}

if (typeof document !== "undefined") {
  document.documentElement.dataset.runtimeHost = runtimeEnv.host
  document.documentElement.dataset.runtimePlatform = runtimeEnv.platform
}

render(
  () => (
    <ConfigProvider>
      <InstanceConfigProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </InstanceConfigProvider>
    </ConfigProvider>
  ),
  root,
)
