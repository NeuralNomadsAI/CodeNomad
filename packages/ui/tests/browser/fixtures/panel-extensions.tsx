import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import RightPanel from "../../../src/components/instance/shell/right-panel/RightPanel"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { serverEvents } from "../../../src/lib/server-events"
import "../../../src/index.css"

function Fixture() {
  const { t } = useI18n()
  const [instanceId, setInstanceId] = createSignal("first"), [sessionId, setSessionId] = createSignal("session-a")
  const [active, setActive] = createSignal(true)
  ;(window as any).extensionFixture = { instance: setInstanceId, session: setSessionId, active: setActive,
    changed: () => (serverEvents as any).dispatchBatch([{ type: "storage.stateChanged", owner: "panelExtensions", value: {} }]),
    transport: (value: string) => (serverEvents as any).emitTransportStatus(value),
  }
  return <div style={{ height: "800px", width: "550px" }}>
    <RightPanel instanceId={instanceId()} instance={{ id: instanceId(), folder: `/${instanceId()}`, status: "ready", client: null, port: 0, pid: 0, proxyPath: "/fixture" }}
      isActive={active} t={t} activeSessionId={sessionId} activeSession={() => null} isPhoneLayout={() => false}
      rightDrawerWidth={() => 550} rightDrawerWidthInitialized={() => true} onCloseRightDrawer={() => {}}
      promptInputApi={() => null} setContentEl={() => {}} />
  </div>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
