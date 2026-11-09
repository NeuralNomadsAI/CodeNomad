import { createRoot } from "solid-js"
import { useAppSessionCapture } from "../../../src/lib/hooks/use-app-session-capture"
import { initializeClientState, loadedRestorableSession, flushClientState, clientStateIsPrimary } from "../../../src/stores/client-state"
import { decodeClientSnapshotV2 } from "../../../src/stores/client-state-partitions"
import { addInstance } from "../../../src/stores/instances"
import { attachInstanceTab, getInstanceAppTabId } from "../../../src/stores/app-tabs"
import {
  sessions, setSessions, withSession, setSessionDraftPrompt, onSessionDraftHydrated, getSessionDraftPrompt,
} from "../../../src/stores/session-state"
import { captureSessionCatalog } from "../../../src/stores/session-catalog-persistence"
import { hydrateSeenInterruptions } from "../../../src/stores/session-interruption-seen"
import { addAttachment } from "../../../src/stores/attachments"
import { createFileAttachment } from "../../../src/types/attachment"
import type { Session } from "../../../src/types/session"

await initializeClientState()
const ids = ["first", "second"]
for (const id of ids) {
  addInstance({ id, folder: `/synthetic/${id}`, port: 0, pid: 0, proxyPath: "", status: "ready" })
  attachInstanceTab(id)
  const rows = ["parent", "child"].map((sessionId): Session => ({
    id: sessionId, instanceId: id, title: sessionId, parentId: sessionId === "child" ? "parent" : null,
    projectID: "project", location: { directory: `/synthetic/${id}`, workspaceID: "workspace" },
    time: { created: 1, updated: 1, archived: 1, idle: 1, busy: 1 }, subpath: "subpath",
    agent: "build", model: { providerId: "provider", modelId: "model" }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, status: "working",
  }))
  setSessions(previous => new Map(previous).set(id, new Map(rows.map(row => [row.id, row]))))
}
let hydrated = 0
onSessionDraftHydrated(() => { hydrated++ })
let dispose!: () => void
const capture = createRoot(cleanup => { dispose = cleanup; return useAppSessionCapture() })
capture.start({ activeTabIndex: 0, tabs: ids.map(id => ({
  kind: "workspace", folder: `/synthetic/${id}`, drafts: { parent: `saved ${id}`, missing: "preserved" },
  attachments: {}, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
})) })
ids.forEach((id, index) => capture.recordRestoredTab(index, getInstanceAppTabId(id)))
await capture.ready
;(window as any).fixture = {
  hydrated: () => hydrated,
  state: loadedRestorableSession,
  flushStore: flushClientState,
  primary: clientStateIsPrimary,
  draftValue: (id: string, sessionId: string) => getSessionDraftPrompt(id, sessionId),
  catalog: () => captureSessionCatalog([...sessions().get("first")!.values()]),
  appear: () => setSessions(previous => {
    const rows = previous.get("first")!
    rows.set("missing", { ...structuredClone(rows.get("parent")!), id: "missing" })
    return new Map(previous)
  }),
  rename: (from: string, to: string) => setSessions(previous => {
    const rows = previous.get("first")!, row = rows.get(from)!
    rows.delete(from)
    rows.set(to, { ...row, id: to })
    return new Map(previous)
  }),
  mutate(path: string, value: unknown) {
    withSession("first", "parent", row => {
      const keys = path.split(".")
      const target = keys.slice(0, -1).reduce((value: any, key) => value[key], row)
      target[keys.at(-1)!] = value
    })
  },
  seen: () => hydrateSeenInterruptions("first", { parent: 1 }),
  usage(id = "first", sessionId = "parent") {
    withSession(id, sessionId, row => {
      row.cost++
      row.tokens.input++
      row.tokens.output++
      row.tokens.reasoning++
      row.tokens.cache.read++
      row.tokens.cache.write++
    })
  },
  change(field: string, id = "first", sessionId = "parent") {
    withSession(id, sessionId, row => {
      if (field === "title") row.title += "-changed"
      else if (field === "parent") row.parentId = null
      else if (field === "idle" || field === "working" || field === "compacting") row.status = field
      else throw new Error(`Unknown fixture change: ${field}`)
    })
  },
  draft: (value: string) => setSessionDraftPrompt("first", "parent", value),
  attach: () => addAttachment("first", "parent", createFileAttachment("/synthetic/note.txt", "note.txt")),
  remove: () => setSessions(previous => {
    previous.get("second")!.delete("child")
    return new Map(previous)
  }),
  decode: (payload: any) => decodeClientSnapshotV2(payload.snapshot, 1, async key => payload.partitions[key] ?? null),
  dispose,
}
