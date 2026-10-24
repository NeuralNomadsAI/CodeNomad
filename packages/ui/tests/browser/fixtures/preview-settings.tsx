import { render } from "solid-js/web"
import "../../../src/index.css"

// The preferences store loads itself as soon as it is imported, so the API
// doubles have to be installed before any store module is pulled in.
const { serverApi } = await import("../../../src/lib/api-client")

const preview = {
  originMode: "opaque",
  customOrigin: "",
  sandbox: { forms: true, modals: true, popups: true, downloads: true },
  features: {
    camera: false,
    microphone: false,
    clipboardRead: false,
    clipboardWrite: false,
    geolocation: false,
    fullscreen: false,
  },
}

let serverConfig: any = { preview }
const patches: Array<{ owner: string; patch: any }> = []

serverApi.fetchConfigOwner = async (owner: string) => (
  owner === "server" ? serverConfig : { settings: { locale: "en" } }
) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.patchConfigOwner = async (owner: string, patch: any) => {
  patches.push({ owner, patch })
  if (owner === "server") serverConfig = { ...serverConfig, ...patch }
  return serverConfig
}

const { PreviewSettingsSection } = await import("../../../src/components/settings/preview-settings-section")
const { default: AlertDialog } = await import("../../../src/components/alert-dialog")
const { ConfigProvider, useConfig } = await import("../../../src/stores/preferences")
const { I18nProvider } = await import("../../../src/lib/i18n")
const { ThemeProvider } = await import("../../../src/lib/theme")

const Fixture = () => {
  const config = useConfig()
  return (
    <>
      <div id="fixture-status" data-config-loaded={config.isLoaded() ? "true" : "false"} />
      <main style={{ width: "min(900px, 100%)" }}>
        <PreviewSettingsSection />
      </main>
      <AlertDialog />
    </>
  )
}

render(
  () => (
    <ConfigProvider>
      <I18nProvider>
        <ThemeProvider>
          <Fixture />
        </ThemeProvider>
      </I18nProvider>
    </ConfigProvider>
  ),
  document.getElementById("root")!,
)

;(window as any).fixture = {
  patches,
  config: () => serverConfig,
}
