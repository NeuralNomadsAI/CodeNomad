import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import SessionView from "../../../src/components/session/session-view"
import RightPanel from "../../../src/components/instance/shell/right-panel/RightPanel"
import type { PromptInputApi } from "../../../src/components/prompt-input/types"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { serverEvents } from "../../../src/lib/server-events"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { activeSessionId, clearActiveParentSession, sessions, setActiveParentSession, setProviders } from "../../../src/stores/session-state"
import { clearSelectedSession } from "../../../src/stores/session-state"
import { beginGesture } from "../../../src/stores/session-surface"
import { getAttachments } from "../../../src/stores/attachments"
import { fetchAgents, fetchSessions, hydrateRestoredSessionChain } from "../../../src/stores/session-api"
import { updateSessionAgent } from "../../../src/stores/session-actions"
import { applyUiSettings } from "./ui-settings"
import { serverApi } from "../../../src/lib/api-client"
import AlertDialog from "../../../src/components/alert-dialog"
import { reloadWorktrees, setWorktreeSlugForParentSession } from "../../../src/stores/worktrees"
import { Toaster } from "solid-toast"
import "../../../src/index.css"

// The real composer beside the real right panel, so API 4 frames act through the
// actual bridge, channels and PromptInput; the native client is a deterministic fake.
await applyUiSettings({ locale: "en" })
const instanceId = "api4-instance"
const phone = new URL(location.href).searchParams.has("phone")
const state = { prompts: 0, commands: 0, closed: 0 }
const mark = { "codenomad.companion": "images" }
const infos: Record<string, any> = {
  ses_work: { agent: "build", title: "Work" },
  ses_other: { agent: "build", title: "Other" },
  ses_images: { agent: "design", title: "Images", metadata: mark },
  // Created by an `open`: absent from the list, so showing it hydrates it first.
  ses_fresh: { agent: "design", title: "Images", metadata: mark },
}
const listed = ["ses_work", "ses_other", "ses_images"]
// `holdHydration()` keeps the next reads of a session waiting until `releaseHydration()`.
let held: string | undefined, waiting: Array<() => void> = []
const info = (id: string) => ({ id, projectID: "fixture", location: { directory: "/fixture" }, cost: 0, model: { providerID: "fixture", id: "chosen" },
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 }, ...infos[id] })
const agent = (id: string) => ({ id, name: id[0]!.toUpperCase() + id.slice(1), mode: "primary", description: "" })
const client: any = {
  session: {
    active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    list: async () => ({ data: listed.map(info), cursor: {} }),
    // Hydrating a conversation takes a network round trip.
    get: async ({ sessionID }: any) => {
      await new Promise(resolve => setTimeout(resolve, 50))
      if (sessionID === held) await new Promise<void>(resolve => waiting.push(resolve))
      return info(sessionID)
    },
    update: async ({ sessionID }: any) => info(sessionID),
    instructions: { entry: { remove: async () => {}, put: async () => {} } },
    switchAgent: async () => {}, switchModel: async () => {},
    prompt: async () => { state.prompts++; return {} },
    command: async () => { state.commands++; return {} },
  },
  agent: { list: async () => ({ data: [agent("build"), agent("design")] }), get: async ({ agentID }: any) => ({ data: agent(agentID) }) },
  model: { default: async () => ({ data: { providerID: "fixture", id: "chosen" } }) },
  message: { list: async () => ({ data: [], cursor: {} }) },
}
// The project's worktrees; creating one and moving a family are recorded, and moves can be refused.
const worktrees: any[] = [{ slug: "root", label: "main", directory: "/fixture", kind: "root", branch: "main" }]
const worktreeCalls: unknown[] = [], refusal = { move: false }
// `fixture.cachedInventory`, when set, is what a non-fresh read answers, as the server's cache may.
serverApi.fetchWorktrees = async (_id, fresh) => ({ isGitRepo: true, defaultDirectory: "/fixture/.codenomad/worktrees",
  worktrees: [...(!fresh && (window as any).fixture?.cachedInventory ? (window as any).fixture.cachedInventory : worktrees)] })
serverApi.createWorktree = async (_id, input) => {
  worktreeCalls.push({ create: input.slug })
  // `fixture.gate`, when set, holds the creation until the test opens it.
  await (window as any).fixture.gate
  const entry = { slug: input.slug, label: input.slug, directory: `/fixture/.codenomad/worktrees/${input.slug}`, kind: "worktree", branch: input.slug }
  worktrees.push(entry)
  return entry
}
serverApi.moveSessionFamily = async (_id, sessionId, input) => {
  worktreeCalls.push({ move: [sessionId, input.worktreeSlug] })
  // `fixture.moveGate`, when set, holds the move until the test opens it.
  await (window as any).fixture.moveGate
  if (refusal.move) throw new Error("Fixture move refused")
  infos[sessionId]!.location = { directory: worktrees.find(entry => entry.slug === input.worktreeSlug)!.directory }
  return { rootSessionId: sessionId, sessionIds: [sessionId], worktreeSlug: input.worktreeSlug } as any
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setActiveInstanceId(instanceId)
setProviders(prev => new Map(prev).set(instanceId, [{ id: "fixture", name: "Fixture", defaultModelId: "chosen", models: [
  { id: "chosen", name: "Chosen", providerId: "fixture", limit: { context: 10000, output: 1000 }, cost: { input: 0, output: 0 } },
] }]))
await fetchSessions(instanceId)
setActiveParentSession(instanceId, "ses_work")
await fetchAgents(instanceId, { directory: "/fixture" }, true)

const [apis, setApis] = createSignal<Record<string, PromptInputApi | null>>({})
const [panelOpen, setPanelOpen] = createSignal(true)
const active = () => activeSessionId().get(instanceId) ?? null
const promptApi = () => { const id = active(); return id ? apis()[id] ?? null : null }

function Fixture() {
  const { t } = useI18n()
  return <div style={{ display: "flex", height: "100dvh", width: "100vw", position: "relative" }}>
    <div style={{ flex: "1", "min-width": "0", display: "flex" }}>
      <Show when={active()} keyed>{id =>
        <SessionView sessionId={id} activeSessions={sessions().get(instanceId)!} instanceId={instanceId} instanceFolder="/fixture"
          escapeInDebounce={false} isActive={true} onAgentChange={agentId => updateSessionAgent(instanceId, id, agentId)} onModelChange={async () => {}}
          registerSessionPromptApi={(sessionId, api) => setApis(current => ({ ...current, [sessionId]: api }))} />
      }</Show>
    </div>
    <Show when={panelOpen()}>
      <div class="session-shell-panels" style={phone ? { position: "absolute", inset: "0", background: "var(--surface-canvas)" } : { width: "420px", position: "relative" }}>
        <RightPanel instanceId={instanceId} instance={{ id: instanceId, folder: "/fixture", status: "ready", client: null, port: 0, pid: 0, proxyPath: "/fixture" } as any}
          isActive={() => true} t={t} activeSessionId={active} activeSession={() => null} isPhoneLayout={() => phone}
          rightDrawerWidth={() => 420} rightDrawerWidthInitialized={() => true}
          // The phone's temporary drawer unmounts its content after its exit transition.
          onCloseRightDrawer={() => { state.closed++; setTimeout(() => setPanelOpen(false), 225) }} promptInputApi={promptApi} setContentEl={() => {}} />
      </div>
    </Show>
  </div>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /><AlertDialog /><Toaster position="top-right" /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

// Frames report answers that outlive them (navigation, closing) to the host page.
const frameMessages: unknown[] = []
window.addEventListener("message", event => { if (event.data?.fixtureAnswer) frameMessages.push(event.data.fixtureAnswer) })
;(window as any).fixture = {
  frameMessages: () => frameMessages.splice(0),
  show: async (id: string) => {
    const intent = beginGesture({ instanceId, sessionId: id })
    await hydrateRestoredSessionChain(instanceId, [id])
    setActiveParentSession(instanceId, id, intent)
  },
  clear: () => clearSelectedSession(instanceId),
  holdHydration: (id: string) => { held = id },
  hydrationWaiting: () => waiting.length,
  releaseHydration: () => { held = undefined; for (const resolve of waiting.splice(0)) resolve() },
  openPanel: () => setPanelOpen(true),
  worktreeCalls: () => worktreeCalls.splice(0),
  refuseMoves: (value: boolean) => { refusal.move = value },
  reloadWorktrees: () => reloadWorktrees(instanceId),
  freezeInventory: () => { (window as any).fixture.cachedInventory = [...worktrees] },
  addWorktree: (slug: string, branch: string, nestedFolderMissing = false) => {
    worktrees.push({ slug, label: branch, directory: `/fixture/.codenomad/worktrees/${slug}`, kind: "worktree", branch, ...(nestedFolderMissing ? { nestedFolderMissing } : {}) })
  },
  move: (slug: string) => setWorktreeSlugForParentSession(instanceId, "ses_work", slug).catch(() => {}),
  location: (id: string) => infos[id]?.location?.directory ?? "/fixture",
  changed: () => (serverEvents as any).dispatchBatch([{ type: "storage.stateChanged", owner: "panelExtensions", value: {} }]),
  event: (event: unknown) => (serverEvents as any).dispatchBatch([event]),
  snapshot: () => ({ ...state, active: active(), panelOpen: panelOpen(),
    attachments: listed.reduce((count, id) => count + getAttachments(instanceId, id).length, 0),
    draft: (document.querySelector("textarea.prompt-input") as HTMLTextAreaElement | null)?.value ?? null,
    focused: document.activeElement?.classList.contains("prompt-input") === true }),
}
