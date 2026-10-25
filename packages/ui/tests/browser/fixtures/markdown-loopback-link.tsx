import { render } from "solid-js/web"
import { Markdown } from "../../../src/components/markdown"
import { addInstance } from "../../../src/stores/instances"
import { getServerMeta } from "../../../src/lib/server-meta"
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

const resolvePreviews = async (meta: Record<string, unknown>) => {
  const original = serverApi.fetchServerMeta
  serverApi.fetchServerMeta = async () => meta as any
  try {
    await getServerMeta(true)
  } finally {
    serverApi.fetchServerMeta = original
  }
}

;(window as any).fixture = {
  created: () => created,
  resolvePreviewsAvailable: () => resolvePreviews({}),
  setPreviewsUnavailable: () => resolvePreviews({ previewsUnavailable: true }),
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
