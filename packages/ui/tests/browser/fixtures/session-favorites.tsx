import { createMemo, createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import SessionSidebar from "../../../src/components/instance/shell/SessionSidebar"
import AlertDialog from "../../../src/components/alert-dialog"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { serverApi } from "../../../src/lib/api-client"
import { serverEvents } from "../../../src/lib/server-events"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance, setActiveInstanceId } from "../../../src/stores/instances"
import { cleanupBlankSessions, getSessionThreads, sessions, setSessions, setSessionPage } from "../../../src/stores/session-state"
import { activeSessionId, setActiveSessionId } from "../../../src/stores/session-selection-state"
import { registerNavigationShortcuts } from "../../../src/lib/shortcuts/navigation"
import { keyboardRegistry } from "../../../src/lib/keyboard-registry"
import PromptInput from "../../../src/components/prompt-input"
import PromptAttachmentsBar from "../../../src/components/prompt-input/PromptAttachmentsBar"
import RecoveredDrafts from "../../../src/components/prompt-input/recovered-drafts"
import { addAttachment, clearAttachments, clearInstanceAttachments, getAttachments, getSessionAttachmentsForInstance } from "../../../src/stores/attachments"
import { setSessionDraftPrompt } from "../../../src/stores/session-state"
import { NO_SESSION_DRAFT_SESSION_ID } from "../../../src/stores/app-session-workspace-hydration"
import { createFileAttachment } from "../../../src/types/attachment"
import { clearInstanceDraftPrompts, clearSessionDraftPrompt, getSessionDraftPromptsForInstance } from "../../../src/stores/session-state"
import { hydrateRestoredWorkspaceState } from "../../../src/stores/app-session-workspace-hydration"
import { serializeDraftAttachments } from "../../../src/stores/client-state-attachments-codec"
import { decodeClientSnapshotV2, encodeClientSnapshotV2 } from "../../../src/stores/client-state-partitions"
import { retainClosedWorkspaceDrafts, restoreClosedWorkspaceDrafts } from "../../../src/stores/closed-workspace-drafts"
import { recoveredDraftIds } from "../../../src/stores/session-draft-recovery"
import { createClientSession } from "../../../src/types/session"
import { ensureWorktreesLoaded, getWorktreeSlugForSession } from "../../../src/stores/worktrees"
import { SESSION_PLACEMENT_HEADER } from "../../../../server/src/opencode/session-access-contract"
import "../../../src/index.css"

const id = "favorites-workspace", main = "/bureau", ventes = "/bureau-ventes"
const start = Date.UTC(2026, 0, 5, 8)
const make = (key: string, title: string, age: number, directory = main, parentID?: string) => ({
  id: `ses_${key}`, title, projectID: "bureau", agent: "build", location: { directory }, parentID,
  model: { providerID: "fixture", id: "fixture" }, time: { created: start + age, updated: start + age },
  ...(key === "briefing" ? { metadata: { thirdParty: { verified: "leave alone" } } } : {}),
})
const seed = [
  make("briefing", "Briefing du matin", 1),
  make("equipe", "Équipe", 63.5),
  make("validation", "Validation budget", 3),
  make("conseil", "Préparer conseil", 4, main, "ses_equipe"),
  make("conseil_notes", "Notes du conseil", 5, main, "ses_equipe"),
  make("search_only", "Projet secret", 0),
  ...Array.from({ length: 60 }, (_, index) => {
    const n = String(index + 1).padStart(2, "0")
    return make(`dossier_${n}`, `Dossier ${n}`, index + 5, index === 0 ? "/bureau/ventes-alias" : index % 2 ? ventes : main)
  }),
]
const initial = seed.filter(row => row.id !== "ses_dossier_01" && row.id !== "ses_search_only")
const native = new Map(seed.map(row => [row.id, row]))
const gets: string[] = [], lists: unknown[] = [], removes: string[] = []
const blank = new Set(["ses_briefing", "ses_conseil", "ses_dossier_01"])
const active = { ses_dossier_60: { type: "busy" } }
let sequence = 0
const emit = (type: string, data: Record<string, unknown>, directory = main) => {
  const seq = ++sequence
  ;(serverEvents as any).dispatchBatch([{ type: "instance.event", instanceId: id, event: {
    type, data, id: `evt_fixture_${seq}`, location: { directory }, created: start + 100 + seq,
    durable: { aggregateID: data.sessionID, seq, version: 1 },
  } }])
}
const client = {
  session: {
    get: async ({ sessionID }: { sessionID: string }, options?: { headers?: HeadersInit }) => {
      gets.push(sessionID)
      if (sessionID === "ses_fixture_transport") throw new Error("fixture transport unavailable")
      if (sessionID === "ses_fixture_foreign") throw Object.assign(new Error("fixture foreign location"), { status: 403 })
      if (!native.has(sessionID)) throw { _tag: "SessionNotFoundError", sessionID, message: "Gone" }
      const session = structuredClone(native.get(sessionID)!)
      return sessionID === "ses_dossier_01" && new Headers(options?.headers).get(SESSION_PLACEMENT_HEADER) === "1"
        ? { ...session, listWorktreeSlug: "ventes" } : session
    },
    list: async (input: { parentID?: string | null; directory?: string; search?: string; cursor?: string }) => {
      lists.push(input)
      const rows = [...native.values()]
      const data = input.cursor ? rows.filter(row => row.id === "ses_dossier_01") : rows
        .filter(row => input.search || row.id !== "ses_search_only")
        .filter(row => input.parentID === undefined || (row.parentID ?? null) === input.parentID)
        .filter(row => !input.directory || input.directory === row.location.directory)
        .filter(row => !input.search || row.title.toLowerCase().includes(input.search))
      return { data, cursor: {} }
    },
    inbox: { list: async () => [] },
    active: async () => active,
    remove: async ({ sessionID }: { sessionID: string }) => {
      await fetch("/fixture-native-delete", { method: "POST", body: sessionID })
      removes.push(sessionID)
      native.delete(sessionID)
      emit("session.deleted", { sessionID })
    },
    update: async () => { throw new Error("Favorites must not update native session metadata") },
  },
  message: { list: async ({ sessionID }: { sessionID: string }) => ({ data: blank.has(sessionID) ? [] : [{ type: "user" }], cursor: {} }) },
}
;(sdkManager as any).clients.set(`${id}:/workspaces/${id}/instance`, client)
const config = { settings: { locale: "fr" } }
serverApi.fetchConfigOwner = async () => config as any
serverApi.patchConfigOwner = async (_owner, patch) => Object.assign(config, patch) as any
serverApi.fetchStateOwner = async () => ({} as any)
serverApi.fetchWorktrees = async () => ({ isGitRepo: true, worktrees: [
  { slug: "root", label: "main", directory: main, kind: "root" },
  { slug: "ventes", label: "ventes", directory: ventes, kind: "worktree" },
] })
addInstance({ id, folder: main, port: 0, pid: 0, proxyPath: `/workspaces/${id}/instance`, status: "ready", client } as any)
setActiveInstanceId(id)
registerNavigationShortcuts()
setSessions(previous => new Map(previous).set(id, new Map(initial.map(row => [row.id, {
  ...createClientSession(row as any, id, "build", { providerId: "fixture", modelId: "fixture" }),
  status: row.id === "ses_dossier_60" ? "working" : "idle",
}]))))
setSessionPage(id, initial.filter(row => !row.parentID).map(row => row.id), true, true, "fixture-older-page")
await ensureWorktreesLoaded(id)
const [search, setSearch] = createSignal(false)
const [shown, setShown] = createSignal(true)
const [activeId, setActiveId] = createSignal<string | null>(null)
function Fixture() {
  const { t } = useI18n()
  const threads = createMemo(() => getSessionThreads(id))
  return <main style={{ height: "100dvh", display: "flex" }}>
    <Show when={shown()}>
      <aside style={{ flex: "0 0 min(320px, 100vw)", height: "100%", "border-inline-end": "1px solid var(--border-base)" }}>
        <SessionSidebar t={t} instanceId={id} threads={threads} activeSessionId={activeId}
          showSearch={search} onToggleSearch={() => setSearch(value => !value)} drawerState={() => "pinned"}
          onSelectSession={setActiveId} onNewSession={() => {}} panelId="fixture-sidebar" setContentEl={() => {}}
          history={{ canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} }} />
      </aside>
    </Show>
    <section class="p-3 flex-1 bg-surface-canvas">
      <button type="button" class="button-tertiary" onClick={() => setShown(value => !value)}>Bureau</button>
      <Show when={getAttachments(id, NO_SESSION_DRAFT_SESSION_ID).length > 0 || recoveredDraftIds(id).length > 0}><div data-recovered-composer>
        <RecoveredDrafts instanceId={id} />
        <PromptAttachmentsBar attachments={getAttachments(id, NO_SESSION_DRAFT_SESSION_ID)} onRemoveAttachment={() => {}} />
        <PromptInput instanceId={id} instanceFolder={main} sessionId={NO_SESSION_DRAFT_SESSION_ID}
          onSend={() => {}} onCommand={() => {}} onRunShell={() => {}} />
      </div></Show>
    </section>
    <AlertDialog />
  </main>
}
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
await updatePreferences({ locale: "fr" })
const readSaved = async () => {
  const raw = sessionStorage.getItem("fixture-saved-drafts")
  if (!raw) return
  const { root, partitions } = JSON.parse(raw)
  const snapshot = await decodeClientSnapshotV2(root, 1, async key => partitions[key] ?? null)
  const tab = snapshot?.session?.tabs[0]
  if (tab?.kind !== "workspace") throw new Error("Draft snapshot did not round-trip")
  await hydrateRestoredWorkspaceState(id, tab, new AbortController().signal, () => true)
}
if (sessionStorage.getItem("fixture-clear-draft")) {
  clearSessionDraftPrompt(id, "ses_fixture_cleared")
  clearAttachments(id, "ses_fixture_cleared")
}
if (sessionStorage.getItem("fixture-delete-before-restore")) {
  emit("session.deleted", { sessionID: "ses_fixture_absent" })
  emit("session.deleted", { sessionID: "ses_fixture_cleared" })
}
await readSaved()
void serverEvents.connect()
emit("permission.asked", { sessionID: "ses_validation", id: "fixture-permission", action: "read", resources: ["budget"] })
Object.assign(window, { favoriteFixture: {
  gets, lists, removes, activeId,
  placement: (sessionID: string) => ({
    location: sessions().get(id)?.get(sessionID)?.location.directory,
    slug: getWorktreeSlugForSession(id, sessionID),
  }),
  has: (sessionID: string) => sessions().get(id)?.has(sessionID),
  selected: () => activeSessionId().get(id),
  navigate: (command: string, from: string) => {
    setActiveSessionId(new Map([[id, from]]))
    keyboardRegistry.get(command)?.handler()
  },
  draftDuringCleanup: (target: string) => {
    setSessionDraftPrompt(id, target, "À relire demain")
    addAttachment(id, target, createFileAttachment("note.txt", "note.txt", "text/plain", new Uint8Array([98, 111, 110])))
  },
  recoveredBytes: () => getAttachments(id, NO_SESSION_DRAFT_SESSION_ID).map(value =>
    value.source.type === "file" ? Array.from(value.source.data ?? []) : null),
  deleteEvent: (sessionID: string) => emit("session.deleted", { sessionID }),
  prepareDrafts: (direct: boolean) => {
    const source = "ses_fixture_absent"
    setSessionDraftPrompt(id, NO_SESSION_DRAFT_SESSION_ID, "a".repeat(32000))
    addAttachment(id, NO_SESSION_DRAFT_SESSION_ID, createFileAttachment("main.txt", "main.txt", "text/plain", new Uint8Array([1])))
    setSessionDraftPrompt(id, source, "b".repeat(2000))
    addAttachment(id, source, createFileAttachment("second.txt", "second.txt", "text/plain", new Uint8Array([2, 3])))
    if (direct) emit("session.deleted", { sessionID: source })
    else {
      setSessionDraftPrompt(id, "ses_fixture_transport", "transport draft stays unresolved")
      setSessionDraftPrompt(id, "ses_fixture_foreign", "foreign draft is not recovered here")
      setSessionDraftPrompt(id, "ses_fixture_cleared", "cleared before restoration")
      addAttachment(id, "ses_fixture_cleared", createFileAttachment("cleared.txt", "cleared.txt"))
      sessionStorage.setItem("fixture-clear-draft", "1")
    }
  },
  saveDrafts: async () => {
    const encoded = await encodeClientSnapshotV2({ version: 1, revision: 1, savedAt: 10, layout: {}, session: {
      activeTabIndex: 0, tabs: [{ kind: "workspace", folder: main, scrollSnapshots: {}, unseenIdleSince: {}, generationRecovery: {},
        ...serializeDraftAttachments(getSessionDraftPromptsForInstance(id), getSessionAttachmentsForInstance(id)) }],
    } })
    sessionStorage.setItem("fixture-saved-drafts", JSON.stringify(encoded))
  },
  readSaved,
  restoreWithEarlyDeletion: () => sessionStorage.setItem("fixture-delete-before-restore", "1"),
  simulateTabReopen: () => {
    retainClosedWorkspaceDrafts(id, main)
    clearInstanceDraftPrompts(id)
    clearInstanceAttachments(id)
    return restoreClosedWorkspaceDrafts(id, main, async () => {})
  },
  clearFixtureDraft: () => {
    clearSessionDraftPrompt(id, "ses_fixture_cleared")
    clearAttachments(id, "ses_fixture_cleared")
  },
  clearRecoveredComposer: () => {
    clearSessionDraftPrompt(id, NO_SESSION_DRAFT_SESSION_ID)
    clearAttachments(id, NO_SESSION_DRAFT_SESSION_ID)
  },
  metadata: () => native.get("ses_briefing")?.metadata,
  automatic: () => cleanupBlankSessions(id),
  deep: () => { blank.add("ses_dossier_02"); return cleanupBlankSessions(id, undefined, true) },
  store: () => ({ loaded: sessions().get(id)?.size }),
} })
