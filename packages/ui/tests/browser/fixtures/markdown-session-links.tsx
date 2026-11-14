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
import { ensureWorktreesLoaded } from "../../../src/stores/worktrees"
import { createBackendClient, registerBackendClient } from "../../../src/lib/backend-client"
import { backendEvents } from "../../../src/lib/backend-events"
import { getSessionPreview } from "../../../src/stores/session-previews"
import { alertDialogState } from "../../../src/stores/alerts"

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
// Independently moved child: its own location wins, never the parent's.
const childSession = { ...session, id: "ses_child", parentId: "ses_link", title: "Child", location: { directory: "/fixture-root/wt-b" } } satisfies Session
setSessions(previous => new Map(previous).set(id, new Map(
  [[session.id, session], [subSession.id, subSession], [childSession.id, childSession]])))
// A populated inventory holding only the root checkout must not capture
// sessions whose directories it does not contain.
if (new URLSearchParams(location.search).has("inventory")) {
  serverApi.fetchWorktrees = async () => ({ gitAvailable: true, worktrees: [
    { slug: "root", kind: "root" as const, directory: scope }] }) as never
  await ensureWorktreesLoaded(id)
}
await getServerMeta()

const remoteCalls: string[] = []
const remoteDetach = new Map<string, () => void>()
let rejectPending: (() => void) | undefined
let holdPreview = false
for (const owner of ["A", "B"]) {
  const backend = createBackendClient({ id: owner, baseUrl: `http://${owner.toLowerCase()}.invalid`,
    fetcher: async () => Response.json({}) })
  registerBackendClient(backend)
  remoteDetach.set(owner, backendEvents.attach(owner, backend.events))
  backend.api.fetchServerMeta = async () => ({ previewsUnavailable: owner === "B" }) as never
  backend.api.createPreviewCapability = async input => {
    remoteCalls.push(owner)
    if (holdPreview) await new Promise<void>((_, reject) => { rejectPending = () => reject(new Error("stale preview")) })
    return { token: `token-${owner}`, sessionId: input.sessionId, targetUrl: input.url,
      proxyUrl: `/previews/token-${owner}/`, createdAt: "", capability: `cap-${owner.toLowerCase()}`,
      contentUrl: `http://cap-${owner.toLowerCase()}.preview.localhost:1234/previews/token-${owner}/` }
  }
  const remoteId = `${owner}~${id}`
  addInstance({ id: remoteId, backendId: owner, folder: scope, port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions(previous => new Map(previous).set(remoteId, new Map([[session.id, { ...session, instanceId: remoteId }]])))
}

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
    <div id="child-root">
      <Markdown part={{ id: "child-part", type: "text", version: 0, text: "See [readme](./README.md)." }}
        instanceId={id} sessionId="ses_child" />
    </div>
    {["A", "B"].map(owner => <div id={`remote-${owner}`}>
      <Markdown part={{ id: `remote-${owner}`, type: "text", text: "[readme](./README.md) and [local](http://localhost:3000/x)." }}
        instanceId={`${owner}~${id}`} sessionId="ses_link" />
    </div>)}
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
  remoteCalls: () => [...remoteCalls],
  remoteTarget: (owner: string) => getFilePreview(`${owner}~${id}`)?.path ?? null,
  previewMode: (owner: string) => getSessionPreview("ses_link", owner === "local" ? scope : `${owner}~${scope}`)?.mode ?? null,
  detach: (owner: string) => remoteDetach.get(owner)?.(),
  holdPreview: () => { holdPreview = true },
  pending: () => Boolean(rejectPending),
  rejectPending: () => rejectPending?.(),
  alert: () => alertDialogState(),
}
