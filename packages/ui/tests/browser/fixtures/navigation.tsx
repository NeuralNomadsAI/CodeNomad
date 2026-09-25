import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import VirtualFollowList, { type VirtualFollowListApi, type VirtualFollowScrollSnapshot } from "../../../src/components/virtual-follow-list"
import "../../../src/index.css"

const [visible, setVisible] = createSignal(true)
const [items, setItems] = createSignal(Array.from({ length: 200 }, (_, i) => `row-${i}`))
const [tailHeight, setTailHeight] = createSignal(48)
const [headHeight, setHeadHeight] = createSignal(48)
let api: VirtualFollowListApi | undefined
let snapshot: VirtualFollowScrollSnapshot | undefined
let reachedTop = 0
render(() => <Show when={visible()}><VirtualFollowList items={items} getKey={item => item}
  initialAutoScroll={() => false} initialScrollToBottom={() => false}
  onUserReachedTop={() => { reachedTop++ }}
  registerApi={value => {
    api = value
    if (snapshot) api.restoreScrollSnapshot(snapshot)
  }}
  renderItem={item => <div style={{ height: item === "streaming-tail" ? `${tailHeight()}px` : item === "row-1" ? `${headHeight()}px` : "48px" }}>{item}</div>}
/></Show>, document.getElementById("root")!)
;(window as any).fixture = {
  bottom: () => api?.scrollToBottom({ immediate: true }),
  follow: () => { api?.scrollToBottom({ immediate: true }); api?.setAutoScroll(true) },
  middle: () => api?.scrollToKey("row-100", { block: "start" }),
  nearTail: () => api?.scrollToKey("row-180", { block: "start" }),
  roll: () => {
    setItems(current => [...current.slice(1), "streaming-tail"])
    // Metadata/inbox reprojection may publish the same IDs before settlement.
    queueMicrotask(() => setItems(current => current.slice()))
  },
  growTail: setTailHeight,
  resizeHead: setHeadHeight,
  reorder: () => {
    setItems(current => [current[1], current[0], ...current.slice(2), "prompt"])
    queueMicrotask(() => setItems(current => [current[1], current[0], ...current.slice(2)]))
  },
  snapshot: () => api?.captureScrollSnapshot(),
  reachedTop: () => reachedTop,
  append: () => setItems(current => [...current, `row-${current.length}`]),
  switchAway: () => { snapshot = api?.captureScrollSnapshot(); setVisible(false) },
  return: () => setVisible(true),
}
