import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import MessageTimeline, { type TimelineSegment } from "../../../src/components/message-timeline"
import { I18nProvider } from "../../../src/lib/i18n"
import { ConfigProvider } from "../../../src/stores/preferences"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyUiSettings } from "./ui-settings"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { serverApi } from "../../../src/lib/api-client"
import "../../../src/index.css"

const count = Math.min(50_000, Math.max(10, Number(new URLSearchParams(location.search).get("count") ?? 10_000)))
const segments: TimelineSegment[] = Array.from({ length: count }, (_, index) => ({
  id: `marker-${index}`, messageId: `message-${Math.floor(index / 3)}`, type: index % 3 === 0 ? "user" : index % 3 === 1 ? "tool" : "assistant",
  label: String(index), tooltip: `Marker ${index}`, toolName: index % 3 === 1 ? "read" : undefined,
  toolPartIds: index % 3 === 1 ? [`tool-${index}`] : undefined, totalChars: 0,
}))
// Seed one resident preview; all other excerpts are deterministic HTTP-boundary
// answers, never transcript loads. This also exercises Markdown in the tooltip.
const store = messageStoreBus.getOrCreate("render-timeline")
store.upsertMessage({ id: "message-0", sessionId: "timeline", role: "user", status: "complete", createdAt: 1,
  parts: [{ id: "preview-text", type: "text", text: "**Resident preview**\n\n" + "bounded excerpt ".repeat(1000) }] })
const requests: number[] = []
serverApi.fetchOutlinePreviews = async (_instance, _session, ids) => {
  requests.push(ids.length)
  return { status: "previews", entries: ids.map(id => ({ id, text: "**Local excerpt**", tools: "Read tool excerpt" })) } as any
}
const [active, setActive] = createSignal("marker-0")
let selected = "", activeCounter = 0
await applyUiSettings({ locale: "en" })
const start = performance.now()
render(() => <ConfigProvider><I18nProvider><ThemeProvider><div class="message-timeline-sidebar" style={{ height: "600px", width: "60px" }}>
  <MessageTimeline instanceId="render-timeline" sessionId="timeline" segments={segments}
    activeSegmentId={active()} onSegmentClick={segment => { selected = segment.id }} />
</div></ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
const mountMs = performance.now() - start
;(window as any).fixture = {
  measure: (updates: number) => {
    const start = performance.now()
    for (let index = 0; index < updates; index++) setActive(`marker-${++activeCounter % 15}`)
    return performance.now() - start
  },
  snapshot: () => ({ count, selected, active: active(), requests, mountMs }),
}
