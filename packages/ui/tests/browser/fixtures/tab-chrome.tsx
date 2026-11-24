import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import InstanceTabs from "../../../src/components/instance-tabs"
import RightPanel from "../../../src/components/instance/shell/right-panel/RightPanel"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider, useI18n } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyColorScheme, normalizeColorScheme } from "../../../src/lib/theme-scheme"
import type { AppTabRecord } from "../../../src/stores/app-tabs"
import AlertDialog from "../../../src/components/alert-dialog"
import { showChoiceDialog, showConfirmDialog } from "../../../src/stores/alerts"
import { setSessions } from "../../../src/stores/session-state"
import { createClientSession } from "../../../src/types/session"
import type { Instance } from "../../../src/types/instance"
import "../../../src/index.css"

const instance: Instance = { id: "tab-fixture", folder: "D:/fixture", port: 0, pid: 0, proxyPath: "/fixture", status: "ready", client: null }
const tabs = Array.from({ length: 9 }, (_, i): AppTabRecord => ({
  id: `instance:${i}`, kind: "instance", instance: { ...instance, id: `fixture-${i}`, folder: `D:/Project-${i}`, projectName: `Project ${i} — workspace` },
}))
tabs[3] = { id: "instance:temporary", kind: "instance", instance: { ...instance, id: "fixture-temporary", folder: "D:/temporary-workspaces/1", projectName: "Temporary · 12:00", temporary: true } }
tabs[2] = { id: "sidecar:preview", kind: "sidecar", sidecarTab: {
  token: "preview", sidecarId: "preview", name: "Preview", prefixMode: "strip",
  proxyBasePath: "/fixture/preview", shellUrl: "/fixture/preview",
} }

const short = (name: string): AppTabRecord => ({ id: `instance:${name}`, kind: "instance", instance: { ...instance, id: `fixture-${name}`, folder: `D:/${name}`, projectName: name } })

function Fixture() {
  const { t } = useI18n()
  const [count, setCount] = createSignal(9)
  const [active, setActive] = createSignal(tabs[1].id)
  const [order, setOrder] = createSignal(tabs)
  ;(window as any).tabFixture = {
    count: setCount,
    // One wide tab followed by two narrow ones.
    uneven: () => { setOrder([tabs[0], short("docs"), short("api")]); setCount(3) },
    reset: () => { setOrder(tabs); setCount(9) },
    statusPair(status: "working" | "idle") {
      const local = short("Local status")
      const remote = short("Remote status")
      if (local.kind !== "instance" || remote.kind !== "instance") throw new Error("Expected two project tabs")
      remote.instance.backendId = "fixture-remote"
      if (status === "working") {
        setOrder([local, remote]); setCount(2); setActive(local.id)
      }
      setSessions(previous => {
        const next = new Map(previous)
        for (const { instance } of [local, remote]) {
          const row = createClientSession({ id: "status", title: "status", projectID: "fixture", version: "1",
            location: { directory: instance.folder }, time: { created: 1, updated: 1 },
            cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, instance.id)
          next.set(instance.id, new Map([[row.id, { ...row, status, idleSince: status === "idle" ? Date.now() : null }]]))
        }
        return next
      })
    },
    palette: (id: string) => applyColorScheme(normalizeColorScheme(id)),
    choice: () => showChoiceDialog("Keep or discard?", [
      { value: "discard", label: "Discard", tone: "danger" },
      { value: "keep", label: "Keep", tone: "primary" },
    ], { cancelLabel: "Cancel" }).then((value) => { (window as any).tabFixture.chosen = value }),
    confirm: () => showConfirmDialog("Delete it?", { confirmLabel: "Delete", cancelLabel: "Cancel" })
      .then((value) => { (window as any).tabFixture.confirmed = value }),
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
      <RightPanel isActive={() => true} t={t} instanceId={instance.id} instance={instance} activeSessionId={() => null}
        activeSession={() => null} isPhoneLayout={() => false}
        rightDrawerWidth={() => 280} rightDrawerWidthInitialized={() => true}
        onCloseRightDrawer={() => {}} promptInputApi={() => null} setContentEl={() => {}} />
    </section>
    <div data-fixture="reference" style={{ width: "280px", height: "45px", overflow: "auto", "margin-top": "20px" }}>
      <div style={{ width: "1200px", height: "1px" }} />
    </div>
    <AlertDialog />
  </>
}

render(() => <ConfigProvider><I18nProvider><ThemeProvider><Fixture /></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
