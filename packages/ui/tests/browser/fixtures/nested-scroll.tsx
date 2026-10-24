import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { createFollowScroll } from "../../../src/lib/follow-scroll"
import VirtualFollowList, { type VirtualFollowListApi } from "../../../src/components/virtual-follow-list"
import "../../../src/index.css"

const [savedTop, setSavedTop] = createSignal(0)
const [outputHeight, setOutputHeight] = createSignal(1600)
const nested = createFollowScroll({ getScrollTopSnapshot: savedTop, setScrollTopSnapshot: setSavedTop, sentinelClassName: "fixture-sentinel" })
let api: VirtualFollowListApi | undefined
const [items, setItems] = createSignal(Array.from({ length: 30 }, (_, i) => `row-${i}`))
render(() => <VirtualFollowList items={items} getKey={item => item}
  registerApi={value => { api = value }}
  renderItem={(item, index) => item === "row-29"
    ? <div data-item-index={index()} style={{ height: "250px" }}>
        <div data-nested-output tabIndex={0} ref={nested.registerContainer} onScroll={nested.handleScroll}
          style={{ height: "200px", width: "600px", overflow: "auto" }}>
          <pre style={{ margin: "0", height: `${outputHeight()}px` }}><code>Artificial tool output</code></pre>
          <button type="button" data-output-action>Copy</button>
          {nested.renderSentinel()}
        </div>
      </div>
    : <div style={{ height: "100px" }}>{item}</div>}
/>, document.getElementById("root")!)
;(window as any).fixture = {
  bottom: () => api?.scrollToBottom({ immediate: true }),
  renderOutput: nested.restoreAfterRender,
  // A streamed tool-output chunk: the output grows, then reports its render.
  growOutput: (px: number) => { setOutputHeight(height => height + px); nested.restoreAfterRender() },
  append: () => setItems(items => [...items, `row-${items.length}`]),
  roll: () => setItems(items => [...items.slice(1), "streaming-tail"]),
  snapshot: () => ({ outerFollow: api?.getAutoScroll(), innerFollow: nested.autoScroll(), outerTop: api?.getScrollElement()?.scrollTop, savedTop: savedTop() }),
}
