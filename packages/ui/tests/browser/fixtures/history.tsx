import { render } from "solid-js/web"
import { createSignal, Show } from "solid-js"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import MessageSection from "../../../src/components/message-section"
import { MESSAGE_STREAM_SCROLL_SCOPE, messageStoreBus } from "../../../src/stores/message-v2/bus"
import { activeSessionId } from "../../../src/stores/sessions"
import { getSessionPreview, openSessionPreview } from "../../../src/stores/session-previews"
import { ensureWorktreesLoaded } from "../../../src/stores/worktrees"
import { setSessionSearchOpen } from "../../../src/stores/session-search"
import { serverApi } from "../../../src/lib/api-client"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import "../../../src/index.css"

const instanceId = "history", sessionId = "s"
let config = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => config as any
serverApi.patchConfigOwner = async (_owner, patch: any) => (config = { ...config, ...patch, settings: { ...config.settings, ...patch.settings } }) as any
serverApi.fetchStateOwner = async () => ({} as any)
const previewReads: string[] = []
// Session label reads: count per ID and the peak number in flight.
const sessionReads: string[] = []
let sessionReadsInFlight = 0, peakSessionReads = 0
serverApi.fetchWorktrees = async () => ({ isGitRepo: true, defaultDirectory: "/repo/.codenomad/worktrees", worktrees: [
  { slug: "root", label: "dev", directory: "/repo", kind: "root" as const, branch: "dev" },
  { slug: "feature", label: "feature/search", directory: "/repo/.codenomad/worktrees/feature", kind: "worktree" as const, branch: "feature/search" },
] })
// other-session-N: even N live in the feature worktree, N = 3 has no native session.
const nativeSession = (sessionID: string) => {
  const index = Number(sessionID.split("-").pop())
  if (index === 3) throw Object.assign(new Error("Session not found"), { _tag: "SessionNotFoundError" })
  return { id: sessionID, title: `Conversation ${index}`, projectID: "project", time: { created: 1, updated: 1 },
    location: { directory: index % 2 === 0 ? "/repo/.codenomad/worktrees/feature" : "/repo" } }
}
const client: any = { session: {
  get: async ({ sessionID }: { sessionID: string }) => {
    sessionReads.push(sessionID)
    peakSessionReads = Math.max(peakSessionReads, ++sessionReadsInFlight)
    try {
      await new Promise(resolve => setTimeout(resolve, 20))
      return sessionID.startsWith("other-session-") ? nativeSession(sessionID) : { title: "Historical session title" }
    } finally { sessionReadsInFlight -= 1 }
  },
  message: { get: async ({ messageID }: { messageID: string }) => {
    previewReads.push(messageID)
    return { type: "user", text: "Full selected historical message\nCaFé éTé", time: { created: Date.now() - 3 * 3600_000 } }
  } },
} }
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${instanceId}/instance`, status: "ready", client })
await ensureWorktreesLoaded(instanceId)
const store = messageStoreBus.getOrCreate(instanceId)
store.upsertMessage({ id: "resident", sessionId, role: "user", status: "complete", createdAt: 1, parts: [{ id: "text", type: "text", text: "Resident message" }] })
store.upsertMessage({ id: "unloaded-2", sessionId: "other-session-2", role: "user", status: "complete", createdAt: 1,
  parts: [{ id: "destination-text", type: "text", text: "Full café ÉTÉ destination" }] })
const [active, setActive] = createSignal(true)
let loads = 0
const load = async () => { loads++; throw new Error("Search must not load transcript pages") }
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <div style={{ width: "1100px", height: "700px", display: "flex" }}>
    <Show when={activeSessionId().get(instanceId) ?? sessionId} keyed>{shown =>
      <MessageSection instanceId={instanceId} sessionId={shown} isActive={active()} hasMoreMessages={false}
        onLoadOldestMessages={load} onLoadNewerMessages={load} onLoadMoreMessages={load} />
    }</Show>
  </div>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  open: () => { updatePreferences({ locale: "en" }); setSessionSearchOpen(instanceId, sessionId, true) },
  deactivate: () => setActive(false),
  activate: () => setActive(true),
  snapshot: () => ({ ids: store.getSessionMessageIds(sessionId), loads, previewReads }),
  sessionReads: () => ({ reads: [...sessionReads], peak: peakSessionReads }),
  // The destination was last left on its browser preview.
  showDestinationPreview: async () => {
    serverApi.createPreview = async () => ({ token: "fixture", sessionId: "other-session-2", targetUrl: "https://example.com", url: "/preview/fixture" }) as any
    await openSessionPreview("other-session-2", "https://example.com", "/repo")
    return getSessionPreview("other-session-2", "/repo")?.mode
  },
  opened: () => ({ active: activeSessionId().get(instanceId) ?? null,
    anchor: store.getScrollSnapshot("other-session-2", MESSAGE_STREAM_SCROLL_SCOPE)?.anchorKey ?? null,
    surface: getSessionPreview("other-session-2", "/repo")?.mode ?? null }),
}
