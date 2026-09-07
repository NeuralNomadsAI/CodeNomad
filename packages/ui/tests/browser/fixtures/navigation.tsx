import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import VirtualFollowList, { type VirtualFollowListApi, type VirtualFollowScrollSnapshot } from "../../../src/components/virtual-follow-list"
import "../../../src/index.css"

const [visible, setVisible] = createSignal(true)
const [items, setItems] = createSignal(Array.from({ length: 200 }, (_, i) => `row-${i}`))
let api: VirtualFollowListApi | undefined
let snapshot: VirtualFollowScrollSnapshot | undefined
render(() => <Show when={visible()}><VirtualFollowList items={items} getKey={item => item}
  initialAutoScroll={() => false} initialScrollToBottom={() => false}
  registerApi={value => {
    api = value
    if (snapshot) api.restoreScrollSnapshot(snapshot)
  }}
  renderItem={item => <div style={{ height: "48px" }}>{item}</div>}
/></Show>, document.getElementById("root")!)
;(window as any).fixture = {
  bottom: () => api?.scrollToBottom({ immediate: true }),
  snapshot: () => api?.captureScrollSnapshot(),
  append: () => setItems(current => [...current, `row-${current.length}`]),
  switchAway: () => { snapshot = api?.captureScrollSnapshot(); setVisible(false) },
  return: () => setVisible(true),
}
