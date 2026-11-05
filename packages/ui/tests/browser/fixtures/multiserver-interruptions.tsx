import { For } from "solid-js"
import { OpenCode } from "@opencode/client"
import { render } from "solid-js/web"
import toast, { Toaster } from "solid-toast"
import { InterruptionDock } from "../../../src/components/interruption-dock"
import { I18nProvider } from "../../../src/lib/i18n"
import { ConfigProvider, setThemePreference } from "../../../src/stores/preferences"
import { ThemeProvider } from "../../../src/lib/theme"
import { addInstance, updateInstance, instances, getPermissionQueue, sendFormReply, sendFormCancel, sendPermissionResponse } from "../../../src/stores/instances"
import { getFormQueue } from "../../../src/stores/forms"
import { setSessions } from "../../../src/stores/session-state"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverEvents } from "../../../src/lib/server-events"
import { serverApi } from "../../../src/lib/api-client"
import { getToastHistory } from "../../../src/lib/notifications"
import { initialServerCapabilities } from "../../../../server/src/opencode/servers/capabilities"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

let clock = 100, hold = false, fail = false, release: (() => void) | undefined
const verificationFixture = new URLSearchParams(location.search).has("verification")
let readState = "pending", readFail = false, readHold = false, releaseRead: (() => void) | undefined
const calls: any[] = [], forbidden: string[] = []
const screenNotices: any[] = []
const customToast = toast.custom
toast.custom = (...args) => { screenNotices.push(true); return customToast(...args) }
// This fixture drives real attributed dispatch, with no backend transport racing its synthetic frames.
;(serverEvents as any).connectGeneration++
;(serverEvents as any).clearReconnectTimer()
;(serverEvents as any).connection?.disconnect()
;(serverEvents as any).connection = null
;(serverEvents as any).watchdog.setConnected(false)
const directory = "/工作/100% ready/" + "long-native-directory-".repeat(5)
const ids = ["local-shared", "A", "B"]
const sourceGenerations = new Map(ids.map(id => [id, 1]))
const nativeGenerations = new Map(ids.map(id => [id, 1]))
let liveBoundary = 500
const correlations = new Map<string, { status: string; source: { serverId: string; generation: number; connectionGeneration: number }; liveGeneration: number }>()
const dispatch = (events: any[]) => (serverEvents as any).dispatchBatch(events)
const status = (id: string, state: string) => {
  const previous = correlations.get(id)
  const current = previous?.status === state && previous.source.generation === sourceGenerations.get(id)
    && previous.source.connectionGeneration === nativeGenerations.get(id) ? previous : {
      status: state, source: { serverId: id, generation: sourceGenerations.get(id)!, connectionGeneration: nativeGenerations.get(id)! }, liveGeneration: ++liveBoundary,
    }
  correlations.set(id, current)
  dispatch([{ type: "instance.eventStatus", instanceId: id, ...current }])
}
function emit(id: string, type: string, data: any) {
  const { source, liveGeneration } = correlations.get(id)!
  dispatch([{ type: "instance.event", instanceId: id, source, liveGeneration, event: {
    id: `event-${++clock}`, created: clock, type, location: { directory }, data: { sessionID: "same-session", ...data },
  } }])
}
const form = (title = "Question", global = false) => ({ id: "same-form", sessionID: global ? "global" : "same-session", title,
  metadata: { kind: "question" }, fields: [{ key: "answer", type: "string", title: "Answer", required: true }], state: { status: "pending" } })
const ask = (id: string, title?: string, global = false) => emit(id, "form.created", { sessionID: global ? "global" : "same-session", form: form(title, global) })
const denyRead = (name: string) => async () => { forbidden.push(name); throw new Error(`Forbidden ${name}`) }
serverApi.getPendingRequests = denyRead("snapshot")
serverApi.fetchPermissionReceipts = denyRead("receipts")
serverApi.fetchWorktrees = denyRead("worktrees")
let uiState: Record<string, unknown> = {}
serverApi.fetchStateOwner = async () => uiState as any
serverApi.patchStateOwner = async (_owner, patch) => { uiState = { ...uiState, ...patch as object }; return uiState as any }
await applyUiSettings({ locale: new URLSearchParams(location.search).has("rtl") ? "he" : "en" })
for (const id of ids) {
  const legacyClient: any = {
    session: { active: async () => ({}), get: async () => ({ id: "same-session", location: { directory } }),
      list: async () => ({ data: [], cursor: {} }), inbox: { list: async () => ({ data: [] }) },
      form: { reply: async (input: any, options: any) => {
        calls.push({ id, method: "reply", input, options })
        if (hold) await new Promise<void>(resolve => { release = resolve })
        if (fail) throw new Error("Owned ordinary failure")
      }, cancel: async (input: any, options: any) => { calls.push({ id, method: "cancel", input, options }) } },
    },
    permission: { reply: async (input: any, options: any) => {
      calls.push({ id, method: "permission", input, options })
      if (hold) await new Promise<void>(resolve => { release = resolve })
      if (fail) throw new Error("Owned ordinary failure")
    },
      request: { list: denyRead("permission list") }, get: denyRead("permission get") },
    form: { list: denyRead("form list") },
  }
  const client = verificationFixture ? OpenCode.make({ baseUrl: `http://127.0.0.1/${id}`, fetch: async (input, init) => {
    const path = new URL(String(input)).pathname, method = init?.method ?? "GET"
    if (!/\/api\/session\/(same-session|global)\/form\/same-form(?:\/reply)?$/.test(path)) {
      forbidden.push(path); throw new Error("Forbidden verification read")
    }
    calls.push({ id, method: method === "GET" ? "get" : "reply", headers: Object.fromEntries(new Headers(init?.headers)) })
    const state = readState, failing = readFail
    if (method === "GET" && readHold) await new Promise<void>(resolve => { releaseRead = resolve })
    if (method !== "GET" && hold) await new Promise<void>(resolve => { release = resolve })
    if (method === "GET" && failing) return Response.json({ _tag: "FormNotFoundError", id: "same-form", message: "PRIVATE-SENTINEL" }, { status: 404 })
    if (method === "GET") return Response.json({ data: { ...form(), state: { status: state } } })
    return new Response(null, { status: 204 })
  } }) : legacyClient
  sdkManager["clients"].set(`${id}:/workspaces/${id}/instance`, client)
  const capabilities = initialServerCapabilities({ id, kind: id === "local-shared" ? "local-shared" : "explicit", label: id, origin: "https://example.invalid" } as any, 1)
  for (const capability of ["questions", "permissions", "events"] as const) capabilities.features[capability] = { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" }
  addInstance({ id, folder: directory, binding: { serverId: id, directory }, capabilities,
    proxyPath: `/workspaces/${id}/instance`, status: "ready", client, port: 0, pid: 0 }, serverEvents.captureTransportAuthority())
  setSessions(previous => new Map(previous).set(id, new Map([["same-session", { id: "same-session", instanceId: id, title: "Same session", parentId: null,
    location: { directory }, status: "idle", time: { created: 1, updated: 1 } } as any]])))
  status(id, "connected")
  ask(id)
}
serverApi.fetchWorkspaces = async () => [...instances().values()].map(item => ({ ...item, path: item.folder })) as any
function App() {
  return <main style={{ display: "flex", "flex-direction": "column", width: "100%", gap: "1rem" }}>
    <Toaster />
    <For each={ids}>{id => <article data-owner={id} style={{ display: "flex", "flex-direction": "column", "min-width": "0", height: "620px" }}>
      <h1>{id}</h1>
      <InterruptionDock instanceId={id} sessionId="same-session" />
    </article>}</For>
  </main>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><App /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  calls, forbidden, screenNotices, ask, notifications: getToastHistory, theme: setThemePreference,
  disconnect: (id: string) => status(id, "disconnected"),
  reconnect: (id: string) => { sourceGenerations.set(id, sourceGenerations.get(id)! + 1); status(id, "connected") },
  readStatus: (state: string) => { readState = state },
  readFail: (value: boolean) => { readFail = value },
  readHold: () => { readHold = true },
  readRelease: () => { readHold = false; releaseRead?.() },
  backendDisconnect: () => (serverEvents as any).emitTransportStatus("disconnected"),
  backendRestore: () => { for (const handler of (serverEvents as any).openHandlers) handler() },
  dismissNotices: () => toast.remove(),
  permission: (id: string) => emit(id, "permission.asked", { id: "same-permission", action: "read", resources: ["owned"] }),
  rotate: (id: string) => {
    nativeGenerations.set(id, 2)
    updateInstance(id, { capabilities: { ...instances().get(id)!.capabilities!, generation: 2 } }, serverEvents.captureTransportAuthority())
    sourceGenerations.set(id, sourceGenerations.get(id)! + 1)
    status(id, "connected")
  },
  rotateLate: (id: string) => {
    nativeGenerations.set(id, 2)
    sourceGenerations.set(id, sourceGenerations.get(id)! + 1)
    status(id, "connected")
    ask(id, "Fresh before metadata")
  },
  metadata: (id: string) => updateInstance(id, { capabilities: { ...instances().get(id)!.capabilities!, generation: 2 } }, serverEvents.captureTransportAuthority()),
  rebind: (id: string) => updateInstance(id, { binding: { serverId: "B", directory } }),
  hold: () => { hold = true }, release: () => { hold = false; release?.() },
  fail: () => { fail = true },
  rawReply: (id: string) => sendFormReply(id, "same-form", { answer: "synthetic" }).then(() => "sent", () => "refused"),
  rawCancel: (id: string) => sendFormCancel(id, "same-form").then(() => "sent", () => "refused"),
  rawPermission: (id: string) => sendPermissionResponse(id, "same-session", "same-permission", "once").then(() => "sent", () => "refused"),
  snapshot: () => ids.map(id => ({ id, forms: getFormQueue(id).length, permissions: getPermissionQueue(id).length })),
}
