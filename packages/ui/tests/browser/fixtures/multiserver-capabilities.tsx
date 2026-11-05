import { For, createSignal } from "solid-js"
import { render } from "solid-js/web"
import InstanceShell from "../../../src/components/instance/instance-shell2"
import { ConfigProvider, updatePreferences, useConfig } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverEvents } from "../../../src/lib/server-events"
import { addInstance, instances, activeInstanceId, setActiveInstanceId, updateInstance, ensureYoloStateSynced, togglePermissionAutoAcceptForSession } from "../../../src/stores/instances"
import { setSessions, setActiveSession, setActiveParentSession, setSessionPage, setProviders, activeSessionId } from "../../../src/stores/session-state"
import { reloadWorktrees, createWorktree } from "../../../src/stores/worktrees"
import { shellStore } from "../../../src/stores/shells"
import { activateMissionDemand } from "../../../src/stores/missions"
import { openFilePreview, getFilePreview } from "../../../src/stores/files-preview"
import { initialServerCapabilities } from "../../../../server/src/opencode/servers/capabilities"
import { ExtensionPanel } from "../../../src/components/panel-extensions/extension-panel"
import { panelExtensionsApi } from "../../../src/lib/panel-extensions-api"
import { useCommands } from "../../../src/lib/hooks/use-commands"
import { useAppLifecycle } from "../../../src/lib/hooks/use-app-lifecycle"
import { sessionGoals } from "../../../src/stores/session-goal"
import { canOpenWorkspacePaths } from "../../../src/lib/workspace-open"
import { keyboardRegistry } from "../../../src/lib/keyboard-registry"
import { isOpen as paletteIsOpen } from "../../../src/stores/command-palette"
import { applyUiSettings } from "./ui-settings"
import { getToastHistory } from "../../../src/lib/notifications"
import { alertDialogState } from "../../../src/stores/alerts"
import { readStoredRightPanelTab } from "../../../src/components/instance/shell/storage"
import { initializeClientState } from "../../../src/stores/client-state"
import "../../../src/index.css"

;(serverEvents as any).connectGeneration++
;(serverEvents as any).clearReconnectTimer()
;(serverEvents as any).connection?.disconnect()
;(serverEvents as any).connection = null
;(serverEvents as any).watchdog.setConnected(false)
const ids = ["A", "B", "local-shared"]
const calls: { id: string; method: string }[] = []
const nativeMessages = new Map<string, any[]>()
const record = (id: string, method: string) => { calls.push({ id, method }) }
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" }, opencodeServers: ids.slice(0, 2).map(id => ({ kind: "explicit", id, label: "Same long execution server label אבג / destination " + id })) }) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.patchConfigOwner = async (_owner, patch) => patch as any
serverApi.patchStateOwner = async (_owner, patch) => patch as any
serverApi.fetchWorktrees = async id => { record(id, "worktrees"); return { isGitRepo: true, worktrees: [{ slug: "root", directory: "/same/", kind: "root" }] } }
serverApi.listWorkspaceFiles = async id => { record(id, "files"); const name = id === "local-shared" ? "local.txt" : `${id}-remote.txt`; return [{ name, path: name, type: "file" }] as any }
serverApi.fetchMissionPanel = async id => { record(id, "missions"); return {} as any }
serverApi.fetchMissionTasks = async id => { record(id, "missions"); return {} as any }
serverApi.getYoloState = async id => { record(id, "yolo"); return { enabled: false } }
serverApi.toggleYolo = async id => { record(id, "yolo-toggle"); return { enabled: true } }
serverApi.fetchSessionGoal = async id => { record(id, "goal"); return null as any }
serverApi.fetchProviderUsage = async id => { record(id, "usage"); return null as any }
serverApi.pruneSessionMessage = async (id, input) => {
  record(id, "prune")
  const message = nativeMessages.get(id)!.find(message => message.id === input.messageID)
  message.content = message.content.filter((_part: unknown, index: number) => !input.indexes.includes(index))
  return { status: "pruned" } as const
}
for (const method of ["fetchGitHistory", "fetchGitCommit", "fetchGitCommitDiff", "fetchWorktreeGitDiff", "previewWorkspaceFile", "initializeWorkspaceGit", "createWorktree", "writeWorkspaceFile", "stageWorktreeGitPaths", "commitWorktreeGitChanges"] as const) {
  ;(serverApi as any)[method] = async (id: string) => { record(id, method); return {} }
}
// prototype-1236: an explicit project's working changes come from its native VCS through the host backend.
serverApi.fetchWorktreeGitStatus = async id => { record(id, "fetchWorktreeGitStatus"); return [{ path: `${id}-change.ts`, stagedStatus: null, stagedAdditions: 0, stagedDeletions: 0, unstagedStatus: "modified", unstagedAdditions: 1, unstagedDeletions: 0 }] as any }
panelExtensionsApi.list = async () => []
panelExtensionsApi.panel = async (id: string) => { record(id, "frame"); return { html: "<p>Extension context</p>" } as any }
for (const id of ids) {
  nativeMessages.set(id, [{ id: "hello", type: "user", text: "Native conversation", time: { created: 1 } },
    { id: "response", type: "assistant", agent: "build", model: { providerID: "p", id: "m" }, time: { created: 2, completed: 3 }, content: [
      { type: "reasoning", text: "Synthetic reasoning", time: { created: 2, completed: 3 } },
      { type: "tool", id: "tool-response", name: "shell", time: { created: 2, completed: 3 }, state: { status: "completed", input: { command: "fixture" }, content: [{ type: "text", text: "Synthetic result" }] } },
      { type: "text", text: "Technical response" },
    ] }])
  const session: any = { id: "same", instanceId: id, title: "Same conversation", parentId: null, location: { directory: "/same/" }, projectID: "same", agent: "design", status: "idle", model: { providerId: "p", modelId: "m" }, time: { created: 1, updated: 1 } }
  const client: any = {
    session: { list: async () => ({ data: [session], cursor: {} }), active: async () => ({}), get: async () => session, inbox: { list: async () => ({ data: [] }) },
      message: { get: async (input: any) => { record(id, "message-get"); return nativeMessages.get(id)!.find(message => message.id === input.messageID) } } },
    message: { list: async () => ({ data: nativeMessages.get(id), cursor: {} }) },
    model: { default: async () => ({ data: { providerID: "p", id: "m" } }) },
    shell: { list: async () => { record(id, "shell-list"); return { data: [] } } },
    vcs: { status: async () => { record(id, "native-git"); return { data: [] } },
      get: async (input: any) => { record(id, "branch"); return { location: input.location, data: { provider: "git", branch: { current: `${id}-branch` } } } } },
  }
  ;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
  const capabilities = initialServerCapabilities({ id, kind: id === "local-shared" ? "local-shared" : "explicit", origin: id === "A" ? "http://127.0.0.1:4010" : "https://server.invalid", label: "Same" } as any, 1 as any)
  for (const value of Object.values(capabilities.features)) value.state = "available"
  addInstance({ id, binding: { serverId: id, directory: "/same/" }, capabilities, folder: "/same/", port: 1234, pid: 5678, proxyPath: `/workspaces/${id}/instance`, status: "ready", client }, () => true)
  setSessions(previous => new Map(previous).set(id, new Map([["same", session]])))
  setProviders(previous => new Map(previous).set(id, [{ id: "p", name: "Provider", models: [] }]))
  setActiveSession(id, "same"); setActiveParentSession(id, "same"); setSessionPage(id, ["same"], false, true)
}
const [selected, select] = createSignal("A")
setActiveInstanceId("A")
const [extension, setExtension] = createSignal<any>()
let commandApi: ReturnType<typeof useCommands>
function Fixture() {
  const config = useConfig()
  const noop = () => {}
  commandApi = useCommands({ preferences: config.preferences, getActiveInstance: () => instances().get(selected())!,
    getActiveSessionIdForInstance: () => "same", toggleShowThinkingBlocks: noop, toggleShowMessageTimeline: noop,
    toggleUsageMetrics: noop, toggleAutoCleanupBlankSessions: noop, toggleShowPromptVoiceInput: noop,
    setDiffViewMode: noop, setToolOutputExpansion: noop, setDiagnosticsExpansion: noop, setThinkingBlocksExpansion: noop,
    setToolInputsVisibility: noop, handleNewInstanceRequest: noop, handleNewTemporaryInstance: async () => {},
    handleCloseActiveTab: async () => {}, handleNewSession: async () => {}, handleCloseSession: async () => {} })
  useAppLifecycle({ setEscapeInDebounce: noop, handleNewInstanceRequest: noop, handleCloseActiveTab: async () => {},
    handleNewSession: async () => {}, handleCloseSession: async () => {}, showFolderSelection: () => false, setShowFolderSelection: noop,
    getActiveInstance: () => instances().get(selected())!, getActiveSessionIdForInstance: () => activeSessionId().get(selected()) ?? null,
    commands: commandApi.commands, executeCommand: commandApi.executeCommand })
  return <>
  <button id="external-focus">External B focus</button>
  <For each={ids}>{id => <div data-owner={id} style={{ display: selected() === id ? "flex" : "none", height: "95vh", "flex-direction": "column" }}>
    <InstanceShell instance={instances().get(id)!} isActiveInstance={selected() === id} escapeInDebounce={false}
      paletteCommands={commandApi.commands} onExecuteCommand={commandApi.executeCommand} onCloseSession={() => {}} onNewSession={() => {}}
      handleSidebarAgentChange={async () => {}} handleSidebarModelChange={async () => {}} tabBarOffset={0} />
  </div>}</For>
  <For each={extension() ? [extension()] : []}>{entry => <ExtensionPanel instanceId={selected()} entry={entry} active context={{ apiVersion: 1, sessionId: "same", locale: "en", appearance: "light" }} host={{} as any} />}</For>
  </>
}
await initializeClientState()
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await applyUiSettings({ locale: "en" })
setActiveInstanceId("A")
;(window as any).fixture = {
  calls: () => calls,
  preferredTab: () => readStoredRightPanelTab("files"),
  commandRegistration: () => ({ native: canOpenWorkspacePaths(), ids: commandApi.commands().map(command => command.id), active: activeInstanceId(), hotkey: keyboardRegistry.findMatch(new KeyboardEvent("keydown", { key: "P", ctrlKey: true, shiftKey: true }))?.id, dialog: document.querySelector('[role="dialog"][aria-modal="true"]')?.outerHTML.slice(0, 400) }),
  paletteIsOpen,
  select: (id: string) => { select(id); setActiveInstanceId(id) },
  info: (id: string) => setActiveSession(id, "info"),
  conversation: (id: string) => setActiveSession(id, "same"),
  selectedSession: (id: string) => activeSessionId().get(id),
  feedback: () => ({ toasts: getToastHistory().length, alert: alertDialogState()?.message ?? null }),
  rotate: (id: string) => updateInstance(id, { capabilities: { ...instances().get(id)!.capabilities!, generation: (instances().get(id)!.capabilities!.generation + 1) as any } }, () => true),
  mismatch: (id: string) => updateInstance(id, { capabilities: { ...instances().get(id)!.capabilities!, serverId: "other" } }, () => true),
  unresolved: (id: string) => updateInstance(id, { binding: { serverId: id, directory: "" } }),
  revoke: (id: string) => updateInstance(id, { capabilities: { ...instances().get(id)!.capabilities! } }, () => false),
  rebind: (id: string, serverId: string) => updateInstance(id, { binding: { serverId, directory: "/same/" } }),
  preview: (id: string, kind: "workspace" | "working") => openFilePreview(id, { kind: kind === "workspace" ? "workspace" : "git", scope: "unstaged", path: "local.txt", directory: "/same/", slug: "root", sessionId: "same" } as any),
  filePreview: getFilePreview,
  forced: async (id: string) => { await reloadWorktrees(id); await createWorktree(id, "blocked").catch(() => {}); await shellStore.load(id, "/same/"); ensureYoloStateSynced(id, "same"); togglePermissionAutoAcceptForSession(id, "same"); activateMissionDemand(id); sessionGoals.demand?.(id, "same", true) },
  executeUnavailable: () => {
    for (const id of ["remove-session-tools-and-reasoning", "switch-to-info", "open-workspace-folder"]) {
      const command = commandApi.commands().find(command => command.id === id)
      if (command) { commandApi.executeCommand(command); void command.action(); commandApi.commandRegistry.execute(command.id); commandApi.executeMenuCommand(command.id) }
    }
  },
  extension: (apiVersion: number, preferences = false) => setExtension({ enabled: true, digest: "a".repeat(64), manifest: { id: "fixture.panel", name: "Extension", apiVersion, permissions: apiVersion === 1 ? ["session.context"] : apiVersion === 2 ? ["session.context", "session.assets.read"] : apiVersion === 3 ? ["session.context", "repository.workItems.read"] : ["session.context", preferences ? "panel.preferences" : "session.images.read"] } }),
  prefs: updatePreferences,
}
