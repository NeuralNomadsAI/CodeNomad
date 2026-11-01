// The real instance shell with its Files panel: the central file reader must
// outlive the right panel's own visibility (hidden, docked or floating).
import { render } from "solid-js/web"
import InstanceShell from "../../../src/components/instance/instance-shell2"
import { RIGHT_PANEL_TAB_STORAGE_KEY } from "../../../src/components/instance/shell/storage"
import { FILES_PANEL_MODE_KEY } from "../../../src/components/instance/shell/right-panel/files-panel-state"
import { initializeClientState, writeClientLayoutValue } from "../../../src/stores/client-state"
import { seedRestoredSessionSelection, setSessionPage, setSessions, setMessagesLoaded } from "../../../src/stores/session-state"
import type { Session } from "../../../src/types/session"
import { addInstance, instances } from "../../../src/stores/instances"
import { ensureWorktreesLoaded } from "../../../src/stores/worktrees"
import { getFilePreview } from "../../../src/stores/files-preview"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import "../../../src/index.css"
import { markSessionListsRestored } from "./session-list-restored"

await initializeClientState()
writeClientLayoutValue(RIGHT_PANEL_TAB_STORAGE_KEY, "files")
if (new URLSearchParams(location.search).has("changes")) writeClientLayoutValue(FILES_PANEL_MODE_KEY, "changes")
const id = "file-preview-panel", scope = "/fixture", client = sdkManager.createClient(id, `/workspaces/${id}/instance`, () => true)
const reads: string[] = []
const gitReads = { status: 0, diff: 0 }
serverApi.fetchWorktreeGitStatus = async () => {
  gitReads.status++
  return [{ path: "src/app.ts", originalPath: null, stagedStatus: null, stagedAdditions: 0, stagedDeletions: 0,
    unstagedStatus: "modified", unstagedAdditions: 1, unstagedDeletions: 1 }] as any
}
serverApi.fetchWorktreeGitDiff = async (_id, _slug, input) => {
  gitReads.diff++
  return { path: input.path, scope: input.scope, isBinary: false,
    before: Array.from({ length: 400 }, (_, line) => `export const line${line} = ${line}`).join("\n"),
    after: Array.from({ length: 400 }, (_, line) => `export const line${line} = ${line} + 1`).join("\n") } as any
}
serverApi.listWorkspaceFiles = async () => [{ name: "README.md", path: "README.md", type: "file" as const }] as any
serverApi.previewWorkspaceFile = async (_id, path) => {
  reads.push(path)
  return { workspaceId: id, relativePath: path, encoding: "base64", contents: btoa("# Reader\n\nKeep me open.\n") } as any
}
addInstance({ id, folder: scope, port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client,
  metadata: { project: { id: "project", directory: scope, canonical: scope } } })
const conversations = ["one", "two"].map(name => ({ id: `ses_${name}`, instanceId: id, parentId: null, title: `Conversation ${name}`,
  agent: "build", model: { providerId: "private", modelId: "private" }, projectID: "project", cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, status: "idle", runtimeStatusKnown: true,
  location: { directory: scope }, time: { created: 1, updated: 1 } } satisfies Session))
setSessions(previous => new Map(previous).set(id, new Map(conversations.map(session => [session.id, session]))))
setSessionPage(id, conversations.map(session => session.id), false, true)
seedRestoredSessionSelection(id, "ses_one", "ses_one")
markSessionListsRestored(id)
setMessagesLoaded(previous => new Map(previous).set(id, new Set(conversations.map(session => session.id))))
await ensureWorktreesLoaded(id)

window.filePreviewPanel = { target: () => getFilePreview(id)?.path ?? null, scope: () => getFilePreview(id)?.scope ?? null,
  reads: () => [...reads], gitReads: () => ({ ...gitReads }) }
declare global {
  interface Window { filePreviewPanel: { target(): string | null; scope(): string | null; reads(): string[]; gitReads(): { status: number; diff: number } } }
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <div style={{ height: "100vh", display: "flex", "flex-direction": "column" }}>
    <InstanceShell instance={instances().get(id)!} isActiveInstance escapeInDebounce={false} paletteCommands={() => []}
      onExecuteCommand={() => {}} onCloseSession={() => {}} onNewSession={() => {}}
      handleSidebarAgentChange={async () => {}} handleSidebarModelChange={async () => {}} tabBarOffset={0}
      mobileFullscreenMode={false} onEnterMobileFullscreen={() => {}} onExitMobileFullscreen={() => {}} />
  </div>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
