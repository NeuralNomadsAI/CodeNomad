import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import VirtualFollowList, { type VirtualExplicitBottomPinIntent, type VirtualFollowListApi, type VirtualFollowScrollSnapshot } from "../../../src/components/virtual-follow-list"
import "../../../src/index.css"

type RestoreScrollSnapshotOptions = Parameters<VirtualFollowListApi["restoreScrollSnapshot"]>[1]

const [visible, setVisible] = createSignal(true)
const [active, setActive] = createSignal(true)
const [items, setItems] = createSignal(Array.from({ length: 200 }, (_, i) => `row-${i}`))
const [tailHeight, setTailHeight] = createSignal(48)
const [headHeight, setHeadHeight] = createSignal(48)
const [rowHeights, setRowHeights] = createSignal<Record<string, number>>({})
const [pinIntent, setPinIntent] = createSignal<VirtualExplicitBottomPinIntent | null>(null)
let api: VirtualFollowListApi | undefined
let snapshot: VirtualFollowScrollSnapshot | undefined
let reachedTop = 0
let pinCancelled = 0
const rowHeight = (item: string) => rowHeights()[item] ?? (item === "streaming-tail" ? tailHeight() : item === "row-1" ? headHeight() : 48)
render(() => <Show when={visible()}><VirtualFollowList items={items} getKey={item => item}
  initialAutoScroll={() => false} initialScrollToBottom={() => false}
  isActive={active} scrollToBottomOnActivate={() => false}
  explicitBottomPinIntent={pinIntent} onExplicitBottomPinCancelled={() => { pinCancelled++ }}
  onUserReachedTop={() => { reachedTop++ }}
  registerApi={value => {
    api = value
    if (snapshot) api.restoreScrollSnapshot(snapshot)
  }}
  renderItem={item => <div style={{ height: `${rowHeight(item)}px` }}>{item}</div>}
/></Show>, document.getElementById("root")!)
;(window as any).fixture = {
  bottom: () => api?.scrollToBottom({ immediate: true }),
  follow: () => { api?.scrollToBottom({ immediate: true }); api?.setAutoScroll(true) },
  middle: () => api?.scrollToKey("row-100", { block: "start" }),
  nearTail: () => api?.scrollToKey("row-180", { block: "start" }),
  align: (key = "row-180", offset = 8) => {
    const row = api?.getScrollElement()?.querySelector<HTMLElement>(`[data-virtual-follow-key="${key}"]`)
    if (row) api?.alignElement(row, offset)
  },
  roll: () => {
    setItems(current => [...current.slice(1), "streaming-tail"])
    // Metadata/inbox reprojection may publish the same IDs before settlement.
    queueMicrotask(() => setItems(current => current.slice()))
  },
  growTail: setTailHeight,
  resizeHead: setHeadHeight,
  resizeRow: (key: string, height: number) => setRowHeights(current => ({ ...current, [key]: height })),
  reorder: () => {
    setItems(current => [current[1], current[0], ...current.slice(2), "prompt"])
    queueMicrotask(() => setItems(current => [current[1], current[0], ...current.slice(2)]))
  },
  snapshot: () => api?.captureScrollSnapshot(),
  reachedTop: () => reachedTop,
  append: () => setItems(current => [...current, `row-${current.length}`]),
  itemCount: () => items().length,
  switchAway: () => { snapshot = api?.captureScrollSnapshot(); setVisible(false) },
  return: () => setVisible(true),
  deactivateDuringRestore: (target: VirtualFollowScrollSnapshot) => { api?.restoreScrollSnapshot(target); setActive(false) },
  activate: () => setActive(true),
  autoScroll: () => api?.getAutoScroll(),
  settle: () => api!.settleAtBottom(),
  restore: (target: VirtualFollowScrollSnapshot, opts?: RestoreScrollSnapshotOptions) => api?.restoreScrollSnapshot(target, opts),
  // A fresh object each call, so re-emitting an existing token is observable.
  pin: (token: string, minItemCount?: number) => setPinIntent({ token, minItemCount }),
  unpin: () => setPinIntent(null),
  pinCancelled: () => pinCancelled,
  setAutoScroll: (enabled: boolean) => api?.setAutoScroll(enabled),
  alignElement: (selector: string, offset: number) => {
    const target = api?.getScrollElement()?.querySelector<HTMLElement>(selector)
    if (target) api?.alignElement(target, offset)
  },
}
