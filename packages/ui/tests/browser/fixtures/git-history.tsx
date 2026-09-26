import { Show, Suspense, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { ConfigProvider, updatePreferences, setThemePreference } from "../../../src/stores/preferences"
import { addInstance } from "../../../src/stores/instances"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverApi } from "../../../src/lib/api-client"
import { ensureWorktreesLoaded } from "../../../src/stores/worktrees"
import { createCoreRightPanelRuntime } from "../../../src/components/instance/shell/right-panel/core-runtime"
import { FilesPreviewView } from "../../../src/components/files-preview-view"
import { closeFilePreview, getFilePreview } from "../../../src/stores/files-preview"
import { parseRightPanelCustomization } from "../../../src/components/instance/shell/right-panel/registry"
import { sessions, setActiveSession, setProviders } from "../../../src/stores/session-state"
import { fetchSessions } from "../../../src/stores/session-api"
import { invalidateFilesystemCaches } from "../../../src/lib/filesystem-events"
import "../../../src/index.css"

const id = "git-prototype", sessionId = "session"
const SessionView = new URLSearchParams(location.search).has("session")
  ? (await import("../../../src/components/session/session-view")).default : undefined
const [selectedSession, setSelectedSession] = createSignal(sessionId)
const calls: Array<{ kind: string; slug?: string; path?: string }> = []
const entries = [
  { slug: "root", label: "CodeNomad", directory: "/CodeNomad", branch: "feat/git-history", kind: "root" as const },
  { slug: "review", label: "review", directory: "/CodeNomad/.codenomad/worktrees/review", branch: "dev", kind: "worktree" as const },
]
const commits = [
  ["Make Git history the starting point", "HEAD -> feat/git-history"],
  ["Open file diffs beside the Git navigator", "origin/feat/git-history"],
  ["Preserve conversation drafts when opening a preview", ""],
  ["Merge pull request #788: qualify OpenCode 2.0.18", "dev"],
].map(([subject, refs], i) => ({ id: String(i + 1).repeat(40), subject, refs, author: "Pascal André",
  date: `2026-09-${26 - i}T12:00:00Z`, parents: [String(i + 2).repeat(40)] }))
const before = 'export function openGitPanel() {\n  return {\n    title: "Git Changes",\n    view: "changes",\n    diffPlacement: "sidebar",\n  }\n}\n'
const after = 'export function openGitPanel() {\n  return {\n    title: "Git",\n    view: "history",\n    diffPlacement: "conversation",\n    preserveDraft: true,\n  }\n}\n'
const directoryFiles: Record<string, string[]> = {
  ".": [".github/", "dev-docs/", "src/", "README.md", "package.json"],
  ".github": ["workflows/"],
  ".github/workflows": ["build-and-upload.yml", "pr-build.yml", "release.yml", "update-winget.yml"],
  "dev-docs": ["ui-harmonization-demo/", "architecture.md", "BROWSER_AUTOMATION.md"],
  "dev-docs/ui-harmonization-demo": ["palette.svg", "design-notes.md"],
  "src": ["components/", "styles/", "index.ts"],
  "src/components": ["git-panel.tsx", "workspace-tree.tsx"],
  "src/styles": ["panels/"],
  "src/styles/panels": ["git-history.css"],
}
serverApi.listWorkspaceFiles = async (_id, path = ".", directory) => {
  calls.push({ kind: "files", path, slug: directory })
  return (directoryFiles[path] ?? []).map(name => ({ name: name.replace(/\/$/, ""),
    path: `${path === "." ? "" : path + "/"}${name.replace(/\/$/, "")}`, type: name.endsWith("/") ? "directory" as const : "file" as const }))
}
serverApi.previewWorkspaceFile = async (_id, path, directory) => {
  calls.push({ kind: "file", path, slug: directory })
  const text = path.endsWith(".svg")
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420"><rect width="720" height="420" fill="#202731"/><text x="40" y="65" fill="#f2e8cf" font-size="28" font-family="sans-serif">CodeNomad / Palette study</text><rect x="40" y="110" width="150" height="240" fill="#a6b8a0"/><rect x="205" y="110" width="150" height="240" fill="#c6b3a0"/><rect x="370" y="110" width="150" height="240" fill="#a1b7c5"/><rect x="535" y="110" width="145" height="240" fill="#d5c8ab"/></svg>'
    : path.endsWith(".md") ? '# CodeNomad\n\nUn espace pour explorer les fichiers, les changements et les commits.\n\n## Trois points de vue\n\n- **Workspace** : les fichiers du projet\n- **Changes** : les modifications locales\n- **Commits** : les versions enregistrées\n\n```ts\nconst viewer = "conversation"\n```\n'
    : path.endsWith(".yml") ? 'name: Update Winget\n\non:\n  workflow_call:\n    inputs:\n      release_tag:\n        description: "Stable release tag to inspect"\n        required: true\n        type: string\n\njobs:\n  update-manifest:\n    runs-on: windows-latest\n    steps:\n      - uses: actions/checkout@v4\n'
    : path.endsWith(".json") ? '{\n  "name": "codenomad",\n  "private": true\n}\n' : after
  return { workspaceId: _id, relativePath: path, encoding: "base64", contents: btoa(String.fromCharCode(...new TextEncoder().encode(text))) }
}
const model = { providerID: "fixture", id: "fixture" }
const sessionInfo = (sessionID: string) => ({ id: sessionID, title: sessionID, agent: "build", model, projectID: "fixture", location: { directory: "/CodeNomad" },
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } })
const client: any = { vcs: { status: async () => ({ data: [] }) },
  session: {
    active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    list: async () => ({ data: [sessionInfo(sessionId), sessionInfo("other")], cursor: {} }),
    get: async ({ sessionID }: any) => sessionInfo(sessionID),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
  }, model: { default: async () => model }, message: { list: async () => ({ data: [], cursor: {} }) },
}
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "fr" } }) as any
serverApi.patchConfigOwner = async (_owner, patch) => patch as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.patchStateOwner = async (_owner, patch) => patch as any
serverApi.fetchWorktrees = async () => ({ isGitRepo: true, defaultDirectory: "/CodeNomad/.codenomad/worktrees", worktrees: entries })
serverApi.fetchGitHistory = async (_id, slug) => {
  calls.push({ kind: "history", slug })
  return { branch: entries.find(entry => entry.slug === slug)!.branch, head: commits[0].id, commits: slug === "root" ? commits : commits.slice(3), hasMore: false }
}
serverApi.fetchGitCommit = async (_id, slug, commit) => {
  calls.push({ kind: "commit", slug })
  return { id: commit, parent: commits[1].id, message: commits.find(entry => entry.id === commit)!.subject + "\n\nKeep history and local changes as two simple paths to the central diff.",
    files: [{ path: "src/components/git-panel.tsx", originalPath: null, status: "M" }, { path: "src/styles/panels/git-history.css", originalPath: null, status: "A" }] }
}
serverApi.fetchGitCommitDiff = async (_id, slug, _commit, path) => { calls.push({ kind: "commit-diff", slug, path }); return { path, before, after, isBinary: false } }
serverApi.fetchWorktreeGitStatus = async (_id, slug) => {
  calls.push({ kind: "status", slug })
  return [{ path: "src/components/git-panel.tsx", originalPath: null, stagedStatus: "modified", stagedAdditions: 4, stagedDeletions: 2, unstagedStatus: null, unstagedAdditions: 0, unstagedDeletions: 0 },
    { path: "src/styles/panels/git-history.css", originalPath: null, stagedStatus: null, stagedAdditions: 0, stagedDeletions: 0, unstagedStatus: "untracked", unstagedAdditions: 34, unstagedDeletions: 0 }]
}
serverApi.fetchWorktreeGitDiff = async (_id, slug, input) => { calls.push({ kind: "local-diff", slug, path: input.path }); return { path: input.path, scope: input.scope, before, after, isBinary: false } }
// The interactive fixture has no mutation transport.
serverApi.stageWorktreeGitPaths = serverApi.unstageWorktreeGitPaths = async () => ({ ok: true })
serverApi.commitWorktreeGitChanges = async () => ({ ok: true }) as any
const instance = { id, folder: "/CodeNomad", projectName: "CodeNomad", port: 0, pid: 0, status: "ready" as const, client, proxyPath: `/workspaces/${id}/instance` }
addInstance(instance)
await ensureWorktreesLoaded(id)
if (SessionView) {
  setProviders(previous => new Map(previous).set(id, [{ id: "fixture", name: "Fixture", models: [{ id: "fixture", name: "Fixture", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } }] }]))
  await fetchSessions(id)
  setActiveSession(id, sessionId)
}

function Prototype() {
  const { t } = useI18n()
  const [active, setActive] = createSignal(true)
  const runtime = createCoreRightPanelRuntime({ t, instanceId: id, instance, isActive: active,
    activeSessionId: selectedSession, activeSession: () => sessions().get(id)?.get(selectedSession()) ?? null, isPhoneLayout: () => false,
    rightDrawerWidth: () => 360, rightDrawerWidthInitialized: () => true, promptInputApi: () => null,
    rightPanelTab: () => "files", expandedItems: () => [], onExpandedItemsChange() {},
    customization: () => parseRightPanelCustomization(null), onCustomizationChange() {}, extraStatusSections: () => [],
  })
  const tab = runtime.create({ instanceId: id, t, activeSessionId: () => sessionId, isTabActive: () => true, openTab() {} }).tabs!.find(tab => tab.id === "files")!
  ;(window as any).fixture = { calls, setActive, close: () => closeFilePreview(id), target: () => getFilePreview(id),
    invalidate: () => invalidateFilesystemCaches(id),
    switchSession: (value: string) => { setSelectedSession(value); if (SessionView) setActiveSession(id, value) },
    holdFile: () => {
      const read = serverApi.previewWorkspaceFile
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      serverApi.previewWorkspaceFile = async (...args) => { const data = await read(...args); await gate; return data }
      ;(window as any).fixture.releaseFile = () => { release(); serverApi.previewWorkspaceFile = read }
    },
    holdCommit: () => {
      const read = serverApi.fetchGitCommit
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      serverApi.fetchGitCommit = async (...args) => { const data = await read(...args); await gate; return data }
      ;(window as any).fixture.releaseCommit = release
    } }
  return <div style={{ height: "100vh", display: "flex", "flex-direction": "column", background: "var(--surface-base)", color: "var(--text-primary)" }}>
    <header class="window-header" style={{ padding: "12px 18px" }}><strong>CodeNomad</strong><span class="text-xs text-muted">Prototype Files · données de démonstration</span></header>
    <div style={{ display: "flex", flex: 1, "min-height": "0" }}>
      <main style={{ display: "flex", "flex-direction": "column", flex: 1, "min-width": "0" }}>
        <Show when={!SessionView} fallback={SessionView ? <SessionView sessionId={selectedSession()} activeSessions={sessions().get(id)!} instanceId={id} instanceFolder="/CodeNomad" escapeInDebounce={false} isActive={active()} /> : undefined}>
        <Show when={getFilePreview(id)} fallback={<div style={{ flex: 1, padding: "32px", overflow: "auto" }}>
          <div class="text-xs text-muted">CONVERSATION</div>
          <h2 style={{ "font-size": "22px", margin: "12px 0 32px" }}>Explorer le travail en cours</h2>
          <div style={{ background: "var(--surface-secondary)", padding: "20px", "max-width": "650px" }}>Le panneau Files propose trois points de vue : Workspace, Changes et Commits. Choisissez un fichier pour afficher son contenu ou son diff ici.</div>
        </div>}>{target => <FilesPreviewView instanceId={id} target={target()} active={active()} onClose={() => closeFilePreview(id)} />}</Show>
        <textarea aria-label="Brouillon" placeholder="Continuer avec l’agent…" style={{ height: "100px", resize: "none", margin: "12px", padding: "14px", border: "1px solid var(--border-base)", background: "var(--surface-base)", color: "var(--text-primary)" }} />
        </Show>
      </main>
      <aside style={{ width: "360px", "min-width": "260px", "max-width": "48vw", "border-left": "1px solid var(--border-base)", display: "flex", "flex-direction": "column" }}>
        <div class="window-header" style={{ padding: "10px 14px" }}><strong>{t("instanceShell.rightPanel.tabs.files")}</strong></div>
        <div style={{ flex: 1, "min-height": "0" }}><Suspense>{tab.render()}</Suspense></div>
      </aside>
    </div>
  </div>
}
render(() => <ConfigProvider><ThemeProvider><I18nProvider><Prototype /></I18nProvider></ThemeProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "fr" })
await setThemePreference("dark")
