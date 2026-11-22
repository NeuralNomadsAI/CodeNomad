import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import VirtualFollowList, { type VirtualExplicitBottomPinIntent, type VirtualFollowListApi } from "../../../src/components/virtual-follow-list"
import "../../../src/index.css"

const [items, setItems] = createSignal(Array.from({ length: 30 }, (_, i) => `row-${i}`))
const [pinIntent, setPinIntent] = createSignal<VirtualExplicitBottomPinIntent | null>(null)
let api: VirtualFollowListApi | undefined
render(() => <VirtualFollowList items={items} getKey={item => item}
  registerApi={value => { api = value }}
  explicitBottomPinIntent={pinIntent}
  renderItem={item => item === "nested"
    ? <div style={{ height: "300px" }}>
      <pre data-nested-output tabIndex={0} style={{ height: "200px", width: "600px", overflow: "auto", margin: "0" }}>
        <code data-nested-content style={{ display: "block", height: "1200px" }}>nested output</code>
      </pre>
    </div>
    : <div style={{ height: item.startsWith("tall") ? "2000px" : "100px" }}>{item}</div>}
/>, document.getElementById("root")!)
;(window as any).fixture = {
  bottom: () => api?.scrollToBottom({ immediate: true }),
  append: (tall?: boolean) => setItems(items => [...items, tall ? `tall-${items.length}` : `row-${items.length}`]),
  addNested: () => setItems(items => [...items, "nested"]),
  pin: (token: number) => setPinIntent({ token }),
  stopFollow: () => api?.setAutoScroll(false),
  scrollTop: () => api?.getScrollElement()?.scrollTop,
}
