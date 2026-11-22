import { render } from "solid-js/web"
import SessionView from "../../../src/components/session/session-view"
import { ConfigProvider, preferences, updatePreferences, type ToolCallExpansionPreset, type VisibilityPreference } from "../../../src/stores/preferences"
import { transcriptPresetPatch, transcriptVisibilityPatch, type TranscriptVisibilityRow } from "../../../src/components/transcript-visibility"
import { resolveToolVisibility } from "../../../src/components/tool-call/tool-presentation"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverApi } from "../../../src/lib/api-client"
import { addInstance } from "../../../src/stores/instances"
import { sessions, setSessions, setActiveSession, setProviders } from "../../../src/stores/session-state"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import "../../../src/index.css"

// Real SessionView over a native-shaped session: `message.list` and the
// session-history routes are answered by the test from a SQLite store read with
// the real server readers. Only HTTP is fake.
const instanceId = "sync", sessionId = "s"
const preset = (new URLSearchParams(location.search).get("preset") ?? "everything") as ToolCallExpansionPreset
const model = { providerID: "fixture", id: "fixture" }
let config = { settings: { locale: "en", showMessageTimeline: true, ...transcriptPresetPatch(preset) } }
serverApi.fetchConfigOwner = async () => config as any
serverApi.patchConfigOwner = async (_owner, patch: any) => (config = { ...config, ...patch, settings: { ...config.settings, ...patch.settings } }) as any
serverApi.fetchStateOwner = async () => ({} as any)
const prompts: string[] = []
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async () => ({ id: sessionId, title: "Timeline sync", location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
    switchAgent: async () => ({}), switchModel: async () => ({}), prompt: async ({ id }: any) => { prompts.push(id); return {} },
  },
  model: { default: async () => ({ data: model }) },
  message: { list: async (input: any = {}) => (await fetch("/fixture-native/list", { method: "POST", body: JSON.stringify(input) })).json() },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "Timeline sync", agent: "build", model: { providerId: "fixture", modelId: "fixture" },
  status: "idle", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true, version: "1", projectID: "p", location: { directory: "/fixture" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
}]])))
setProviders(previous => new Map(previous).set(instanceId, [{ id: "fixture", name: "Fixture", models: [{ id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } }] }]))
setActiveSession(instanceId, sessionId)
await updatePreferences(transcriptPresetPatch(preset))
const store = messageStoreBus.getOrCreate(instanceId)
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <SessionView sessionId={sessionId} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder="/fixture" escapeInDebounce={false} isActive={true} />
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  ids: () => store.getSessionMessageIds(sessionId),
  window: () => store.getMessageWindow(sessionId),
  toolHidden: (name: string) => resolveToolVisibility(preferences(), name) === "hidden",
  showThinking: () => preferences().showThinkingBlocks,
  systemVisibility: () => preferences().systemMessagesVisibility,
  prompts: () => prompts,
  setPreset: (value: ToolCallExpansionPreset) => updatePreferences(transcriptPresetPatch(value)),
  /** Sets Message content rows (`thinking`, `system` or a tool) as its popup does. */
  setVisibility: async (rows: Record<string, VisibilityPreference>) => {
    for (const [key, mode] of Object.entries(rows)) {
      const row = (key === "thinking" || key === "system" ? { kind: key, key, label: "" } : { kind: "tool", key, label: "" }) as TranscriptVisibilityRow
      await updatePreferences(transcriptVisibilityPatch(preferences(), row, mode))
    }
  },
}
