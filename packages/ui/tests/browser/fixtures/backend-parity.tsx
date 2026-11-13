import { render } from "solid-js/web"
import { Toaster } from "solid-toast"
import { ImageSettingsCard } from "../../../src/components/settings/image-settings-card"
import { WebSearchSettingsCard } from "../../../src/components/settings/websearch-settings-card"
import { ConfigProvider, preferencesForBackend } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { createServerApi } from "../../../src/lib/api-client"
import { createBackendClient, localBackend, registerBackendClient } from "../../../src/lib/backend-client"
import { backendEvents } from "../../../src/lib/backend-events"
import { sseManager } from "../../../src/lib/sse-manager"
import { getToastHistory, runToastAction } from "../../../src/lib/notifications"
import { addInstance, activeInstanceId } from "../../../src/stores/instances"
import { activeSessionId, setProviders, setSessions } from "../../../src/stores/session-state"
import { resolveImagesConversation } from "../../../src/stores/images-conversation"
import "../../../src/stores/sessions"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

const calls: { owner: string; path: string; method: string; body?: any }[] = []
const violations: string[] = []
const outcomes: { owner: string; status: string }[] = []
const pending: (() => void)[] = []
let hold = false, fail = false
const state = new Map<string, { generation: boolean; mediaStorage: boolean; global: string | false | null; project: string | false | null }>()
function transport(owner: string) {
  state.set(owner, { generation: true, mediaStorage: false, global: null, project: null })
  return async (input: any, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname, method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ owner, path, method, body })
    const data = state.get(owner)!
    if (hold && owner === "A") await new Promise<void>(resolve => pending.push(resolve))
    if (fail && owner === "A" && method !== "GET") return new Response("{}", { status: 503 })
    if (method === "PUT") {
      if (body.generation !== undefined) data.generation = body.generation
      if (body.mediaStorage !== undefined) data.mediaStorage = body.mediaStorage
      if (body.scope) data[body.scope as "global" | "project"] = body.provider
      return new Response(null, { status: 204 })
    }
    const location = { directory: `/${owner}` }
    const result = path.endsWith("images-conversation") ? { status: "found", sessionID: "ses_homonym", created: false }
      : path.endsWith("image-settings") ? { location, generation: { global: data.generation, effective: data.generation, models: [] },
          mediaStorage: { global: data.mediaStorage, effective: data.mediaStorage } }
      : path.endsWith("websearch-settings") ? { location, effective: data.project ?? data.global,
          scopes: ["global", "project"].map(scope => ({ scope, path: `/${owner}/${scope}.json`, selection: data[scope as "global" | "project"] })) }
      : {}
    return Response.json(result)
  }
}
// The local API is a sentinel: even a remote key stripped before transport must
// fail through its remote directory. Other backends use real HTTP adapters.
const localApi = createServerApi({ id: "local", url: path => new URL(path, location.origin).href, fetch: transport("local") } as any)
for (const method of ["getImageSettings", "setImageSettings", "getWebSearchSettings", "setWebSearchSettings", "imagesConversation"] as const) {
  ;(localBackend.api[method] as any) = (...args: any[]) => {
    const directory = typeof args[1] === "string" ? args[1] : args[1]?.directory ?? args[1]?.location?.directory
    if (args[0].includes("~") || directory !== "/local") {
      violations.push(method); throw new Error(`Remote request reached local API: ${method}`)
    }
    return (localApi[method] as any)(...args)
  }
}
await applyUiSettings({ locale: "en", notificationRouting: {
  needsInput: { screen: true, history: true, system: false },
  sessionDone: { screen: true, history: true, system: false },
  sessions: { screen: true, history: true, system: false },
} as never })
localBackend.api.patchStateOwner = async (_owner, patch) => patch as any
const host = preferencesForBackend("local")
await host.ensureLoaded()
for (const id of ["A", "B"]) await host.saveRemoteServerProfile({ id, name: `Server ${id}`, baseUrl: `http://${id.toLowerCase()}.invalid` })

const remotes = new Map<string, ReturnType<typeof createBackendClient>>()
const detach = new Map<string, () => void>()
for (const owner of ["local", "A", "B"]) {
  const backend = owner === "local" ? localBackend : createBackendClient({ id: owner, baseUrl: `http://${owner.toLowerCase()}.invalid`, fetcher: transport(owner) as typeof fetch })
  if (owner !== "local") { registerBackendClient(backend); remotes.set(owner, backend); detach.set(owner, backendEvents.attach(owner, backend.events)) }
  const id = owner === "local" ? "same" : `${owner}~same`
  const client: any = {
    agent: { list: async () => ({ data: [{ id: "design", name: "Design", mode: "primary" }] }), get: async () => ({ data: { id: "design" } }) },
    model: { default: async () => ({ data: { providerID: "test", id: "model" } }) },
    websearch: { providers: async () => ({ data: [{ id: "search", name: `Search ${owner}` }] }) },
    integration: { list: async () => ({ data: [] }) },
    session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) } },
  }
  ;(backend.sdk as any).clients.set(`${id}:/workspaces/same/instance`, client)
  addInstance({ id, ...(owner !== "local" ? { backendId: owner } : {}), folder: `/${owner}`, port: 0, pid: 0, proxyPath: "", status: "ready", client })
  setSessions(previous => new Map(previous).set(id, new Map([["ses_homonym", {
    id: "ses_homonym", instanceId: id, title: "Same session", parentId: null, status: "working", agent: "design",
    location: { directory: `/${owner}` }, model: { providerId: "test", modelId: "model" }, time: { created: 1, updated: 1 },
  } as any]])))
  setProviders(previous => new Map(previous).set(id, [{ id: "test", name: "Test", defaultModelId: "model",
    models: [{ id: "model", providerId: "test", name: "Model", limit: { context: 1000, output: 100 }, cost: { input: 0, output: 0 } }] }]))
}
render(() => <ConfigProvider><I18nProvider>
  {["local", "A", "B"].map(owner => {
    const id = owner === "local" ? "same" : `${owner}~same`
    return <section data-owner={owner}>
      <ImageSettingsCard instanceId={id} location={{ directory: `/${owner}` }} />
      <WebSearchSettingsCard instanceId={id} location={{ directory: `/${owner}` }} />
      <button onClick={() => void resolveImagesConversation(id, "new")
        .then(result => outcomes.push({ owner, status: result.status }))
        .catch(() => outcomes.push({ owner, status: "failed" }))}>New Images {owner}</button>
    </section>
  })}
  <Toaster />
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
let retainedAction: any
;(window as any).parity = {
  calls, violations, outcomes, get pending() { return pending.length },
  hold: () => { hold = true }, fail: () => { fail = true },
  release: () => { hold = false; pending.splice(0).forEach(resolve => resolve()) },
  detach: (owner = "A") => detach.get(owner)?.(),
  reattach: (owner = "A") => detach.set(owner, backendEvents.attach(owner, remotes.get(owner)!.events)),
  notify: (owner: string, type = "session.compaction.ended", seq = 1) => {
    const id = owner === "local" ? "same" : `${owner}~same`
    ;(sseManager as any).handleEvent(id, { id: `evt_${seq}`, type, created: seq,
      durable: { aggregateID: "ses_homonym", seq, version: 1 },
      location: { directory: `/${owner}` }, data: type === "session.compaction.ended"
        ? { sessionID: "ses_homonym", reason: "auto", text: "Summary" } : { sessionID: "ses_homonym" } })
  },
  history: () => getToastHistory().map(({ title, message, action }) => ({ title, message, target: action?.target })),
  action: async (owner: string) => {
    const action = getToastHistory().find(item => item.action?.target?.backendId === owner)?.action
    if (action) { retainedAction ??= action; await runToastAction(action) }
  },
  staleAction: () => retainedAction && runToastAction(retainedAction),
  selected: () => ({ instance: activeInstanceId(), sessionA: activeSessionId().get("A~same"), sessionB: activeSessionId().get("B~same") }),
}
