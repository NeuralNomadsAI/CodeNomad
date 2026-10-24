import { render } from "solid-js/web"
import { SessionPreviewView } from "../../../src/components/session-preview-view"
import { openSessionPreview } from "../../../src/stores/session-previews"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"

serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.createPreview = async ({ sessionId, url }: { sessionId: string; url: string }) => ({
  token: `fixture-${sessionId}`,
  sessionId,
  targetUrl: url,
  proxyUrl: `/previews/fixture-${sessionId}${new URL(url).pathname}`,
  createdAt: new Date().toISOString(),
}) as any
serverApi.deletePreview = async () => undefined as any

void (async () => {
  const loopback = await openSessionPreview("session-loopback", "http://localhost:3000/", "/fixture-a")
  const external = await openSessionPreview("session-external", "https://example.com/", "/fixture-b")
  render(
    () => (
      <ConfigProvider>
        <I18nProvider>
          <div id="loopback-preview-root" style={{ width: "800px", height: "300px" }}>
            <SessionPreviewView preview={loopback} onInsertComment={() => {}} />
          </div>
          <div id="external-preview-root" style={{ width: "800px", height: "300px" }}>
            <SessionPreviewView preview={external} onInsertComment={() => {}} />
          </div>
        </I18nProvider>
      </ConfigProvider>
    ),
    document.getElementById("root")!,
  )
})()
