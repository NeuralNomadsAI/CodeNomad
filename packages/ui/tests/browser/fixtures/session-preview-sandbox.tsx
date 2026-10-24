import { createMemo, type Component } from "solid-js"
import { render } from "solid-js/web"
import "../../../src/index.css"

const query = new URLSearchParams(location.search)
const requestedMode = query.get("mode")
const originMode = requestedMode === "app" || requestedMode === "custom" ? requestedMode : "opaque"
const CUSTOM_ORIGIN = "https://preview.example.test"

// The preferences store loads itself as soon as it is imported, so the API
// doubles have to be installed before any store module is pulled in.
const { serverApi } = await import("../../../src/lib/api-client")
serverApi.fetchConfigOwner = async (owner: string) => (owner === "server"
  ? {
    preview: {
      originMode,
      customOrigin: CUSTOM_ORIGIN,
      sandbox: {
        forms: query.get("forms") !== "off",
        modals: true,
        popups: true,
        downloads: true,
      },
      features: {
        camera: query.get("camera") === "on",
        microphone: false,
        clipboardRead: false,
        clipboardWrite: false,
        geolocation: false,
        notifications: false,
        fullscreen: false,
      },
    },
  }
  : { settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.createPreview = async ({ sessionId, url }: { sessionId: string; url: string }) => ({
  token: `fixture-${sessionId}`,
  sessionId,
  targetUrl: url,
  proxyUrl: `/previews/fixture-${sessionId}${new URL(url).pathname}`,
  createdAt: new Date().toISOString(),
}) as any
serverApi.deletePreview = async () => undefined as any

const { SessionPreviewView } = await import("../../../src/components/session-preview-view")
const { openSessionPreview, sessionPreviews } = await import("../../../src/stores/session-previews")
const { ConfigProvider, useConfig } = await import("../../../src/stores/preferences")
const { I18nProvider } = await import("../../../src/lib/i18n")

function previewTarget(sessionId: string): string {
  for (const preview of sessionPreviews().values()) {
    if (preview.sessionId === sessionId) return preview.targetUrl
  }
  return ""
}

const loopback = await openSessionPreview("session-loopback", "http://localhost:3000/", "/fixture-a")
const external = await openSessionPreview("session-external", "https://example.com/", "/fixture-b")

const Fixture: Component = () => {
  const config = useConfig()
  const loopbackTarget = createMemo(() => previewTarget("session-loopback"))
  const externalTarget = createMemo(() => previewTarget("session-external"))
  return (
    <>
      <div id="fixture-status" data-config-loaded={config.isLoaded() ? "true" : "false"} />
      <div
        id="received-locations"
        data-loopback={loopbackTarget()}
        data-external={externalTarget()}
      />
      <div id="loopback-preview-root" style={{ width: "800px", height: "300px" }}>
        <SessionPreviewView preview={loopback} onInsertComment={() => {}} />
      </div>
      <div id="external-preview-root" style={{ width: "800px", height: "300px" }}>
        <SessionPreviewView preview={external} onInsertComment={() => {}} />
      </div>
    </>
  )
}

render(
  () => (
    <ConfigProvider>
      <I18nProvider>
        <Fixture />
      </I18nProvider>
    </ConfigProvider>
  ),
  document.getElementById("root")!,
)
