import { render } from "solid-js/web"
import AlertDialog from "../../../src/components/alert-dialog"
import SessionSidebar from "../../../src/components/instance/shell/SessionSidebar"
import { useI18n, I18nProvider } from "../../../src/lib/i18n"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { ThemeProvider } from "../../../src/lib/theme"
import { addInstance } from "../../../src/stores/instances"
import { startNewSession } from "../../../src/stores/session-actions"
import { activeParentSessionId, setProviders, setSessions, type SessionThread } from "../../../src/stores/session-state"
import { ConfigProvider } from "../../../src/stores/preferences"
import { applyUiSettings } from "./ui-settings"
import "../../../src/index.css"

await applyUiSettings({ locale: "en" })

// Real sidebar, alert dialog and new-session action; only the network stalls.
const instanceId = "create-feedback"
let createCalls = 0
let settle: ((mode: "ok" | "fail") => void) | undefined
const created = { id: "created", projectID: "project", title: "New", location: { directory: "/fixture" },
  time: { created: 1, updated: 1 }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
const client: any = {
  session: {
    create: () => {
      createCalls++
      return new Promise((resolve, reject) => {
        settle = mode => (mode === "fail" ? reject(new Error("network stalled")) : resolve(created))
      })
    },
    get: async () => created,
    list: async () => ({ data: [], cursor: {} }),
    active: async () => ({}),
  },
  model: { default: async () => ({ data: { providerID: "fixture", id: "fixture" } }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setProviders(previous => new Map(previous).set(instanceId, [{ id: "fixture", name: "Fixture",
  models: [{ id: "fixture", providerId: "fixture", name: "Fixture" }] }]))
setSessions(previous => new Map(previous).set(instanceId, new Map()))

const Shell = () => {
  const { t } = useI18n()
  return <SessionSidebar
    t={t}
    instanceId={instanceId}
    threads={() => [] as SessionThread[]}
    activeSessionId={() => null}
    showSearch={() => false}
    onToggleSearch={() => {}}
    drawerState={() => "pinned"}
    onSelectSession={() => {}}
    onNewSession={() => startNewSession(instanceId)}
    history={{ canGoBack: () => false, canGoForward: () => false, goBack: () => {}, goForward: () => {} }}
    panelId="fixture-panel"
    setContentEl={() => {}}
  />
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider><Shell /><AlertDialog /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  createCalls: () => createCalls,
  // Fire-and-forget like the hotkey: the evaluate must not await a creation
  // that is intentionally still hanging.
  newSession: () => { void startNewSession(instanceId) },
  settle: (mode: "ok" | "fail") => settle?.(mode),
  activeParentId: () => activeParentSessionId().get(instanceId),
}
