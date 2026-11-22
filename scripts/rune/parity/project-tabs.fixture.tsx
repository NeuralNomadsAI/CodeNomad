import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import InstanceTabs from "../../../packages/ui/src/components/instance-tabs"
import {SourceContext,prepareSourceContext,sourceContextSettled} from './source-context.fixture'
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
const [active, setActive] = createSignal<string | null>(query.get("case")==="inactive"?"tab-1":"tab-0")
const actions: { type: string; id?: string }[] = []
Object.assign(window, { runeProjectTabs: {
  ready: false, state: () => ({ active: active(), ids: tabs().map(tab => tab.id), actions: [...actions] }),
} })
await prepareSourceContext()
render(() => <SourceContext>
  <InstanceTabs tabs={tabs()} activeTabId={active()}
    onSelect={id => { actions.push({ type: "select", id }); setActive(id) }}
    onClose={id => { actions.push({ type: "close", id }); setTabs(rows => rows.filter(tab => tab.id !== id)) }}
    onNew={() => { const id = `blank-${actions.length}`; actions.push({ type: "new", id }); setTabs(rows => [...rows, { kind: "blank", id }]); setActive(id) }}
    onMoveTab={(id, target, placement) => { actions.push({ type: "move", id }); setTabs(rows => {
      const item = rows.find(row => row.id === id)!, next = rows.filter(row => row.id !== id)
      next.splice(next.findIndex(row => row.id === target) + Number(placement === "after"), 0, item); return next
    }) }} />
</SourceContext>, document.getElementById("root")!)
await sourceContextSettled()
;(window as any).runeProjectTabs.ready = true
