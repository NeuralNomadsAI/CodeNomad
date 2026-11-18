import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import MessageSection from "../../../src/components/message-section"
import { applyUiSettings } from "./ui-settings"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance } from "../../../src/stores/instances"
import { setSessions, setActiveSession } from "../../../src/stores/session-state"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages } from "../../../src/stores/session-api"
import { hasPendingCodeHighlight, initMarkdown, renderMarkdown } from "../../../src/lib/markdown"
import "../../../src/index.css"

// Mount-cost harness: a small warm-up session mounts first; each `switchTo`
// target holds a deterministic 120-message conversation with the part shapes
// that dominate a long coding session (assistant prose with fenced code,
// bash tool output, read tool output). Longtasks are observed in the page so
// a CDP-throttled switch can be measured end to end.

const params = new URLSearchParams(location.search)
const messageCount = Math.min(400, Math.max(4, Number(params.get("count") ?? 120)))
const mountSessionCount = Math.min(3, Math.max(1, Number(params.get("sessions") ?? 3)))
const toolBodies = params.get("bodies") !== "collapsed"
const homeId = "home"
const homeBId = "home-b"
const mountIds = Array.from({ length: mountSessionCount }, (_, index) => `mount-${index}`)
const instanceId = "render-cost-mount"
const model = { providerID: "fixture", id: "fixture" }

// Count the deferred-highlight scheduler's idle callbacks (the render-cost
// structural assertion): the page otherwise has no requestIdleCallback use.
let idleCallbackCount = 0
const nativeRequestIdleCallback = window.requestIdleCallback?.bind(window)
if (nativeRequestIdleCallback) {
  window.requestIdleCallback = ((callback: IdleRequestCallback, options?: IdleRequestOptions) =>
    nativeRequestIdleCallback(deadline => {
      idleCallbackCount += 1
      return callback(deadline)
    }, options)) as typeof requestIdleCallback
}

const bashOutput = (session: string, index: number) =>
  Array.from({ length: 120 }, (_, line) => `[${session}] bash ${String(line).padStart(3, "0")} · step ${index} · deterministic terminal output ${String(line * 7).padStart(5, "0")}\n`).join("")
const readOutput = (session: string, index: number) =>
  Array.from({ length: 80 }, (_, line) => `export const token${line}_${index} = compute${line}("${session}") // deterministic module source line ${line}\n`).join("")
const assistantText = (session: string, index: number) =>
  `Step ${index} of ${session} produced the changes below.

\`\`\`ts
import { step${index} } from "./step-${index}"

export const result${index} = step${index}({ retries: ${index % 5}, label: "${session}" })
\`\`\`

The command that follows ran the deterministic pipeline for ${session} step ${index}.`
const userText = (session: string, index: number) =>
  `Continue with step ${index} on ${session}. Keep the deterministic instructions for this passage.`

const toolPart = (id: string, name: string, index: number, text: string) => ({
  id, type: "tool", name, time: { created: index * 3 + 1, completed: index * 3 + 2 },
  state: { status: "completed", input: name === "bash"
    ? { command: `make step-${index}`, description: `Run step ${index}` }
    : { filePath: `src/module-${index}.ts` }, metadata: {}, content: [{ type: "text", text }] },
})

const sessionMessages = (session: string, count: number) => Array.from({ length: count }, (_, index) =>
  index % 2 === 0
    ? { id: `${session}-user-${index}`, type: "user", time: { created: index * 3 }, text: userText(session, index) }
    : { id: `${session}-assistant-${index}`, type: "assistant", agent: "build", model, time: { created: index * 3, completed: index * 3 + 2 },
        content: [
          { type: "text", text: assistantText(session, index) },
          toolPart(`${session}-bash-${index}`, "bash", index, bashOutput(session, index)),
          toolPart(`${session}-read-${index}`, "read", index, readOutput(session, index)),
        ] })

const history: Record<string, any[]> = { [homeId]: sessionMessages(homeId, 3), [homeBId]: sessionMessages(homeBId, 3) }
for (const id of mountIds) history[id] = sessionMessages(id, messageCount)

// Every fence language a mount session renders (assistant ts fence, bash tool
// output, read tool output): `languagesReady` holds until all are loaded.
const languageProbe = `${assistantText(homeId, 0)}\n\`\`\`bash\nprobe\n\`\`\`\n\`\`\`typescript\nprobe\n\`\`\``

// Structural sampler: how many distinct animation frames the expanded tool
// bodies mount across. The frame batcher mounts a couple per frame; the
// unoptimized baseline mounts every body inside the mounting task, so the
// count jumps within a frame or two. One cheap querySelectorAll per frame.
let bodyMountFrames = 0
let bodySamplerLastCount = -1
const sampleBodyMounts = () => {
  const count = document.querySelectorAll(".tool-call-details").length
  if (count !== bodySamplerLastCount) {
    if (bodySamplerLastCount >= 0 && count > bodySamplerLastCount) bodyMountFrames += 1
    bodySamplerLastCount = count
  }
  requestAnimationFrame(sampleBodyMounts)
}
requestAnimationFrame(sampleBodyMounts)

const client: any = { session: {
  active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
  get: async ({ sessionID }: any) => ({ id: sessionID, location: { directory: "/fixture" }, time: { created: 1, updated: 1 } }),
}, message: { list: async ({ sessionID }: any) => ({ data: [...history[sessionID] ?? []].reverse() }) } }
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([homeId, homeBId, ...mountIds].map(id => [id, {
  id, instanceId, parentId: null, title: id, location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
} as any]))))
setActiveSession(instanceId, homeId)
await applyUiSettings({ locale: "en", showMessageTimeline: true, toolInputsVisibility: "hidden",
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { bash: toolBodies ? "expanded" : "collapsed", read: toolBodies ? "expanded" : "collapsed" } } })
await loadMessages(instanceId, homeId, { force: true })

// Deterministic language warm-up, independent of what the home transcript
// happens to render: one probe through the real pipeline loads the
// highlighter and every fence language the mount sessions use.
await initMarkdown(false)
await renderMarkdown(languageProbe, {})
for (let guard = 0; guard < 400 && hasPendingCodeHighlight(languageProbe); guard++) {
  await new Promise(resolve => setTimeout(resolve, 50))
}

const longtaskEntries: Array<{ startTime: number; duration: number }> = []
let lastLongtaskAt = 0
let switchStartedAt = performance.now()
new PerformanceObserver(entries => {
  for (const entry of entries.getEntries()) {
    longtaskEntries.push({ startTime: entry.startTime, duration: entry.duration })
    lastLongtaskAt = performance.now()
  }
}).observe({ entryTypes: ["longtask"], buffered: false })

// MessageSection follows this signal like SessionView follows the active
// session: a switch swaps the whole transcript in place.
const [activeId, setActiveId] = createSignal(homeId)

render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ display: "flex", height: "700px", width: "1000px" }}>
    <MessageSection instanceId={instanceId} sessionId={activeId()} isActive={true} />
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)

;(window as any).fixture = {
  mountSessions: mountIds,
  // Two small sessions give two "open a long session from a short one"
  // samples without making every switch big-to-big.
  smallSessions: [homeId, homeBId],
  messageCount,
  async switchTo(id: string) {
    await loadMessages(instanceId, id, { force: true })
    setActiveSession(instanceId, id)
    switchStartedAt = performance.now()
    setActiveId(id)
  },
  resetLongtasks() {
    longtaskEntries.length = 0
    lastLongtaskAt = 0
    switchStartedAt = performance.now()
    idleCallbackCount = 0
    bodyMountFrames = 0
    bodySamplerLastCount = -1
  },
  longtasks: () => ({
    max: longtaskEntries.length ? Math.max(...longtaskEntries.map(entry => entry.duration)) : 0,
    count: longtaskEntries.length,
    total: longtaskEntries.reduce((total, entry) => total + entry.duration, 0),
  }),
  worstLongtask: () => longtaskEntries.reduce<null | { startTime: number; duration: number }>((worst, entry) =>
    !worst || entry.duration > worst.duration ? { startTime: entry.startTime, duration: entry.duration } : worst, null),
  longtaskList: () => longtaskEntries.map(entry => ({ startTime: Math.round(entry.startTime), duration: Math.round(entry.duration) })),
  // Structural scheduler counts for the render-cost assertions: deferred
  // highlight passes and frame-batched tool-body mounts, load-independent.
  schedulerStats: () => ({ idleCallbacks: idleCallbackCount, bodyMountFrames }),  quietSince: () => performance.now() - Math.max(lastLongtaskAt, switchStartedAt),
  transcriptShows: (marker: string) => (document.querySelector(".message-stream")?.textContent ?? "").includes(marker),
  highlightPresent: () => Boolean(document.querySelector(".shiki")),
  languagesReady: () => !hasPendingCodeHighlight(languageProbe),
  counts: () => ({
    rows: document.querySelectorAll("[data-virtual-follow-key]").length,
    markers: document.querySelectorAll(".timeline-virtual-row").length,
    toolCalls: document.querySelectorAll(".tool-call").length,
  }),
}
