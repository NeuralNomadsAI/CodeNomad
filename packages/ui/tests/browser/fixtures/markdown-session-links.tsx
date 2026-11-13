// The real Markdown component with a session context: plain clicks on links
// that point inside the session's worktree must open the file reader, loopback
// links must keep opening the session preview, and everything else keeps
// default link behavior.
import { render } from "solid-js/web"
import { Markdown } from "../../../src/components/markdown"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, tGlobal } from "../../../src/lib/i18n"
import { addInstance } from "../../../src/stores/instances"
import { setSessions } from "../../../src/stores/session-state"
import type { Session } from "../../../src/types/session"
import { getFilePreview } from "../../../src/stores/files-preview"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { getServerMeta } from "../../../src/lib/server-meta"

const id = "markdown-session-links", scope = "/fixture-root"
const client = sdkManager.createClient(id, `/workspaces/${id}/instance`, () => true)
const createPreviewCalls: Array<{ sessionId: string; url: string }> = []
serverApi.createPreview = async (input: { sessionId: string; url: string }) => {
  createPreviewCalls.push({ sessionId: input.sessionId, url: input.url })
  return { token: "t", targetUrl: input.url, proxyUrl: "/preview" } as never
}
serverApi.fetchServerMeta = async () => ({ previewsUnavailable: false }) as never
addInstance({ id, folder: scope, port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client,
  metadata: { project: { id: "project", directory: scope, canonical: scope } } })
const session = { id: "ses_link", instanceId: id, parentId: null, title: "Links", agent: "build",
  model: { providerId: "private", modelId: "private" }, projectID: "project", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, status: "idle", runtimeStatusKnown: true,
  location: { directory: scope }, time: { created: 1, updated: 1 } } satisfies Session
// Lives in a worktree the (empty) inventory does not know: links must resolve
// against this session's directory, not the instance folder.
const subSession = { ...session, id: "ses_sub", title: "Sub", location: { directory: "/fixture-root/wt-a" } } satisfies Session
setSessions(previous => new Map(previous).set(id, new Map([[session.id, session], [subSession.id, subSession]])))
await getServerMeta()

let renderCount = 0
const clicks: Array<{ href: string; prevented: boolean }> = []
// Registered before render so it sits above the component's own listener:
// by the time this bubble listener runs, the component has claimed or not.
window.addEventListener("click", (event) => {
  const anchor = (event.target as Element | null)?.closest?.("a")
  clicks.push({ href: anchor?.getAttribute("href") ?? "", prevented: event.defaultPrevented })
  event.preventDefault()
})

const dispose = render(() => <ConfigProvider><I18nProvider>
  <div>
    <div id="main-root">
      <Markdown part={{ id: "part", type: "text", version: 0,
          text: "See [readme](./README.md), the [guide](docs/guide.md#intro), [app](/fixture-root/src/app.ts), [escape](../outside.md), [web](https://example.com/x) and [local](http://localhost:3000/x)." }}
        instanceId={id} sessionId="ses_link" onRendered={() => { renderCount++ }} />
    </div>
    <div id="sub-root">
      <Markdown part={{ id: "sub-part", type: "text", version: 0, text: "See [readme](./README.md)." }}
        instanceId={id} sessionId="ses_sub" />
    </div>
  </div>
</I18nProvider></ConfigProvider>, document.getElementById("root")!)

;(window as any).fixture = {
  target: () => getFilePreview(id)?.path ?? null,
  targetFull: () => { const target = getFilePreview(id); return target ? { path: target.path, directory: target.directory } : null },
  previews: () => [...createPreviewCalls],
  clicks: () => [...clicks],
  rendered: () => renderCount,
  label: (key: string) => tGlobal(key),
  title: (selector: string) => document.querySelector(selector)?.getAttribute("title") ?? null,
  dispose,
}
