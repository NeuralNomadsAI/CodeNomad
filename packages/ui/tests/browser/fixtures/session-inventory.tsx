import { createMemo } from "solid-js"
import { render } from "solid-js/web"
import SessionList from "../../../src/components/session-list"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { fetchSessions } from "../../../src/stores/session-api"
import { getSessionThreads } from "../../../src/stores/session-state"
import { serverEvents } from "../../../src/lib/server-events"
import { initialServerCapabilities } from "../../../../server/src/opencode/servers/capabilities"
import "../../../src/index.css"

const id = "inventory-fixture", calls: unknown[] = []
// Continuation pages page automatically once the list end is visible: `fail`, `empty`
// (pages that never show a row) and `hold` (page held until released) shape them before mount.
const params = new URLSearchParams(location.search)
let fail = params.has("fail"), emptyPages = 0
const holds = { starts: 0, release: undefined as undefined | (() => void) }
const row = (id: string) => ({ id, title: id, location: { directory: "/work" }, projectID: "same", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } })
const client: any = { session: {
  active: async () => ({}),
  list: async (input: any) => {
    calls.push(input)
    if (input.search) return { data: [], cursor: { next: "more-search" } }
    if (input.cursor && params.has("hold")) {
      holds.starts++
      await new Promise<void>(resolve => { holds.release = resolve })
      if (params.get("hold") === "stale-error") throw new Error("retired page failure")
      return { data: [], cursor: {} }
    }
    if (input.cursor && params.has("empty")) return { data: [], cursor: { next: `empty-${++emptyPages}` } }
    if (input.cursor && fail) throw new Error("fixture offline")
    if (input.cursor === "next") return { data: [row("Older conversation")], cursor: { previous: "previous" } }
    return { data: [row("Newest conversation")], cursor: { next: "next" } }
  },
} }
const config = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => config as any
serverApi.patchConfigOwner = async (_owner, patch) => structuredClone(Object.assign(config, patch)) as any
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.fetchWorktrees = async () => { throw new Error("Explicit inventory must not read host worktrees") }
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
const capabilities = initialServerCapabilities({ id: "A", kind: "explicit", label: "A", origin: "https://example.invalid" }, 42)
for (const feature of ["sessions", "events"] as const) capabilities.features[feature] = { state: "available", reason: { code: "contractVerified" }, evidence: "nativeContract" }
addInstance({ id, binding: { serverId: "A", directory: "/work" }, folder: "/work", port: 0, pid: 0, capabilities,
  proxyPath: `/workspaces/${id}/instance`, status: "ready", client }, serverEvents.captureTransportAuthority())
function Fixture() {
  const threads = createMemo(() => getSessionThreads(id))
  return <ConfigProvider><I18nProvider><div style={{ width: "440px", height: "650px", display: "flex" }}>
    <SessionList instanceId={id} threads={threads()} activeSessionId={null} onSelect={() => {}} onNew={() => {}}
      enableFilterBar showHeader={false} showFooter={false} />
  </div></I18nProvider></ConfigProvider>
}
await fetchSessions(id)
render(() => <Fixture />, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = { calls, holds, fail: (value: boolean) => { fail = value }, moveUnqualified: () => {
  ;(serverEvents as any).dispatchBatch([
    { type: "instance.eventStatus", instanceId: id, status: "connecting", source: { serverId: "A", generation: 1 } },
    { type: "instance.event", instanceId: id, source: { serverId: "A", generation: 1 }, event: {
      id: "move", type: "session.moved", created: 2, location: { directory: "/work" },
      data: { sessionID: "Newest conversation", location: { directory: "/elsewhere" }, projectID: "same" },
    } },
  ])
}, move: () => {
  client.session.list = async (input: any) => { calls.push(input); return { data: [], cursor: { next: "after-move" } } }
  const source = { serverId: "A", generation: 1, connectionGeneration: 42 }
  ;(serverEvents as any).dispatchBatch([
    { type: "instance.eventStatus", instanceId: id, status: "connecting", source, liveGeneration: 1 },
    { type: "instance.eventStatus", instanceId: id, status: "connected", source, liveGeneration: 2 },
    { type: "instance.event", instanceId: id, source, liveGeneration: 2, event: {
      id: "move-current", type: "session.moved", created: 3, location: { directory: "/work" },
      data: { sessionID: "Newest conversation", location: { directory: "/elsewhere" }, projectID: "same" },
    } },
  ])
} }
