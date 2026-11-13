import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import SessionList from "../../../src/components/session-list"
import SessionView from "../../../src/components/session/session-view"
import AlertDialog from "../../../src/components/alert-dialog"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverApi } from "../../../src/lib/api-client"
import { addInstance } from "../../../src/stores/instances"
import { sessions, setActiveSession, setProviders, setSessionPage, setSessions, activeSessionId } from "../../../src/stores/session-state"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages } from "../../../src/stores/session-api"
import { buildRecordDisplayData } from "../../../src/stores/message-v2/record-display-cache"
import { buildSessionThreadsFromMap } from "../../../src/stores/session-tree"
import type { Session } from "../../../src/types/session"
import "../../../src/index.css"

// PROBE FIXTURE (temporary, performance evidence gathering): real session list,
// conversation view and native event dispatcher over a synthetic long-context
// transcript that lives in a worktree. Only HTTP is fake.
const id = "session-delete-scale"
const model = { providerID: "fixture", id: "fixture" }
const worktreeDirectory = "/repo/.codenomad/worktrees/wt-a"
let time = Date.now()

function make(sessionId: string, updated: number, directory: string, parentId: string | null = null): Session {
  return {
    id: sessionId, title: sessionId, instanceId: id, parentId, location: { directory }, status: "idle", agent: "build",
    retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true, version: "1",
    projectID: "fixture", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated, idle: 10 }, model: { providerId: "fixture", modelId: "fixture" },
  } as Session
}

// Synthetic transcripts: an agentic session alternates user prompts with
// assistant answers; long ones carry big text bodies.
const transcripts = new Map<string, any[]>()
function seedTranscript(sessionId: string, count: number, textSize: number, withTools = false) {
  const rows: any[] = []
  for (let index = 0; index < count; index++) {
    const role = index % 2 === 0 ? "user" : "assistant"
    if (role === "user") {
      rows.push({
        id: `${sessionId}_msg_${String(index).padStart(5, "0")}`, type: "user",
        text: `${sessionId} prompt ${index} ${"probe prompt ".repeat(textSize / 24)}`,
        time: { created: index + 1, completed: index + 1 },
      })
    } else {
      const content: any[] = [{ type: "text", text: `${sessionId} ${index} ${"probe text ".repeat(textSize / 12)}` }]
      if (withTools) {
        content.push({
          type: "tool", id: `${sessionId}_tool_${index}_a`, name: "bash", time: { created: index + 1, completed: index + 1 },
          state: { status: "completed", input: { command: `echo probe ${index}` },
            content: [{ type: "text", text: "probe output\n".repeat(120) }], time: { created: index + 1, completed: index + 1 } },
        })
        content.push({
          type: "tool", id: `${sessionId}_tool_${index}_b`, name: "read", time: { created: index + 1, completed: index + 1 },
          state: { status: "completed", input: { filePath: `src/file-${index}.ts` },
            content: [{ type: "text", text: "export const probe = 1\n".repeat(80) }], time: { created: index + 1, completed: index + 1 } },
        })
      }
      rows.push({
        id: `${sessionId}_msg_${String(index).padStart(5, "0")}`, type: "assistant", agent: "build", model,
        time: { created: index + 1, completed: index + 1 },
        content,
      })
    }
  }
  transcripts.set(sessionId, rows)
}
seedTranscript("long-context", Number(new URLSearchParams(location.search).get("messages") ?? 2000), 800, true)
for (let index = 0; index < 20; index++) seedTranscript(`sub-${index}`, 120, 300, true)
for (let index = 0; index < 6; index++) seedTranscript(`sibling-${index}`, 30, 300)

const rows = new Map<string, Session>([
  ["long-context", { ...make("long-context", 9, worktreeDirectory), title: "long-context-a-very-long-mission-conversation-title-that-needs-overflow-actions" }],
  ...Array.from({ length: 20 }, (_, index) => [`sub-${index}`, make(`sub-${index}`, 8 - index * 0.01, worktreeDirectory, "long-context")] as const),
  ...Array.from({ length: 6 }, (_, index) => [`sibling-${index}`, make(`sibling-${index}`, 7 - index * 0.01, "/repo")] as const),
])
const extraRows = Number(new URLSearchParams(location.search).get("rows") ?? 0)
if (extraRows > 0) {
  for (let index = 0; index < extraRows; index++) {
    const sessionId = `bulk-${index}`
    seedTranscript(sessionId, 10, 200)
    rows.set(sessionId, make(sessionId, 6 - index * 0.001, index % 2 === 0 ? worktreeDirectory : "/repo"))
  }
}
const roots = ["long-context", ...Array.from({ length: 6 }, (_, index) => `sibling-${index}`),
  ...Array.from({ length: extraRows }, (_, index) => `bulk-${index}`)]

const client: any = {
  session: {
    active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async ({ sessionID }: any) => sessions().get(id)?.get(sessionID),
    remove: async () => ({}),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
  },
  model: { default: async () => ({ data: model }) },
  permission: { list: async () => [] },
  message: {
    list: async ({ sessionID, cursor, limit = 200, order }: any = {}) => {
      const rows = transcripts.get(sessionID) ?? []
      if (order === "asc" || cursor?.startsWith("asc:")) {
        const offset = Number(cursor?.slice(4) ?? 0)
        return { data: rows.slice(offset, offset + limit), cursor: {
          previous: "asc-boundary",
          ...(offset + limit < rows.length ? { next: `asc:${offset + limit}` } : {}),
        } }
      }
      const offset = Number(cursor ?? 0), reversed = rows.slice().reverse()
      return { data: reversed.slice(offset, offset + limit), cursor: offset + limit < reversed.length ? { next: String(offset + limit) } : {} }
    },
  },
}
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.fetchWorktrees = async () => ({
  isGitRepo: true,
  worktrees: [
    { slug: "root", directory: "/repo", kind: "root" as const },
    { slug: "wt-a", directory: worktreeDirectory, kind: "worktree" as const, branch: "wt-a", removable: true },
  ],
})
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client })
setSessions(previous => new Map(previous).set(id, new Map(rows)))
setProviders(prev => new Map(prev).set(id, [{ id: "fixture", name: "Fixture", models: [{ id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 200000, output: 4000 }, cost: { input: 0, output: 0 } }] }]))
setSessionPage(id, [...roots], false, true)
setActiveSession(id, "long-context")
// The viewed session follows the store's active session, as the real shell
// does; user row clicks in this fixture set the store directly too.
const [active, setActive] = createSignal<string | null>("long-context")
createEffect(() => {
  const current = activeSessionId().get(id)
  if (current && current !== active()) setActive(current)
})
const store = messageStoreBus.getOrCreate(id)

function Fixture() {
  const threads = createMemo(() => buildSessionThreadsFromMap(sessions().get(id)!, roots))
  return <ConfigProvider><I18nProvider><ThemeProvider><div style={{ display: "flex", height: "720px" }}>
    <AlertDialog />
    <div style={{ width: "440px", display: "flex" }}>
      <SessionList instanceId={id} threads={threads()} activeSessionId={active()}
        onSelect={value => { setActive(value); setActiveSession(id, value) }}
        onNew={() => {}} enableFilterBar={false} showHeader={false} showFooter={false} />
    </div>
    <div style={{ flex: "1", display: "flex", "min-width": "0" }}>
      <Show when={active()}>
        <SessionView sessionId={active()!} activeSessions={sessions().get(id)!} instanceId={id} instanceFolder="/repo" escapeInDebounce={false} isActive={true} />
      </Show>
    </div>
  </div></ThemeProvider></I18nProvider></ConfigProvider>
}
render(() => <Fixture />, document.getElementById("root")!)

;(window as any).fixture = {
  activeId: () => active(),
  loaded: (sessionId: string) => store.getSessionMessageIds(sessionId).length,
  residentMessages: () => Object.keys((store as any).state?.messages ?? {}).length,
  select: (sessionId: string) => { setActive(sessionId); setActiveSession(id, sessionId) },
  load: async (sessionId: string) => { await loadMessages(id, sessionId, { force: true }) },
  /** Direct store hydration without HTTP, for scale that paging would make slow. */
  hydrateMany: (sessionId: string, count: number) => {
    store.hydrateMessages(sessionId, Array.from({ length: count }, (_, index) => ({
      id: `${sessionId}_bulk_${String(index).padStart(6, "0")}`, sessionId, role: index % 2 === 0 ? "user" : "assistant",
      status: "complete" as const, createdAt: index + 1, updatedAt: index + 1,
      parts: [{ type: "text" as const, text: `bulk ${index} ${"hydration ".repeat(8)}` }],
    })))
  },
  /** Direct hydration of assistant messages whose tool parts carry large outputs. */
  hydrateTools: (sessionId: string, outputs: number[]) => {
    store.hydrateMessages(sessionId, outputs.map((size, index) => ({
      id: `${sessionId}_tool_msg_${index}`, sessionId, role: "assistant" as const, status: "complete" as const,
      parts: [{ type: "tool" as any, id: `${sessionId}_tool_${index}`, tool: "bash", callID: `${sessionId}_tool_${index}`,
        sessionID: sessionId, messageID: `${sessionId}_tool_msg_${index}`, time: { created: index + 1, completed: index + 1 },
        state: { status: "completed", input: { command: "cat" }, output: "x".repeat(size), time: { created: index + 1, completed: index + 1 } } }],
    })))
  },
  /** Materializes the record display cache, which references tool state through store proxies. */
  materializeDisplay: (sessionId: string) => {
    for (const messageId of store.getSessionMessageIds(sessionId)) {
      buildRecordDisplayData(id, store.getMessage(messageId)!)
    }
  },
  estimate: (sessionId: string) => store.estimateSessionRetainedBytes(sessionId),
  /** Synchronous duration of one native session.deleted dispatch. */
  emitDeleteMeasured: (sessionId: string) => {
    const started = performance.now()
    ;(sseManager as any).handleEvent(id, {
      id: `evt_del_${++time}`, type: "session.deleted", created: time, location: { directory: worktreeDirectory },
      durable: { aggregateID: sessionId, seq: time, version: 2 },
      data: { sessionID: sessionId },
    })
    return Math.round((performance.now() - started) * 100) / 100
  },
  emitDelete: (sessionIds: string[]) => {
    for (const sessionId of sessionIds) {
      ;(sseManager as any).handleEvent(id, {
        id: `evt_del_${++time}`, type: "session.deleted", created: time, location: { directory: worktreeDirectory },
        durable: { aggregateID: sessionId, seq: time, version: 2 },
        data: { sessionID: sessionId },
      })
    }
  },
}
