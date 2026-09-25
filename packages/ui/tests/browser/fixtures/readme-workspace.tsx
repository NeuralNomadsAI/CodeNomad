// Public documentation fixture: real workspace components, synthetic session data.
import { render } from "solid-js/web"
import InstanceTabs from "../../../src/components/instance-tabs"
import InstanceShell from "../../../src/components/instance/instance-shell2"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { sseManager } from "../../../src/lib/sse-manager"
import { addInstance } from "../../../src/stores/instances"
import { setSessions, setSessionPage, setActiveSession, setActiveParentSession, ensureSessionExpanded, setProviders, setAgents } from "../../../src/stores/session-state"
import { initializeClientState, writeClientLayoutValue } from "../../../src/stores/client-state"
import { LEFT_DRAWER_STORAGE_KEY, RIGHT_DRAWER_STORAGE_KEY, RIGHT_PANEL_TAB_STORAGE_KEY } from "../../../src/components/instance/shell/storage"
import type { Session } from "../../../src/types/session"
import "../../../src/index.css"

const instanceId = "readme", sessionId = "workspace", directory = "/projects/atlas"
const model = { providerID: "anthropic", id: "claude-sonnet-4-5" }
const time = Date.UTC(2026, 8, 25, 10)
const tokens = { input: 18400, output: 3200, reasoning: 0, cache: { read: 12800, write: 0 } }
const messages = [
  { id: "msg_01", type: "user", time: { created: time }, text: "Add keyboard navigation to the project switcher. Keep the existing styling and cover the interaction with a browser test." },
  { id: "msg_02", type: "assistant", agent: "build", model, time: { created: time + 1000, completed: time + 2000 }, content: [
    { type: "text", text: "I'll check the existing focus behavior, add arrow-key navigation, then verify the interaction in the browser." },
    { type: "tool", id: "tool_read", name: "read", time: { created: time + 1200 }, state: { status: "completed", input: { path: "src/components/project-switcher.tsx" }, content: [{ type: "text", text: "Read src/components/project-switcher.tsx, lines 1–142" }] } },
  ] },
  { id: "msg_03", type: "assistant", agent: "build", model, tokens, cost: 0.18, time: { created: time + 3000, completed: time + 5000 }, content: [
    { type: "tool", id: "tool_shell", name: "shell", time: { created: time + 3100 }, state: { status: "completed", input: { command: "npm run test:browser -- project-switcher" }, content: [{ type: "text", text: "✓ Arrow keys move focus between projects\n✓ Enter selects the focused project\n✓ Escape closes the switcher and restores focus\n\n3 passed (1.2s)" }] } },
    { type: "text", text: "## Keyboard navigation is ready\n\n- **Arrow keys** move between projects.\n- **Enter** selects the focused project.\n- **Escape** closes the switcher and returns focus to the trigger.\n\nThe existing pointer behavior and visual styling are preserved. All **3 browser tests pass**.\n\nChanged `project-switcher.tsx` and added `project-switcher.test.ts`." },
  ] },
  { id: "msg_04", type: "idle", outcome: "completed", time: { created: time + 6000 } },
]
const titles = ["Keyboard navigation", "Review focus behavior", "Browser regression tests", "Polish the settings panel", "Add project search", "Review API pagination", "Improve empty states", "Update the contributor guide"]
const demoSessions: Session[] = titles.map((title, index) => ({
  id: index === 0 ? sessionId : `session-${index}`, instanceId, title,
  parentId: index === 1 || index === 2 ? sessionId : null,
  agent: index === 1 ? "explore" : "build", model: { providerId: model.providerID, modelId: model.id },
  status: "idle", retry: null, idleSince: null, generationRecovery: null, runtimeStatusKnown: true,
  version: "1", projectID: "atlas", location: { directory }, cost: 0.18, tokens,
  time: { created: time - index * 3600000, updated: time - index * 3600000 },
}))
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async () => demoSessions[0], list: async () => ({ data: demoSessions, cursor: {} }),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
  },
  message: { list: async () => ({ data: [...messages].reverse(), cursor: {} }) },
  model: { default: async () => ({ data: model }) },
  shell: { list: async () => ({ data: [] }) },
  mcp: { status: async () => ({}) },
}
let config: any = { settings: { locale: "en", showMessageTimeline: true } }
serverApi.fetchConfigOwner = async () => config
serverApi.patchConfigOwner = async (_owner, patch: any) => (config = { ...config, ...patch, settings: { ...config.settings, ...patch.settings } })
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.fetchWorktrees = async () => ({ isGitRepo: true, defaultDirectory: directory, worktrees: [
  { slug: "root", directory, branch: "main", name: "Workspace", isRoot: true },
] } as any)
serverApi.getPluginControls = async () => ({ location: { directory }, runtime: [], configured: { sources: [], rules: [] }, targets: [],
  controls: ["codenomad.automation", "codenomad-session-pruning"].map(id => ({ id, builtin: false, effective: "enabled", global: "enabled", project: "default" })),
} as any)
const entries = messages.map((message, seq) => ({ id: message.id, seq, type: message.type,
  tools: message.type === "assistant" ? 1 : 0, reasoning: 0, ...(message.type === "assistant" ? { toolName: seq === 1 ? "read" : "shell" } : {}),
}))
serverApi.fetchSessionOutline = async () => ({ status: "outline", total: entries.length, entries,
  checkpoints: [{ after: -1, through: entries.length - 1, digest: "0".repeat(64), changed: true }], cursor: null,
} as any)

await initializeClientState()
writeClientLayoutValue(LEFT_DRAWER_STORAGE_KEY, "290")
writeClientLayoutValue(RIGHT_DRAWER_STORAGE_KEY, "350")
writeClientLayoutValue(RIGHT_PANEL_TAB_STORAGE_KEY, "status")
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
const instance = { id: instanceId, projectName: "Atlas", folder: directory, port: 0, pid: 0, proxyPath: "", status: "ready" as const, client,
  metadata: { mcpStatus: { location: { directory }, data: [{ name: "project-docs", status: { status: "connected" as const } }] } },
}
addInstance(instance)
sseManager.seedStatus(instanceId, "connected")
setSessions(new Map([[instanceId, new Map(demoSessions.map(session => [session.id, session]))]]))
setSessionPage(instanceId, demoSessions.filter(session => !session.parentId).map(session => session.id), false, true)
setProviders(new Map([[instanceId, [{ id: model.providerID, name: "Anthropic", models: [{ id: model.id, name: "Claude Sonnet 4.5", providerId: model.providerID, limit: { context: 200000, output: 64000 }, cost: { input: 3, output: 15 } }] }]]]))
setAgents(new Map([[instanceId, [{ id: "build", name: "Build", mode: "primary", description: "Build and implement" }, { id: "explore", name: "Explore", mode: "subagent", description: "Explore the codebase" }]]]))
ensureSessionExpanded(instanceId, sessionId)
setActiveParentSession(instanceId, sessionId)
setActiveSession(instanceId, sessionId)
await updatePreferences({ locale: "en", showMessageTimeline: true })

render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <div style={{ height: "100vh", display: "flex", "flex-direction": "column" }}>
    <InstanceTabs tabs={[{ id: "instance:readme", kind: "instance", instance },
      { id: "instance:docs", kind: "instance", instance: { ...instance, id: "docs", projectName: "Documentation", folder: "/projects/docs" } }]}
      activeTabId="instance:readme" onSelect={() => {}} onClose={() => {}} onNew={() => {}} onMoveTab={() => {}} />
    <InstanceShell instance={instance} isActiveInstance escapeInDebounce={false} paletteCommands={() => []}
      onCloseSession={() => {}} onNewSession={() => {}} handleSidebarAgentChange={async () => {}}
      handleSidebarModelChange={async () => {}} onExecuteCommand={() => {}} tabBarOffset={0}
      mobileFullscreenMode={false} onEnterMobileFullscreen={() => {}} onExitMobileFullscreen={() => {}} />
  </div>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
