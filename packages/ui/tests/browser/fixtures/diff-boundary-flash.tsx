import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import MessageSection from "../../../src/components/message-section"
import { applyUiSettings } from "./ui-settings"
import { transcriptPresetPatch } from "../../../src/components/transcript-visibility"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages } from "../../../src/stores/session-api"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import "../../../src/index.css"

// Round-boundary flash harness: a settled edit tool renders its diff through
// the real diff cache, then an authoritative page re-projection replaces the
// tool part the way the SDK's end-of-round refresh does. Per-frame samples
// record whether the formatted diff is ever replaced by a plain-text fallback.

const instanceId = "diff-boundary-flash"
const model = { providerID: "fixture", id: "fixture" }

export const diffA = `--- a/src/app.ts
+++ b/src/app.ts
@@ -1,4 +1,4 @@
 import { base } from "./base"

-export const value = compute(base)
+export const value = compute(base, { retries: 2 })

 export const next = value + 1
`
/** The daemon's page version: the same change with its full trailing context. */
export const diffAPage = diffA + ` export const done = true
`

const page = (diff: string) => [
  { id: "msg_user", type: "user", time: { created: 1 }, text: "adjust the value" },
  { id: "m1", type: "assistant", agent: "build", model, time: { created: 2, completed: 3 }, content: [
    { type: "text", text: "Editing src/app.ts." },
    { id: "edit_1", type: "tool", name: "edit", time: { created: 2, ran: 2, completed: 3 },
      state: { status: "completed", input: { filePath: "src/app.ts" },
        metadata: { diff }, content: [{ type: "text", text: "ok" }] } },
  ] },
]

const history: Record<string, any[]> = { s: page(diffA), s2: page(diffAPage) }
// A long session drives virtualization: rows far from the viewport are recycled.
const longMessages = Array.from({ length: 60 }, (_, index) => index % 2 === 0
  ? { id: `long-user-${index}`, type: "user", time: { created: index * 3 }, text: `step ${index}` }
  : { id: `long-m${index}`, type: "assistant", agent: "build", model, time: { created: index * 3, completed: index * 3 + 2 }, content: [
      { type: "text", text: `Working on step ${index}.` },
      { id: `long-bash-${index}`, type: "tool", name: "bash", time: { created: index * 3, ran: index * 3, completed: index * 3 + 1 },
        state: { status: "completed", input: { command: `make ${index}` }, metadata: {},
          content: [{ type: "text", text: `output ${index}\n` }] } },
      { id: `long-edit-${index}`, type: "tool", name: "edit", time: { created: index * 3 + 1, ran: index * 3 + 1, completed: index * 3 + 2 },
        state: { status: "completed", input: { filePath: `src/file-${index}.ts` },
          metadata: { diff: diffA }, content: [{ type: "text", text: "ok" }] } },
    ] })
history.long = longMessages

/** A round-boundary page whose assistant message carries grouped settled tools. */
const groupedPage = (diff: string, withReasoning = false) => [
  { id: "msg_user", type: "user", time: { created: 1 }, text: "adjust the value" },
  { id: "m1", type: "assistant", agent: "build", model, time: { created: 2, ...(withReasoning ? {} : { completed: 8 }) }, content: [
    { type: "text", text: "Editing src/app.ts." },
    { id: "bash_1", type: "tool", name: "bash", time: { created: 2, ran: 2, completed: 3 },
      state: { status: "completed", input: { command: "make check" }, metadata: {},
        content: [{ type: "text", text: "all good\n" }] } },
    { id: "bash_2", type: "tool", name: "bash", time: { created: 3, ran: 3, completed: 4 },
      state: { status: "completed", input: { command: "make test" }, metadata: {},
        content: [{ type: "text", text: "tests pass\n" }] } },
    { id: "edit_1", type: "tool", name: "edit", time: { created: 4, ran: 4, completed: 5 },
      state: { status: "completed", input: { filePath: "src/app.ts" },
        metadata: { diff }, content: [{ type: "text", text: "ok" }] } },
    { id: "task_1", type: "tool", name: "task", time: { created: 5, ran: 5, completed: 6 },
      state: { status: "completed", input: { description: "side work" },
        metadata: { sessionID: "ses_child", status: "running" },
        content: [{ type: "text", text: "launched" }] } },
    ...(withReasoning ? [{ id: "reason_1", type: "reasoning", text: "Thinking about the next step…" }] : []),
  ] },
  { id: "msg_rep", type: "synthetic", time: { created: 7 },
    text: `<subagent sessionID="ses_child" state="completed" description="Work">\nChild result\n</subagent>` },
]

const client: any = { session: {
  active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
  get: async ({ sessionID }: any) => ({ id: sessionID, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }),
}, message: { list: async ({ sessionID }: any) => ({ data: [...history[sessionID] ?? []].reverse() }) } }
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([["s", {
  id: "s", instanceId, parentId: null, title: "Fixture", location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
} as any], ["s2", {
  id: "s2", instanceId, parentId: null, title: "Fixture 2", location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
} as any], ["long", {
  id: "long", instanceId, parentId: null, title: "Long", location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
} as any]])))
setActiveSession(instanceId, "s")
await applyUiSettings({ locale: "en", showMessageTimeline: false, toolInputsVisibility: "hidden",
  toolCallExpansionDefaults: { preset: "custom", thinking: "expanded", tools: { edit: "expanded", bash: "expanded", task: "expanded" } } })
await loadMessages(instanceId, "s", { force: true })

let frames = 0
let fallbackFrames = 0
let layoutJumpFrames = 0
let missingBodyFrames = 0
let missingReportFrames = 0
let collapsedBodyFrames = 0
let baselineBodies = -1
let highWaterBodies = 0
let lastLayout: string | undefined
const layoutSignature = () => {
  const viewer = document.querySelector<HTMLElement>(".tool-call-diff-viewer")
  if (!viewer) return "absent"
  const gutter = viewer.querySelector<HTMLElement>(".diff-line-num, [data-line-old-num], .diff-line")
  return `${Math.round(viewer.scrollWidth)}|${Math.round(gutter?.getBoundingClientRect().width ?? -1)}|${viewer.querySelectorAll(".diff-line").length}`
}
const sample = () => {
  frames += 1
  if (document.querySelector(".tool-call-diff-fallback")) fallbackFrames += 1
  const bodies = document.querySelectorAll(".tool-call-details").length
  // The bug signature is cards whose headers rendered while their bodies
  // blanked; a transcript's own first mounting frame (no cards at all yet)
  // is not a blank and must not count.
  const cards = document.querySelectorAll(".tool-call").length
  if (cards > 0 && bodies === 0) missingBodyFrames += 1
  // Partial drops count too: any frame below the high-water mark of mounted
  // bodies (after warm-up) means a mounted body blanked.
  if (bodies > highWaterBodies) highWaterBodies = bodies
  if (highWaterBodies > 0 && frames > 2 && bodies < highWaterBodies) collapsedBodyFrames += 1
  const transcript = document.querySelector(".message-stream")?.textContent ?? ""
  if (cards > 0 && !transcript.includes("Child result")) missingReportFrames += 1
  const layout = layoutSignature()
  if (lastLayout !== undefined && layout !== lastLayout) layoutJumpFrames += 1
  lastLayout = layout
  requestAnimationFrame(sample)
}
requestAnimationFrame(sample)

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
let sequence = 0
function emitToolStep(type: string, data: Record<string, unknown>) {
  const seq = ++sequence
  ;(sseManager as any).handleEvent(instanceId, {
    id: `evt-shell-${seq}`, type, created: 20 + seq, durable: { aggregateID: "s", seq, version: 1 },
    location: { directory: "/fixture" }, data: { sessionID: "s", ...data },
  })
}
function appendShell(id: string) {
  const tool = { assistantMessageID: "m-shell", id }
  const input = { command: `make ${id}`, description: `make ${id}` }
  emitToolStep("session.tool.input.started", { ...tool, name: "bash" })
  emitToolStep("session.tool.called", { ...tool, input })
  emitToolStep("session.tool.success", { ...tool, content: [{ type: "text", text: `Output from ${id}` }], metadata: {}, executed: true })
}

const [activeId, setActiveId] = createSignal("s")

render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ display: "flex", height: "700px", width: "1000px" }}>
    <MessageSection instanceId={instanceId} sessionId={activeId()} isActive={true} />
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

const resetSamples = (baseline?: number) => {
  frames = 0
  fallbackFrames = 0
  layoutJumpFrames = 0
  missingBodyFrames = 0
  missingReportFrames = 0
  collapsedBodyFrames = 0
  lastLayout = undefined
  baselineBodies = baseline ?? document.querySelectorAll(".tool-call-details").length
  highWaterBodies = baselineBodies > 0 ? baselineBodies : 0
}
const samplesOf = () => ({ frames, missingBodyFrames, collapsedBodyFrames, missingReportFrames })

;(window as any).fixture = {
  async startShellGroup() {
    await applyUiSettings(transcriptPresetPatch("everything"))
    emitToolStep("session.execution.started", {})
    emitToolStep("session.step.started", { assistantMessageID: "m-shell", agent: "build", model, started: 20 })
    appendShell("shell-1")
    appendShell("shell-2")
  },
  appendShell,
  /** Waits until the formatted diff is rendered and its cache entry written. */
  async ready() {
    for (let guard = 0; guard < 200 && !document.querySelector(".tool-call-diff-viewer"); guard++) await nextFrame()
    for (let index = 0; index < 4; index++) await nextFrame()
    frames = 0
    fallbackFrames = 0
    layoutJumpFrames = 0
    missingBodyFrames = 0
    missingReportFrames = 0
    lastLayout = undefined
  },
  /** Swaps the session to the grouped-tools page and waits for it to settle. */
  async useGrouped(diff: string) {
    history.s = groupedPage(diff)
    await loadMessages(instanceId, "s", { force: true })
    setActiveSession(instanceId, "s")
    setActiveId("s")
    for (let guard = 0; guard < 200 && !document.querySelector(".tool-call-diff-viewer"); guard++) await nextFrame()
    for (let guard = 0; guard < 100 && !(document.querySelector(".message-stream")?.textContent ?? "").includes("Child result"); guard++) await nextFrame()
    for (let index = 0; index < 6; index++) await nextFrame()
    resetSamples()
  },
  /** Re-projects the authoritative page with the given edit-part diff text. */
  async reproject(diff: string) {
    history.s = page(diff)
    await loadMessages(instanceId, "s", { force: true })
    for (let index = 0; index < 8; index++) await nextFrame()
  },
  /** A new reasoning part streams into the grouped message; the tools are untouched. */
  async streamReasoning(diff: string) {
    history.s = groupedPage(diff, true)
    await loadMessages(instanceId, "s", { force: true })
    for (let index = 0; index < 12; index++) await nextFrame()
  },
  /**
   * Models the real send path, sampling each phase separately:
   * A optimistic row mounts + bottom pin; B the send-triggered reload lags;
   * C the native page confirms the row.
   */
  async sendMessagePhased() {
    const store = messageStoreBus.getOrCreate(instanceId)
    const phase = async (frames: number) => {
      resetSamples()
      for (let index = 0; index < frames; index++) await nextFrame()
      return { ...samplesOf(), bodies: document.querySelectorAll(".tool-call-details").length }
    }
    store.markSendPending("msg_send")
    store.upsertMessage({ id: "msg_send", sessionId: "s", role: "user", status: "sending",
      isEphemeral: true, parts: [{ id: "msg_send-text", type: "text", text: "next question" }] })
    const scroller = document.querySelector(".message-stream")
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    const optimistic = await phase(4)
    await loadMessages(instanceId, "s", { force: true })
    const lagged = await phase(4)
    history.s = [...groupedPage(diffA), { id: "msg_send", type: "user", time: { created: 9 }, text: "next question" }]
    await loadMessages(instanceId, "s", { force: true })
    const confirmed = await phase(12)
    return { optimistic, lagged, confirmed }
  },
  /** Re-projects the grouped-tools page: settled edit+bash tools and the child report. */
  async reprojectGrouped(diff: string) {
    history.s = groupedPage(diff)
    await loadMessages(instanceId, "s", { force: true })
    for (let index = 0; index < 8; index++) await nextFrame()
  },
  samples: () => ({ frames, fallbackFrames, layoutJumpFrames, missingBodyFrames, missingReportFrames, collapsedBodyFrames, baselineBodies }),
  bodyCount: () => document.querySelectorAll(".tool-call-details").length,
  /** Switches the transcript to another session and samples the mount-in frames. */
  async switchTo(id: string) {
    const target = id
    await loadMessages(instanceId, target, { force: true })
    setActiveSession(instanceId, target)
    setActiveId(target)
    resetSamples(-1)
    for (let index = 0; index < 30; index++) await nextFrame()
  },
  /** Loads the long session, parks at its bottom, then returns to the top. */
  async scrollRecycle() {
    await loadMessages(instanceId, "long", { force: true })
    setActiveSession(instanceId, "long")
    setActiveId("long")
    const scroller = document.querySelector(".message-stream")
    if (!scroller) return "no-scroller"
    for (let index = 0; index < 10; index++) await nextFrame()
    // Park at the bottom long enough for virtua to recycle the top rows.
    scroller.scrollTop = scroller.scrollHeight
    for (let index = 0; index < 15; index++) await nextFrame()
    const topBodies = document.querySelectorAll(".tool-call-details").length
    // Return to the top: recycled rows remount; their bodies may defer again.
    resetSamples(-1)
    scroller.scrollTop = 0
    for (let index = 0; index < 30; index++) await nextFrame()
    return { bodiesAtBottom: topBodies, samples: { frames, missingBodyFrames }, finalBodies: document.querySelectorAll(".tool-call-details").length }
  },
  diffRendered: () => Boolean(document.querySelector(".tool-call-diff-viewer")),
  /** The diff text the viewer currently renders, proving a projection took effect. */
  renderedText: () => (document.querySelector(".tool-call-diff-viewer")?.textContent ?? "").replace(/\s+/g, " ").trim(),
  diffA: () => diffA,
  diffAPage: () => diffAPage,
}
