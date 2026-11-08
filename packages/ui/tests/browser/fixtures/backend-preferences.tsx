import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { Toaster } from "solid-toast"
import type { BackendClient } from "../../../src/lib/backend-client"
import "../../../src/index.css"
import { applyMergePatch } from "../../../../server/src/settings/merge-patch"

const { serverApi } = await import("../../../src/lib/api-client")
const brief = (name: string, id: string) => ({ version: 1, id, name, objective: name, notes: "", template: "custom" })
const hostBrief = brief("Host brief", "00000000-0000-0000-0000-000000000001")
const hostConfig = { settings: { locale: "en", missionModels: [hostBrief], missionProfileDefaults: [], modelVisibility: {} } }
const hostState = { models: { favorites: [{ providerId: "p", modelId: "host" }], favoritesOnly: false } }
const localWrites: unknown[] = []
serverApi.fetchConfigOwner = (async owner => owner === "ui" ? hostConfig : {}) as any
serverApi.fetchStateOwner = (async () => hostState) as any
serverApi.patchConfigOwner = (async (_owner, patch) => { localWrites.push(patch); return hostConfig }) as any
serverApi.patchStateOwner = (async (_owner, patch) => { localWrites.push(patch); return hostState }) as any
const { backends, createBackendClient } = await import("../../../src/lib/backend-client")
const { backendEvents } = await import("../../../src/lib/backend-events")
const records: Record<string, { config: any; state: any; writes: unknown[]; wait?: Promise<void> }> = {
  a: { config: { settings: { missionModels: [brief("A brief", "00000000-0000-0000-0000-000000000002")], missionProfileDefaults: [], modelVisibility: {} } },
    state: { models: { favorites: [{ providerId: "p", modelId: "a" }], favoritesOnly: false } }, writes: [] },
  b: { config: {}, state: {}, writes: [] },
}
const owners = new Map<string, { backend: BackendClient; detach: () => void; signal: AbortSignal }>()
for (const [id, record] of Object.entries(records)) {
  const backend = createBackendClient({ id, baseUrl: `https://${id}.invalid`, fetcher: async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)), family = url.pathname.split("/")[3], owner = url.pathname.split("/")[4]
    if (owner !== "ui") return Response.json({})
    const target = family === "config" ? "config" : "state"
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)), patch = url.search ? body.patch : body
      record.writes.push({ target, patch })
      await record.wait
      record[target] = applyMergePatch(record[target], patch)
    }
    return Response.json(record[target])
  } })
  ;(backends as Map<string, BackendClient>).set(id, backend)
  const detach = backendEvents.attach(id, backend.events)
  owners.set(id, { backend, detach, signal: backendEvents.signal(id)! })
}
const [{ ConfigProvider, preferencesForBackend }, { I18nProvider }, { default: ModelSelector },
  { MissionBriefPicker, MissionBriefSave }, { setProviders }] = await Promise.all([
  import("../../../src/stores/preferences"), import("../../../src/lib/i18n"), import("../../../src/components/model-selector"),
  import("../../../src/components/mission-model-library"), import("../../../src/stores/session-state"),
])
await Promise.all([preferencesForBackend("local").ensureLoaded(), preferencesForBackend("a").ensureLoaded(), preferencesForBackend("b").ensureLoaded()])
const { getToastHistory } = await import("../../../src/lib/notifications")
const models = ["host", "a", "b"].map(id => ({ id, name: `Model ${id}`, providerId: "p" }))
setProviders(new Map(["a", "b"].map(id => [`${id}~same`, [{ id: "p", name: "P", models }]])))
function Panel(props: { id: string }) {
  const [current, setCurrent] = createSignal({ providerId: "p", modelId: props.id === "a" ? "a" : "host" })
  return <section data-owner={props.id}>
    <ModelSelector instanceId={`${props.id}~same`} sessionId="s" currentModel={current()} onModelChange={async model => { setCurrent(model) }} />
    <MissionBriefPicker instanceId={`${props.id}~same`} onUse={() => {}} />
    <MissionBriefSave instanceId={`${props.id}~same`} draft={() => ({ objective: "New B brief", notes: "", template: "custom" })} />
  </section>
}
function SharedSave() {
  const [owner, setOwner] = createSignal("a")
  return <section data-shared-save><button onClick={() => setOwner("b")}>B owner</button>
    <MissionBriefSave instanceId={`${owner()}~same`} draft={() => ({ objective: "Shared brief", notes: "", template: "custom" })} />
  </section>
}
render(() => <ConfigProvider><I18nProvider><Toaster /><Panel id="a" /><Panel id="b" /><SharedSave /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
const releases = new Map<string, () => void>()
;(window as any).fixture = { records, localWrites,
  history: getToastHistory,
  favorite(id: string, modelId: string) { preferencesForBackend(id).toggleFavoriteModelPreference({ providerId: "p", modelId }) },
  revoke(id: string, dispose: boolean) {
    const owner = owners.get(id)!
    if (dispose) owner.backend.events.dispose(); else owner.detach()
    return { aborted: owner.signal.aborted, attached: !!backendEvents.signal(id) }
  },
  hold(id: string) { records[id].wait = new Promise(resolve => releases.set(id, resolve)) },
  release(id: string) { releases.get(id)?.(); records[id].wait = undefined },
}
