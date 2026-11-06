import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import { AgentMemorySettingsCard } from "../../../src/components/settings/agent-memory-settings-card"
import { createPreferencesProjectContext } from "../../../src/components/settings/preferences-project-context"
import AlertDialog from "../../../src/components/alert-dialog"
import type { NativePreferencesRequest } from "../../../src/lib/native/preferences-window"
import { ConfigProvider } from "../../../src/stores/preferences"
import { confirmSettingsDiscard } from "../../../src/stores/settings-dirty-guard"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverEvents } from "../../../src/lib/server-events"
import { applyUiSettings } from "./ui-settings"
import { SettingsScreen } from "../../../src/components/settings-screen"
import { openSettings } from "../../../src/stores/settings-screen"
import "../../../src/index.css"

const params = new URLSearchParams(location.search)
await applyUiSettings({ locale: (params.get("locale") || "en") as any, theme: "dark" })
function Fixture() {
  const [mounted, setMounted] = createSignal(true)
  const [screen, setScreen] = createSignal<"embedded" | "standalone">()
  const [request, setRequest] = createSignal<NativePreferencesRequest>({ section: "general", instanceId: "project-a", workspacePath: "C:/project-a", location: { directory: "/repo-a" } })
  const project = createPreferencesProjectContext(request, () => true, (next, current) => { if (current()) setRequest(previous => ({ ...previous, ...next })) })
  ;(window as any).fixture = {
    enableCleanup: async (fail: boolean | "prompt" = false) => {
      const [{ addInstance, setActiveInstanceId }, { sdkManager }, { setSessions, setActiveParentSession, activeSessionId }, { messageStoreBus }, { activeAppTabId }, { runMemoryCleanup }] = await Promise.all([
        import("../../../src/stores/instances"), import("../../../src/lib/sdk-manager"),
        import("../../../src/stores/session-state"), import("../../../src/stores/message-v2/bus"),
        import("../../../src/stores/app-tabs"), import("../../../src/stores/agent-memory-cleanup"),
      ])
      const calls: unknown[] = []
      const session = (id: string, directory: string) => ({ id, title: id, parentID: null, agent: "", model: null, projectID: "project", location: { directory }, time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
      const client = {
        model: { default: async () => ({ data: null }) },
        session: {
          create: async (input: any) => { calls.push({ action: "create", input }); if (fail === true) throw new Error("Uncertain creation"); return session("cleanup-new", input.location.directory) },
          prompt: async (input: any) => { calls.push({ action: "prompt", input }); if (fail === "prompt") throw new Error("Uncertain send") },
          switchAgent: async () => {}, switchModel: async () => {},
          instructions: { entry: { put: async () => {}, remove: async () => {} } },
          list: async () => ({ data: [], cursor: {} }), get: async () => session("existing", "/another-worktree"),
          active: async () => ({}), inbox: { list: async () => [] },
        }, message: { list: async () => ({ data: [{ id: "existing-message", type: "user" }], cursor: {} }) },
      } as any
      ;(sdkManager as any).clients.set("project-a:/workspaces/project-a/instance", client)
      addInstance({ id: "project-a", folder: "C:/project-a", port: 0, pid: 0, proxyPath: "", status: "ready", client })
      setSessions(previous => new Map(previous).set("project-a", new Map([["existing", { ...session("existing", "/another-worktree"), instanceId: "project-a", parentId: null, agent: "", model: { providerId: "", modelId: "" }, status: "idle" } as any]])))
      setActiveParentSession("project-a", "existing")
      setActiveInstanceId("project-a")
      messageStoreBus.getOrCreate("project-a")
      ;(window as any).cleanupCalls = calls
      ;(window as any).cleanupState = () => ({ tab: activeAppTabId(), session: activeSessionId().get("project-a") })
      ;(window as any).runCleanup = runMemoryCleanup
    },
    context: (next?: Partial<NativePreferencesRequest>) => setRequest({ section: "general", ...next }),
    settings: async (mode: "embedded" | "standalone") => { setScreen(mode); await openSettings("general") },
    mount: setMounted,
    leave: async () => { if (await confirmSettingsDiscard()) setMounted(false) },
    event: (event: unknown) => (serverEvents as any).dispatchBatch([event]),
    reconnect: () => { for (const handler of (serverEvents as any).openHandlers) handler() },
  }
  return <><main class="settings-content" style={{ width: "min(700px, 100%)", margin: "auto", padding: "24px" }}>
    <Show when={mounted()}><Show when={screen()} fallback={<AgentMemorySettingsCard instanceId={project()?.instanceId} location={project()?.location} />}>
      <SettingsScreen standalone={screen() === "standalone"} providerContext={screen() === "standalone" ? project() : undefined} />
    </Show></Show>
  </main><AlertDialog /></>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
