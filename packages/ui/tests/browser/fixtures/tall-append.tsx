import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import VirtualFollowList, { type VirtualFollowListApi } from "../../../src/components/virtual-follow-list"
import "../../../src/index.css"

const [items, setItems] = createSignal(["prompt", "reply"])
let api: VirtualFollowListApi | undefined
render(() => <VirtualFollowList items={items} getKey={item => item}
  registerApi={value => { api = value }}
  renderItem={item => <div data-row={item} style={{ height: item === "reply" ? "3200px" : item === "metadata" ? "0px" : "120px" }}>{item}</div>}
/>, document.getElementById("root")!)
;(window as any).fixture = {
  bottom: () => api?.scrollToBottom({ immediate: true }),
  append: () => setItems(items => [...items, "new-prompt"]),
  metadata: () => setItems(items => [...items, "metadata"]),
}
