import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import InstanceTabs from "../../../src/components/instance-tabs"
import RightPanel from "../../../src/components/instance/shell/right-panel/RightPanel"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { applyColorScheme, normalizeColorScheme } from "../../../src/lib/theme-scheme"
import type { AppTabRecord } from "../../../src/stores/app-tabs"
import type { Instance } from "../../../src/types/instance"
import "../../../src/index.css"

const instance: Instance = { id: "tab-fixture", folder: "D:/fixture", port: 0, pid: 0, proxyPath: "/fixture", status: "ready", client: null }
const tabs = Array.from({ length: 9 }, (_, i): AppTabRecord => ({
  id: `instance:${i}`, kind: "instance", instance: { ...instance, id: `fixture-${i}`, folder: `D:/Project-${i}`, projectName: `Project ${i} — workspace` },
}))
tabs[2] = { id: "sidecar:preview", kind: "sidecar", sidecarTab: {
  token: "preview", sidecarId: "preview", name: "Preview", prefixMode: "strip",
  proxyBasePath: "/fixture/preview", shellUrl: "/fixture/preview",
} }

function Fixture() {
  const { t } = useI18n()
  const [count, setCount] = createSignal(9)
  const [active, setActive] = createSignal(tabs[1].id)
  const [order, setOrder] = createSignal(tabs)
  ;(window as any).tabFixture = {
    count: setCount,
    palette: (id: string) => applyColorScheme(normalizeColorScheme(id)),
  }
  applyColorScheme(normalizeColorScheme("classic"))
  return <>
    <section data-fixture="instances" style={{ width: "min(900px, 100%)" }}>
      <InstanceTabs tabs={order().slice(0, count())} activeTabId={active()} onSelect={setActive}
        onClose={() => {}} onNew={() => {}}
        onMoveTab={(id, target, placement) => setOrder(current => {
          const moving = current.find(tab => tab.id === id)!
          const next = current.filter(tab => tab.id !== id)
          next.splice(next.findIndex(tab => tab.id === target) + (placement === "after" ? 1 : 0), 0, moving)
          return next
        })} />
      <div style={{ height: "35px", background: "var(--surface-shade-light)" }} />
    </section>
    <section data-fixture="right" style={{ width: "280px", height: "170px", "margin-top": "32px" }}>
      <RightPanel t={t} instanceId={instance.id} instance={instance} activeSessionId={() => null}
        activeSession={() => null} latestTodoState={() => null} isPhoneLayout={() => false}
        rightDrawerWidth={() => 280} rightDrawerWidthInitialized={() => true}
        onCloseRightDrawer={() => {}} promptInputApi={() => null} setContentEl={() => {}} />
    </section>
    <div data-fixture="reference" style={{ width: "280px", height: "45px", overflow: "auto", "margin-top": "20px" }}>
      <div style={{ width: "1200px", height: "1px" }} />
    </div>
  </>
}

render(() => <ConfigProvider><I18nProvider><Fixture /></I18nProvider></ConfigProvider>, document.getElementById("root")!)
