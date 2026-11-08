import { render } from "solid-js/web"
import { Markdown } from "../../../src/components/markdown"
import { addInstance } from "../../../src/stores/instances"
import { localBackend } from "../../../src/lib/backend-client"
import { backendEvents } from "../../../src/lib/backend-events"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"

serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any

const created: Array<{ sessionId: string; url: string }> = []
serverApi.createPreview = async (input: { sessionId: string; url: string }) => {
  created.push(input)
  return { token: `fixture-${input.sessionId}`, sessionId: input.sessionId, targetUrl: input.url,
    proxyUrl: `/previews/fixture-${input.sessionId}/`, createdAt: new Date().toISOString() } as any
}
serverApi.deletePreview = async () => undefined as any

addInstance({ id: "instance", folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client: undefined as never })

const refresh = async () => {
  await localBackend.meta.getServerMeta(true, backendEvents.signalForInstance("instance"))
}

;(window as any).fixture = {
  created: () => created,
  refresh,
}

render(
  () => (
    <ConfigProvider>
      <I18nProvider>
        <div id="markdown-root">
          <Markdown
            part={{ id: "part-link-fixture", type: "text", text: "[dev](http://localhost:3000/) and [ext](https://example.com/) and [other](http://localhost:9999/) and [titled](http://localhost:9998/ \"Custom title\") and [dns](https://127.example.com/)" }}
            instanceId="instance"
            sessionId="session-link"
          />
        </div>
      </I18nProvider>
    </ConfigProvider>
  ),
  document.getElementById("root")!,
)
