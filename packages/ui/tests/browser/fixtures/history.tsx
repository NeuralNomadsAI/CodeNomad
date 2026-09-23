import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import MessageSection from "../../../src/components/message-section"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
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
const client: any = { session: {
  get: async () => ({ title: "Historical session title" }),
  message: { get: async ({ messageID }: { messageID: string }) => {
    previewReads.push(messageID)
    return { type: "user", text: "Full selected historical message" }
  } },
} }
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/repo", port: 0, pid: 0, proxyPath: `/workspaces/${instanceId}/instance`, status: "ready", client })
const store = messageStoreBus.getOrCreate(instanceId)
store.upsertMessage({ id: "resident", sessionId, role: "user", status: "complete", createdAt: 1, parts: [{ id: "text", type: "text", text: "Resident message" }] })
const [active, setActive] = createSignal(true)
let loads = 0
const load = async () => { loads++; throw new Error("Search must not load transcript pages") }
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <div style={{ width: "1100px", height: "700px", display: "flex" }}>
    <MessageSection instanceId={instanceId} sessionId={sessionId} isActive={active()} hasMoreMessages={false}
      onLoadOldestMessages={load} onLoadNewerMessages={load} onLoadMoreMessages={load} />
  </div>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  open: () => { updatePreferences({ locale: "en" }); setSessionSearchOpen(instanceId, sessionId, true) },
  deactivate: () => setActive(false),
  snapshot: () => ({ ids: store.getSessionMessageIds(sessionId), loads, previewReads }),
}
