import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js"
import { render } from "solid-js/web"
import MessageSection from "../../../src/components/message-section"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { sessions, setSessions, setActiveSession, getSessionMessagesLoadError } from "../../../src/stores/session-state"
import { loadMessages, loadMessageAnchor, loadMoreMessages, loadLatestMessageWindow, loadOldestMessageWindow, loadNewerMessageWindow, hasMoreMessages, getMessageNextCursor } from "../../../src/stores/session-api"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { applyOpenCodeDataEvent } from "../../../src/stores/opencode-data"
import { setSessionSearchOpen } from "../../../src/stores/session-search"
import { historyWindowCursor } from "../../../src/stores/history-window"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

let config: any = { settings: { locale: location.search.includes("rtl") ? "he" : "en", showMessageTimeline: true } }
serverApi.fetchConfigOwner = async () => config
serverApi.patchConfigOwner = async (_owner, patch: any) => (config = { ...config, ...patch, settings: { ...config.settings, ...patch.settings } })
serverApi.fetchStateOwner = async () => ({} as any)
await applyUiSettings(config.settings)
const model = { providerID: "p", id: "m" }, id = (n: number) => `msg_${String(n).padStart(4, "0")}`
const calls: any[] = [], tokens = new Map<string, { order: string; start: number }>()
let pause: Promise<void> | undefined, release: (() => void) | undefined, sequence = 0
const message = (i: number) => i === 450 && location.search.includes("technical")
  ? { id: id(i), type: "assistant", agent: "build", model, time: { created: 451, completed: 452 }, content: [
    { type: "reasoning", text: "Thinking about the synthetic result", time: { created: 451, completed: 452 } },
    ...[1, 2].map(n => ({ type: "tool", id: `shell-${n}`, name: "shell", time: { created: 451, completed: 452 },
      state: { status: "completed", input: { command: "fixture" }, content: [{ type: "text", text: "Synthetic native tool output" }] } })),
    { type: "text", text: "Native completed answer with technical cleanup" },
  ] }
  : { id: id(i), type: "user", text: `Passage ${i} ${i === 450 ? "Long text ".repeat(20) : ""}`, time: { created: i + 1 } }
const client: any = { session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) } },
  message: { list: async (input: any) => {
    calls.push(input)
    if (pause) { const hold = pause; pause = undefined; await hold }
    const { order, start } = input.cursor ? tokens.get(input.cursor)! : { order: input.order ?? "desc", start: 0 }
    const rows = Array.from({ length: 451 }, (_, i) => order === "asc" ? i : 450 - i).slice(start, start + input.limit)
    const token = (offset: number, direction: string) => {
      const value = `${order}:${offset}:${direction}:${start}`; tokens.set(value, { order, start: offset }); return value
    }
    return { data: rows.map(message), cursor: rows.length ? {
      next: token(start + rows.length, "next"), previous: token(Math.max(0, start - 200), "previous"),
    } : {} }
  } } }
const instanceId = "native-history", sessionId = "s"
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/Work/", binding: { serverId: "A", directory: "/Work/" }, status: "ready", client, port: 0, pid: 0, proxyPath: "" })
setSessions(new Map([[instanceId, new Map([[sessionId, { id: sessionId, instanceId, parentId: null, title: "Native history",
  agent: "build", model: { providerId: "p", modelId: "m" }, status: "idle", runtimeStatusKnown: true,
  location: { directory: "/Work/" }, projectID: "p", time: { created: 1, updated: 1 } } as any]])]]))
setActiveInstanceId(instanceId); setActiveSession(instanceId, sessionId)
const store = messageStoreBus.getOrCreate(instanceId), [visible, setVisible] = createSignal(true)
function View() {
  createEffect(() => {
    const controller = new AbortController()
    void untrack(() => loadMessages(instanceId, sessionId, { signal: controller.signal })).catch(() => {})
    onCleanup(() => controller.abort())
  })
  return <MessageSection instanceId={instanceId} sessionId={sessionId} isActive={true}
    loadError={getSessionMessagesLoadError(instanceId, sessionId)} hasMoreMessages={hasMoreMessages(instanceId, sessionId)}
    getMessageHistoryCursor={() => getMessageNextCursor(instanceId, sessionId)}
    onLoadMoreMessages={signal => loadMoreMessages(instanceId, sessionId, signal)}
    onLoadNewerMessages={signal => loadNewerMessageWindow(instanceId, sessionId, signal)}
    onLoadLatestMessages={signal => loadLatestMessageWindow(instanceId, sessionId, signal)}
    onLoadOldestMessages={signal => loadOldestMessageWindow(instanceId, sessionId, signal)}
    onLoadMessageAnchor={(anchor, signal) => loadMessageAnchor(instanceId, sessionId, anchor, signal)} />
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Show when={visible()}><View /></Show></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  oldest: () => loadOldestMessageWindow(instanceId, sessionId), latest: () => loadLatestMessageWindow(instanceId, sessionId),
  older: () => loadMoreMessages(instanceId, sessionId), newer: () => loadNewerMessageWindow(instanceId, sessionId),
  hide: () => setVisible(false), show: () => setVisible(true),
  saveMissing: () => { store.setScrollSnapshot(sessionId, "message-stream", { scrollTop: 42, atBottom: false,
    anchorKey: "msg_saved_elsewhere", windowIsLatest: false, windowCursor: historyWindowCursor({ kind: "around", messageID: "msg_saved_elsewhere" }) }) },
  search: () => setSessionSearchOpen(instanceId, sessionId, true),
  hold: () => { pause = new Promise<void>(done => { release = done }) }, release: () => release?.(),
  stream: () => { for (const [type, data] of [
    ["session.step.started", { assistantMessageID: id(451), agent: "build", model }],
    ["session.text.started", { assistantMessageID: id(451) }],
    ["session.text.delta", { assistantMessageID: id(451), ordinal: 0, delta: "LIVE NEW MESSAGE" }],
  ] as const) applyOpenCodeDataEvent(instanceId, "/Work/", { id: `evt_${++sequence}`, type, created: sequence,
    location: { directory: "/Work/" }, data: { sessionID: sessionId, ...data } } as any) },
  snapshot: () => ({ calls, ids: store.getSessionMessageIds(sessionId), scroll: store.getScrollSnapshot(sessionId, "message-stream"),
    error: getSessionMessagesLoadError(instanceId, sessionId), session: sessions().get(instanceId)?.get(sessionId) }),
}
