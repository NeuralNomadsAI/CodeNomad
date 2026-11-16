import { render } from "solid-js/web"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { BackgroundPushRow } from "../../../src/components/settings/background-push-row"
import { backgroundPushState, pushEnvironment, refreshBackgroundPush, updateBackgroundPushScope } from "../../../src/lib/background-push"
import { showToastNotification, getToastHistory } from "../../../src/lib/notifications"
import { ConfigProvider, updatePreferences } from "../../../src/stores/preferences"
import { useBackgroundPush } from "../../../src/lib/hooks/use-background-push"
import { addInstance } from "../../../src/stores/instances"
import { setSessions, activeSessionId } from "../../../src/stores/session-state"
import { attachInstanceTab, activeAppTabId } from "../../../src/stores/app-tabs"
import { releaseAppSessionRestoreGate } from "../../../src/stores/app-session-restore-gate"
import { authRecovery } from "../../../src/lib/auth-recovery"
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"

let config: any = { settings: { locale: "en" } }
serverApi.fetchConfigOwner = async () => config
serverApi.fetchStateOwner = async () => ({})
serverApi.patchConfigOwner = async (_owner, patch: any) => {
  config = { ...config, ...patch, settings: { ...config.settings, ...patch.settings } }
  return config
}
updateBackgroundPushScope(["project"], { v: 1, needsInput: true, sessionDone: true },
  { v: 1, type: "codenomad-push-copy", needsInput: "A conversation needs your answer.", sessionDone: "A conversation finished." })
const navigation = new URLSearchParams(location.search).has("navigation")
function seedProjects() { for (const id of ["project", "other"]) {
  const client: any = { session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) } } }
  addInstance({ id, folder: `/${id}`, port: 0, pid: 0, proxyPath: "", status: "ready", client })
  if (id !== "project" || !new URLSearchParams(location.search).has("closed")) attachInstanceTab(id)
  setSessions(previous => new Map(previous).set(id, new Map([["session", {
    id: "session", instanceId: id, title: id, parentId: null, status: "idle", agent: "build",
    location: { directory: `/${id}` }, time: { created: 1, updated: 1 },
  } as any]])))
} }
if (navigation && !new URLSearchParams(location.search).has("late")) seedProjects()
function Fixture() {
  if (navigation) useBackgroundPush()
  return <BackgroundPushRow />
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  refreshBackgroundPush,
  seedProjects,
  state: backgroundPushState,
  environment: pushEnvironment,
  release: releaseAppSessionRestoreGate,
  signIn: () => authRecovery.signIn("user", "fixture-password"),
  authRequired: authRecovery.required,
  selected: () => ({ tab: activeAppTabId(), session: activeSessionId().get("project") }),
  notify: async () => {
    await updatePreferences({ osNotificationsAllowWhenVisible: true, notificationRouting: {
      needsInput: { screen: false, history: true, system: true },
    } as any })
    showToastNotification({ category: "needsInput", instanceId: "project", message: "private-screen-only", variant: "info" })
    return getToastHistory().map(item => item.message)
  },
}
