import { render } from "solid-js/web"
import RightPanel from "../../../src/components/instance/shell/right-panel/RightPanel"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { setSessions } from "../../../src/stores/session-state"
import { initializeClientState, readClientLayoutValue } from "../../../src/stores/client-state"
import { RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY } from "../../../src/components/instance/shell/storage"
import type { Instance } from "../../../src/types/instance"
import type { Session } from "../../../src/types/session"
import "../../../src/index.css"

const instance: Instance = { id: "status-fixture", folder: "/fixture", port: 0, pid: 0, proxyPath: "/fixture", status: "ready", client: null }
const session: Session = {
  id: "status-session", instanceId: instance.id, parentId: null, title: "Status fixture", agent: "build",
  model: { providerId: "fixture", modelId: "fixture" }, status: "idle", retry: null, idleSince: null,
  generationRecovery: null, runtimeStatusKnown: true, version: "1", projectID: "fixture", location: { directory: "/fixture" },
  cost: 0.12, tokens: { input: 1200, output: 300, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
}
setSessions(previous => new Map(previous).set(instance.id, new Map([[session.id, session]])))

function Fixture() {
  const { t } = useI18n()
  return <div style={{ width: "360px", height: "800px" }}>
    <RightPanel isActive={() => true} t={t} instanceId={instance.id} instance={instance}
      activeSessionId={() => session.id} activeSession={() => session} isPhoneLayout={() => false}
      rightDrawerWidth={() => 360} rightDrawerWidthInitialized={() => true}
      onCloseRightDrawer={() => {}} promptInputApi={() => null} setContentEl={() => {}} />
  </div>
}

await initializeClientState()
render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).statusFixture = {
  customization: () => JSON.parse(readClientLayoutValue(RIGHT_PANEL_CUSTOMIZATION_STORAGE_KEY) ?? "{}"),
}
