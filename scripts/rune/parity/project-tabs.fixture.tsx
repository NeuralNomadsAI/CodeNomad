import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import InstanceTabs from "../../../packages/ui/src/components/instance-tabs"
import { ConfigProvider } from "../../../packages/ui/src/stores/preferences"
import { applyUiSettings } from "../../../packages/ui/tests/browser/fixtures/ui-settings"
import { I18nProvider, preloadLocaleMessages } from "../../../packages/ui/src/lib/i18n"
import type { AppTabRecord } from "../../../packages/ui/src/stores/app-tabs"
import "../../../packages/ui/src/index.css"

const query = new URL(location.href).searchParams
const locale = query.get("locale") === "he" ? "he" : "en"
document.documentElement.lang = locale
document.documentElement.dir = locale === "he" ? "rtl" : "ltr"
const overflow = query.get("case") === "overflow"
const names = overflow ? Array.from({ length: 8 }, (_, i) => `Project ${i + 1} · long synthetic folder name`) : ["Alpha", "Beta"]
const [tabs, setTabs] = createSignal<AppTabRecord[]>(names.map((name, i) => ({
  kind: "instance", id: `tab-${i}`, instance: { id: `fixture-${i}`, folder: `/synthetic/${name}`,
    projectName: name, status: "ready", client: null, port: 0, pid: 0, proxyPath: "/synthetic-only" },
})))
const [active, setActive] = createSignal<string | null>("tab-0")
const actions: { type: string; id?: string }[] = []
Object.assign(window, { runeProjectTabs: {
  ready: false, state: () => ({ active: active(), ids: tabs().map(tab => tab.id), actions: [...actions] }),
} })
render(() => <ConfigProvider><I18nProvider>
  <InstanceTabs tabs={tabs()} activeTabId={active()}
    onSelect={id => { actions.push({ type: "select", id }); setActive(id) }}
    onClose={id => { actions.push({ type: "close", id }); setTabs(rows => rows.filter(tab => tab.id !== id)) }}
    onNew={() => { const id = `blank-${actions.length}`; actions.push({ type: "new", id }); setTabs(rows => [...rows, { kind: "blank", id }]); setActive(id) }}
    onMoveTab={(id, target, placement) => { actions.push({ type: "move", id }); setTabs(rows => {
      const item = rows.find(row => row.id === id)!, next = rows.filter(row => row.id !== id)
      next.splice(next.findIndex(row => row.id === target) + Number(placement === "after"), 0, item); return next
    }) }} />
</I18nProvider></ConfigProvider>, document.getElementById("root")!)
await applyUiSettings({ locale })
await preloadLocaleMessages(locale)
;(window as any).runeProjectTabs.ready = true
