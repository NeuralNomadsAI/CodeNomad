import { createSignal, onMount, Show } from "solid-js"
import Drawer from "@suid/material/Drawer"
import { render } from "solid-js/web"
import RightPanel from "../../../src/components/instance/shell/right-panel/RightPanel"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider, useTheme } from "../../../src/lib/theme"
import { serverEvents } from "../../../src/lib/server-events"
import "../../../src/index.css"

function Fixture() {
  const { t } = useI18n()
  const theme = useTheme()
  const [instanceId, setInstanceId] = createSignal("first"), [sessionId, setSessionId] = createSignal("session-a")
  const [active, setActive] = createSignal(true)
  const floating = new URL(location.href).searchParams.has("drawer")
  const [ready, setReady] = createSignal(false)
  onMount(() => setReady(true))
  let host!: HTMLDivElement
  ;(window as any).extensionFixture = { instance: setInstanceId, session: setSessionId, active: setActive,
    theme: theme.setThemeMode,
    changed: () => (serverEvents as any).dispatchBatch([{ type: "storage.stateChanged", owner: "panelExtensions", value: {} }]),
    transport: (value: string) => (serverEvents as any).emitTransportStatus(value),
  }
  const panel = () => <RightPanel instanceId={instanceId()} instance={{ id: instanceId(), folder: `/${instanceId()}`, status: "ready", client: null, port: 0, pid: 0, proxyPath: "/fixture" }}
      isActive={active} t={t} activeSessionId={sessionId} activeSession={() => null} isPhoneLayout={() => floating}
      rightDrawerWidth={() => 550} rightDrawerWidthInitialized={() => true} onCloseRightDrawer={() => {}}
      promptInputApi={() => null} setContentEl={() => {}} />
  return <div ref={host} class="session-shell-panels" style={{ height: "min(800px, 100dvh)", width: "min(550px, 100vw)", position: "relative" }}>
    <Show when={floating} fallback={panel()}>
      <Show when={ready()}>
        <Drawer class="session-floating-drawer" anchor="right" variant="temporary" open ModalProps={{ container: host }}>
          {panel()}
        </Drawer>
      </Show>
    </Show>
  </div>
}
render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
