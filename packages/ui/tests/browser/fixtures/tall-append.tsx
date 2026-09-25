import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import VirtualFollowList, { type VirtualFollowListApi } from "../../../src/components/virtual-follow-list"
import "../../../src/index.css"

const [items, setItems] = createSignal(["prompt", "reply"])
const [replyHeight, setReplyHeight] = createSignal(3200)
let api: VirtualFollowListApi | undefined
render(() => <VirtualFollowList items={items} getKey={item => item}
  registerApi={value => { api = value }}
  renderItem={item => <div data-row={item} style={{ height: item === "reply" ? `${replyHeight()}px` : item === "metadata" || item.startsWith("hidden-") ? "0px" : "120px" }}>{item}</div>}
/>, document.getElementById("root")!)
;(window as any).fixture = {
  bottom: () => api?.scrollToBottom({ immediate: true }),
  settleBottom: () => { void api?.settleAtBottom() },
  resizeReply: setReplyHeight,
  append: () => setItems(items => [...items, "new-prompt"]),
  metadata: () => setItems(items => [...items, "metadata"]),
  replacePage: () => {
    api?.setAutoScroll(false)
    setItems(Array.from({length:200},(_,i)=>i<175?`hidden-${i}`:`page-row-${i}`))
    queueMicrotask(()=>void api?.settleAtBottom())
  },
}
