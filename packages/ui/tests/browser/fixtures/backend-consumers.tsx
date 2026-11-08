import { render } from "solid-js/web"
import PromptInput from "../../../src/components/prompt-input"
import MissionControl from "../../../src/components/instance/shell/right-panel/tabs/MissionControl"
import { MissionReader } from "../../../src/components/mission-reader"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverApi } from "../../../src/lib/api-client"
import { backends, createBackendClient, type BackendClient } from "../../../src/lib/backend-client"
import { backendEvents } from "../../../src/lib/backend-events"
import { addInstance } from "../../../src/stores/instances"
import { updateMissionProjectView } from "../../../src/stores/mission-view-state"
import { settleAbandonedSessionListRestoration } from "../../../src/stores/session-list-restoration"
import "../../../src/index.css"

const folder = "C:\\Exact\\History\\"
const mode = new URLSearchParams(location.search).get("mode")
const reads: string[] = []
// A remote view owns an explicitly attached backend, even with mocked HTTP.
const lab = createBackendClient({ id: "lab", baseUrl: location.origin, relayProfileId: "lab" })
;(backends as Map<string, BackendClient>).set("lab", lab)
backendEvents.attach("lab", lab.events)
serverApi.fetchConfigOwner = async () => ({ settings: { locale: "en" } }) as any
serverApi.fetchStateOwner = async () => ({}) as any
serverApi.readInstanceData = async key => {
  reads.push(key)
  return { messageHistory: key === folder ? ["legacy local history"] : key === `lab~${folder}` ? ["remote history"] : [], agentModelSelections: {} }
}
for (const id of ["w1", "lab~w1", "lab~mission"]) {
  addInstance({ id, ...(id.startsWith("lab~") ? { backendId: "lab" } : {}), folder: id.endsWith("mission") ? "/repo" : folder,
    status: "starting", client: null, proxyPath: "", port: 0, pid: 0, metadata: { project: { id: "p" } as any } })
  settleAbandonedSessionListRestoration(id)
}
updateMissionProjectView("lab~/repo", { reader: { kind: "recurrence", missionId: "daily", instanceId: "lab~mission", projectID: "p" } })
function Fixture() {
  const { t } = useI18n()
  return <>
    <section data-composer="local"><PromptInput instanceId="w1" instanceFolder={folder} sessionId="s1" onSend={async () => {}} escapeInDebounce={false} /></section>
    <section data-composer="remote"><PromptInput instanceId="lab~w1" instanceFolder={folder} sessionId="s1" onSend={async () => {}} escapeInDebounce={false} /></section>
    {mode === "control" ? <MissionControl instanceId="lab~mission" activeSessionId={() => null} isActive={() => true} t={t} />
      : <MissionReader instanceId="lab~mission" scope="lab~/repo" />}
  </>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).backendConsumers = { reads, folder }
