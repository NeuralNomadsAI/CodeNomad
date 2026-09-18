import { render } from "solid-js/web"
import WorktreeSelector from "../../../src/components/worktree-selector"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { setSessions } from "../../../src/stores/session-state"
import { ensureWorktreesLoaded, reloadWorktrees, getWorktrees } from "../../../src/stores/worktrees"
import { serverEvents } from "../../../src/lib/server-events"
import "../../../src/index.css"

const id = "worktree-fixture"
const calls: unknown[] = []
const entries = [
  { slug: "root", label: "main", directory: "/repo", kind: "root" as const },
  { slug: "stable-feature-id", label: "feature", directory: "/repo/.codenomad/worktrees/feature", kind: "worktree" as const },
]
const session: any = { id: "session", instanceId: id, parentId: null, title: "Fixture", location: { directory: "/repo" },
  projectID: "fixture", cost: 0, tokens: {}, time: { created: 1, updated: 1 }, agent: "build", status: "idle", model: { providerId: "fixture", modelId: "fixture" } }
const client: any = { session: { list: async () => ({ data: [session], cursor: {} }), active: async () => ({}) } }
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
const uiConfig = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => uiConfig as any
serverApi.patchConfigOwner = async (_owner, patch) => Object.assign(uiConfig, patch) as any
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.fetchWorktrees = async () => ({ isGitRepo: true, defaultDirectory: "/repo/.codenomad/worktrees", worktrees: entries })
serverApi.createWorktree = async (_id, input) => {
  calls.push({ create: input })
  const entry = { slug: "created-stable-id", label: input.slug, directory: `/repo/.codenomad/worktrees/${input.slug}`, kind: "worktree" as const }
  entries.push(entry)
  return entry
}
serverApi.moveSessionFamily = async (_id, _session, input) => {
  calls.push({ move: input.worktreeSlug })
  session.location = { directory: entries.find(entry => entry.slug === input.worktreeSlug)!.directory }
  return { rootSessionId: session.id, sessionIds: [session.id], worktreeSlug: input.worktreeSlug }
}
serverApi.deleteWorktree = async (_id, slug) => { calls.push({ delete: slug }); entries.splice(entries.findIndex(entry => entry.slug === slug), 1) }
addInstance({ id, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client })
setSessions(previous => new Map(previous).set(id, new Map([[session.id, session]])))
await ensureWorktreesLoaded(id)
render(() => <ConfigProvider><I18nProvider><div style={{ width: "380px", margin: "40px" }}>
  <WorktreeSelector instanceId={id} sessionId={session.id} />
</div></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "en" })
;(window as any).fixture = {
  calls,
  location: () => session.location.directory,
  worktrees: () => getWorktrees(id),
  holdRefresh: () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    serverApi.fetchWorktrees = async () => {
      await pending
      return { isGitRepo: true, worktrees: entries.map(entry => ({ ...entry })) }
    }
    ;(window as any).fixture.releaseRefresh = async () => {
      release()
      await reloadWorktrees(id)
    }
  },
  backgroundUpdate: async () => {
    const old = entries.map(entry => ({ ...entry }))
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let requests = 0
    serverApi.fetchWorktrees = async () => {
      requests++
      if (requests === 1) {
        await pending
        return { isGitRepo: true, worktrees: old }
      }
      return { isGitRepo: true, worktrees: entries }
    }
    const initial = reloadWorktrees(id)
    await Promise.resolve()
    entries[1] = { ...entries[1], label: "renamed in background" }
    // Exercise the production dispatcher while an older HTTP reply is pending.
    ;(serverEvents as any).dispatchBatch([{ type: "workspace.worktreesChanged", workspaceId: id }])
    release()
    await initial
  },
}
