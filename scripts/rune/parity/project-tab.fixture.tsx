import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import InstanceTab from "../../../packages/ui/src/components/instance-tab"
import {SourceContext,prepareSourceContext,sourceContextSettled} from './source-context.fixture'
import contract from "../../../crates/rune-theme-codenomad/assets/theme.json"
import "../../../packages/ui/src/index.css"

const query = new URL(location.href).searchParams
const locale = query.get("locale") === "he" ? "he" : "en"
const theme = query.get("theme") === "dark" ? "dark" : "light"
const title = query.get("title") || "Alpha"
document.documentElement.lang = locale
document.documentElement.dir = locale === "he" ? "rtl" : "ltr"
document.documentElement.setAttribute("data-theme", theme)
const [active, setActive] = createSignal(query.get("active") !== "false")
const [present, setPresent] = createSignal(true)
const actions: string[] = []
Object.assign(window, { runeProjectTab: { ready: false, state: () => ({ active: active(), present: present(), actions: [...actions] }) } })

// Only the real InstanceTab is mounted. This frame supplies its CSS parent height and
// an unclipped neighborhood from the generated focus extent; no tab styles are replaced.
await prepareSourceContext()
render(() => <SourceContext>
  <div id="primitive-frame" class="tab-bar-instance" style={{ position: "absolute", left: "0", top: "0", display: "inline-flex", "background-image": "none", padding: `${contract.metrics[theme].tabFocus.extent}px` }}>
    <div class="tab-draggable" style={{ height: `${contract.metrics[theme].tabActive.height}px` }}>
      <Show when={present()}><InstanceTab
        instance={{ id: "fixture-alpha", folder: "/synthetic/alpha", projectName: title, status: "ready", client: null, port: 0, pid: 0, proxyPath: "/synthetic-only" }}
        active={active()}
        onSelect={() => { actions.push("select"); setActive(true) }}
        onClose={() => { actions.push("close"); setPresent(false) }}
        onRename={() => actions.push("rename")}
      /></Show>
    </div>
  </div>
</SourceContext>, document.getElementById("root")!)
await sourceContextSettled()
;(window as any).runeProjectTab.ready = true
