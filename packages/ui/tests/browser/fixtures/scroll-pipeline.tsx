import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import VirtualFollowList, { type VirtualExplicitBottomPinIntent, type VirtualFollowListApi } from "../../../src/components/virtual-follow-list"
import "../../../src/index.css"

const [items, setItems] = createSignal(Array.from({ length: 30 }, (_, i) => `row-${i}`))
const [pinIntent, setPinIntent] = createSignal<VirtualExplicitBottomPinIntent | null>(null)
let api: VirtualFollowListApi | undefined
let reachedBottomCount = 0
render(() => <VirtualFollowList items={items} getKey={item => item}
  registerApi={value => { api = value }}
  explicitBottomPinIntent={pinIntent}
  onUserReachedBottom={() => { reachedBottomCount += 1 }}
  renderItem={item => item === "nested"
    ? <div style={{ height: "300px" }}>
      <pre data-nested-output tabIndex={0} style={{ height: "200px", width: "600px", overflow: "auto", margin: "0" }}>
        <code data-nested-content style={{ display: "block", height: "1200px" }}>nested output</code>
      </pre>
    </div>
    : item === "report"
      ? <div style={{ height: "300px" }}>
        <div data-subagent-report tabIndex={0} style={{ height: "200px", width: "600px", overflow: "auto" }}>
          <div data-report-body style={{ height: "150px" }}>Subagent report body</div>
        </div>
      </div>
      : <div style={{ height: item.startsWith("tall") ? "2000px" : "100px" }}>{item}</div>}
/>, document.getElementById("root")!)
;(window as any).fixture = {
  bottom: () => api?.scrollToBottom({ immediate: true }),
  append: (tall?: boolean) => setItems(items => [...items, tall ? `tall-${items.length}` : `row-${items.length}`]),
  addNested: () => setItems(items => [...items, "nested"]),
  addReport: () => setItems(items => [...items, "report"]),
  // A delayed image extending the report: a raw DOM size change nothing in the
  // scroll pipeline observes (no scroll, no row resize, no render hook).
  growReport: (px: number) => { (document.querySelector("[data-report-body]") as HTMLElement)!.style.height = `${px}px` },
  pin: (token: number) => setPinIntent({ token }),
  stopFollow: () => api?.setAutoScroll(false),
  scrollTop: () => api?.getScrollElement()?.scrollTop,
  reachedBottom: () => reachedBottomCount,
}
