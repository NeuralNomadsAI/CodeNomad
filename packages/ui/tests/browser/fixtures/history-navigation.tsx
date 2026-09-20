import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import SessionView from "../../../src/components/session/session-view"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { setSessionSearchOpen } from "../../../src/stores/session-search"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverApi } from "../../../src/lib/api-client"
import { addInstance } from "../../../src/stores/instances"
import { sessions, setSessions, setActiveSession, setProviders } from "../../../src/stores/session-state"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages, loadLatestMessageWindow } from "../../../src/stores/session-api"
import { navigationMessage, navigationMessageId, mixedNavigationMessage } from "./history-navigation-data"
import "../../../src/index.css"

const instanceId = "navigation", sessionId = "s", count = 1500
const makeMessage = location.search.includes("mixed") ? mixedNavigationMessage : navigationMessage
const model = { providerID: "fixture", id: "fixture" }
const assistantId = "msg_streaming"
let nativeLists = 0, time = 10000, live = "", streaming = false
let config = { settings: { locale: "en", showMessageTimeline: true } }
serverApi.fetchConfigOwner = async () => config as any
serverApi.patchConfigOwner = async (_owner, patch: any) => (config = { ...config, ...patch, settings: { ...config.settings, ...patch.settings } }) as any
serverApi.fetchStateOwner = async () => ({} as any)
const emit = (type: string, data: any) => (sseManager as any).handleEvent(instanceId, {
  id: `event_${++time}`, type, created: time, location: { directory: "/fixture" }, data: { sessionID: sessionId, ...data },
})
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async () => ({ id: sessionId, title: "Long navigation", location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
  },
  model: { default: async () => ({ data: model }) },
  message: { list: async ({ cursor, limit = 200, order }: any = {}) => {
    nativeLists++
    if (order === 'asc' || cursor?.startsWith('asc:')) {
      const start = cursor ? Number(cursor.slice(4)) : 0
      const end = Math.min(count, start + limit)
      return { data: Array.from({ length: end - start }, (_, index) => makeMessage(start + index)),
        cursor: end < count ? { next: `asc:${end}` } : {} }
    }
    const end = cursor ? Number(cursor) : count
    const start = Math.max(0, end - limit + (streaming && !cursor ? 1 : 0))
    const data: any[] = Array.from({ length: end - start }, (_, index) => makeMessage(start + index))
    if (streaming && !cursor) data.push({ id: assistantId, type: "assistant", agent: "build", model, time: { created: 10000 }, content: [{ type: "text", text: live }] })
    return { data: data.reverse(), cursor: start ? { next: String(start) } : {} }
  } },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "Long navigation", agent: "build", model: { providerId: "fixture", modelId: "fixture" },
  status: "idle", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true, version: "1", projectID: "p", location: { directory: "/fixture" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
}]])))
setProviders(previous => new Map(previous).set(instanceId, [{ id: "fixture", name: "Fixture", models: [{ id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } }] }]))
setActiveSession(instanceId, sessionId)
const [visible, setVisible] = createSignal(true)
const store = messageStoreBus.getOrCreate(instanceId)
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Show when={visible()}>
  <SessionView sessionId={sessionId} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder="/fixture" escapeInDebounce={false} isActive={true} />
</Show></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  id: navigationMessageId,
  tools: (showTimelineTools: boolean) => updatePreferences({ showTimelineTools }),
  status: (status: 'idle' | 'working') => setSessions(previous => {
    const next = new Map(previous), group = new Map(next.get(instanceId)!)
    group.set(sessionId, { ...group.get(sessionId)!, status })
    next.set(instanceId, group)
    return next
  }),
  openSearch: () => { updatePreferences({ locale: "en" }); setSessionSearchOpen(instanceId, sessionId, true) },
  reload: () => loadMessages(instanceId, sessionId, { force: true }),
  latest: () => loadLatestMessageWindow(instanceId, sessionId),
  switchAway: () => { setActiveSession(instanceId, "other"); setVisible(false) },
  return: () => { setActiveSession(instanceId, sessionId); setVisible(true) },
  stream: (delta: string) => {
    if (!streaming) { streaming = true; emit("session.step.started", { assistantMessageID: assistantId, agent: "build", model }); emit("session.text.started", { assistantMessageID: assistantId }) }
    live += delta
    emit("session.text.delta", { assistantMessageID: assistantId, ordinal: 0, delta })
  },
  snapshot: () => ({ nativeLists, ids: store.getSessionMessageIds(sessionId), window: store.getMessageWindow(sessionId),
    scroll: store.getScrollSnapshot(sessionId, "message-stream"), model: sessions().get(instanceId)?.get(sessionId)?.model }),
}
