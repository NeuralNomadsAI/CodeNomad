import { batch, createMemo, createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import ToolCall from "../../../src/components/tool-call"
import { Markdown } from "../../../src/components/markdown"
import type { ToolCallPart } from "../../../src/components/tool-call/types"
import { ConfigProvider } from "../../../src/stores/preferences"
import { I18nProvider } from "../../../src/lib/i18n"
import { ThemeProvider } from "../../../src/lib/theme"
import { applyUiSettings } from "./ui-settings"
import { sdkManager } from "../../../src/lib/sdk-manager"
import { addInstance, instances, updateInstance } from "../../../src/stores/instances"
import { setSessions, setActiveSession, setMessagesLoaded } from "../../../src/stores/session-state"
import { messageStoreBus } from "../../../src/stores/message-v2/bus"
import { sseManager } from "../../../src/lib/sse-manager"
import { loadMessages } from "../../../src/stores/session-api"
import { normalizeSessionMessage } from "../../../src/stores/message-v2/normalizers"
import MessageItem from "../../../src/components/message-item"
import PromptAsideWindow from "../../../src/components/prompt-input/PromptAsideWindow"
import { clearCacheForInstance, getCacheEntry, setCacheEntry } from "../../../src/lib/global-cache"
import "../../../src/index.css"

const instanceId = "image-instance", sessionId = "image-session", messageId = "image-message"
const model = { providerID: "fixture", id: "fixture" }
let time = 1, messages: any[] = []
const client: any = {
  session: { active: async () => ({}), inbox: { list: async () => ({ data: [] }) },
    get: async () => ({ id: sessionId, location: { directory: "/fixture" }, time: { created: 1, updated: time } }) },
  message: { list: async () => ({ data: messages, cursor: {} }) },
}
;(sdkManager as any).clients.set(`${instanceId}:/workspaces/${instanceId}/instance`, client)
sseManager.getStatuses = () => new Map([[instanceId, "connected"]])
addInstance({ id: instanceId, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client })
setSessions(previous => new Map(previous).set(instanceId, new Map([[sessionId, {
  id: sessionId, instanceId, parentId: null, title: "Images", location: { directory: "/fixture" },
  status: "idle", agent: "build", model: { providerId: "fixture", modelId: "fixture" }, time: { created: 1, updated: 1 },
} as any]])))
setActiveSession(instanceId, sessionId)
const store = messageStoreBus.getOrCreate(instanceId)
const record = () => store.getMessage(messageId)?.parts.tool
const emit = (type: string, data: any) => (sseManager as any).handleEvent(instanceId, {
  id: `event-${++time}`, type, created: time, location: { directory: "/fixture" },
  data: { sessionID: sessionId, assistantMessageID: messageId, ...data },
})
function image(mime: string, color: string, name?: string) {
  const canvas = document.createElement("canvas")
  canvas.width = 800; canvas.height = 360
  const context = canvas.getContext("2d")!
  context.fillStyle = color; context.fillRect(0, 0, 800, 360)
  context.fillStyle = "#ffffff"; context.font = "32px sans-serif"
  context.fillText("MCP image result", 48, 180)
  return { type: "file", mime, name, uri: canvas.toDataURL(mime) }
}
const png = image("image/png", "#355e76", "generated.png")
const jpeg = image("image/jpeg", "#695342")
/** A large image a transcript page deferred: CodeNomad's session-media route serves it. */
const deferredUri = (digit = "a") => `/api/workspaces/${instanceId}/session-media/${sessionId}/${messageId}/0/0/${digit.repeat(64)}`
function content(kind: string) {
  if (kind === "only") return [png]
  if (kind === "deferred") return [{ ...png, uri: deferredUri() }]
  if (kind === "deferred-missing") return [{ ...png, uri: deferredUri("b") }]
  if (kind === "empty") return [{ type: "text", text: "Text-only result" }]
  if (kind === "broken") return [{ ...png, uri: "data:image/png;base64,broken" }]
  if (kind === "unsafe") return [{ ...png, uri: "javascript:window.unexpectedNavigation=true" }]
  return [{ type: "text", text: "Generated 2 images. Saved successfully." }, png, jpeg]
}
function completed(kind: string, name: string) {
  return { id: messageId, type: "assistant", agent: "build", model, time: { created: 1, completed: ++time },
    content: [{ id: "tool", type: "tool", name, time: { created: 1, completed: time },
      state: { status: "completed", input: { return_image: true }, content: content(kind) } }] }
}
/** An agent answer whose Markdown image names a local file, beside the read tool that holds its bytes. */
const answer = (text: string) => ({ id: "answer-message", type: "assistant", agent: "build", model, time: { created: 2, completed: ++time },
  content: [{ id: "answer", type: "text", text }] })
const readSheep = (uri = png.uri) => ({ ...completed("only", "read"), content: [{ id: "tool", type: "tool", name: "read", time: { created: 1, completed: time },
  state: { status: "completed", input: { filePath: "C:\\Users\\me\\Temp\\images\\sheep.png" },
    content: [{ ...png, uri, name: "C:\\Users\\me\\Temp\\images\\sheep.png" }] } }] })
const answerRecord = () => store.getMessage("answer-message")?.parts["answer-message-text-0"]
const [mediaMode, setMediaMode] = createSignal(false)
const [owner, setOwner] = createSignal("media-A")
const [mediaText, setMediaText] = createSignal("")
const [mediaPart, setMediaPart] = createSignal<any>()
const [trustedVisible, setTrustedVisible] = createSignal(false)
let mediaVersion = 10
const [asideOpen, setAsideOpen] = createSignal(false)
const mediaSession = "same", mediaMessage = "same-message"
const mediaStore = () => messageStoreBus.getOrCreate(owner())
// Retain displayed snapshots while an owner is unavailable, as the transcript does.
const mediaRecord = createMemo<any>(previous => mediaStore().getMessage(mediaMessage) ?? previous)
const userRecord = createMemo<any>(previous => mediaStore().getMessage("user") ?? previous)
const mediaPath = (id = owner(), session = mediaSession) => `/api/workspaces/${id}/session-media/${session}/${mediaMessage}/0/0/${"c".repeat(64)}`
for (const id of ["media-A", "media-B"]) {
  addInstance({ id, folder: "/fixture", port: 0, pid: 0, proxyPath: "", status: "ready", client,
    binding: { serverId: id, directory: "/fixture" }, capabilities: { serverId: id, generation: 1, features: { media: { state: "available" } } } as any })
  setSessions(previous => new Map(previous).set(id, new Map([mediaSession, "child"].map(session => [session, {
    id: session, instanceId: id, parentId: session === "child" ? mediaSession : null, title: "Media policy", location: { directory: "/fixture" },
    status: "idle", time: { created: 1, updated: 1 },
  } as any]))))
  setMessagesLoaded(previous => new Map(previous).set(id, new Set([mediaSession, "child"])))
}
const asideController: any = { open: asideOpen, answer: mediaText, question: () => "", error: () => "", interrupted: () => false,
  pending: () => false, close: () => setAsideOpen(false), ask: async () => {}, cancel: () => {}, setQuestion: () => {} }
function seedMedia(options: { uri?: string; mime?: string; text?: string; name?: string; cache?: "local" | "global"; nested?: boolean; file?: boolean } = {}) {
  return batch(() => {
  setMediaMode(true)
  const id = owner(), source = options.uri ?? png.uri, mime = options.mime ?? "image/png", text = options.text ?? "Media policy text"
  const tool = { id: "tool", type: "tool", name: options.name ?? "skill", time: { created: 1, completed: ++time },
    state: { status: "completed", input: { name: "fixture", filePath: "/fixture/held.png" }, content: [{ type: "file", mime, uri: source, name: "held.png" }, { type: "text", text }] } }
  const normalized = normalizeSessionMessage(mediaSession, { id: mediaMessage, type: "assistant", agent: "build", model,
    time: { created: 1, completed: time }, content: [tool] } as any)
  mediaStore().hydrateMessages(mediaSession, [normalized.message])
  mediaStore().upsertMessage({ id: "user", sessionId: mediaSession, role: "user", status: "complete", parts: [{ id: "file", type: "file", url: source, mime, filename: "attachment.bin" }] as any })
  const other = id === "media-A" ? "media-B" : "media-A"
  const otherSource = source.replace(`/api/workspaces/${id}/`, `/api/workspaces/${other}/`)
  const otherStore = messageStoreBus.getOrCreate(other)
  const otherTool = { ...tool, state: { ...tool.state, content: [{ type: "file", mime, uri: otherSource, name: "held.png" }, { type: "text", text }] } }
  otherStore.hydrateMessages(mediaSession, [normalizeSessionMessage(mediaSession, { id: mediaMessage, type: "assistant", agent: "build", model,
    time: { created: 1, completed: time }, content: [otherTool] } as any).message])
  otherStore.upsertMessage({ id: "user", sessionId: mediaSession, role: "user", status: "complete", parts: [{ id: "file", type: "file", url: otherSource, mime, filename: "attachment.bin" }] as any })
  setMediaText(text)
  const part: any = { id: "same-text", version: options.cache ? 1 : ++mediaVersion, type: "text", text }
  const cached = { html: `<span data-media-cache="${options.cache}">Cached</span>${text}`, theme: "light", mode: "1:escaped:wrap",
    mediaOwnerKey: JSON.stringify([id, mediaSession, id, "/fixture", "/fixture"]) }
  if (options.cache === "local") part.renderCache = cached
  if (options.cache === "global") setCacheEntry({ instanceId: id, sessionId: mediaSession, scope: "markdown", cacheId: "same-text:light:0:1:1", version: "1" }, cached)
  setMediaPart(part)
  if (options.nested) {
    const childTool = { ...tool, name: "read", state: { ...tool.state, content: [{ ...png, uri: mediaPath(id, "child").replace(`/${mediaMessage}/`, `/${mediaMessage}-child/`) }] } }
    mediaStore().hydrateMessages("child", [normalizeSessionMessage("child", { id: mediaMessage + "-child", type: "assistant", agent: "build", model, time: { created: 1 }, content: [childTool] } as any).message])
    mediaStore().hydrateMessages(mediaSession, [normalizeSessionMessage(mediaSession, { id: mediaMessage, type: "assistant", agent: "build", model, time: { created: 1 }, content: [{ ...tool, name: "task", state: { ...tool.state, metadata: { sessionId: "child" }, content: [{ type: "text", text: "Nested image" }] } }] } as any).message])
  }
  return { path: mediaPath(id), base64: png.uri.slice(png.uri.indexOf(",") + 1) }
  })
}
await applyUiSettings({ toolInputsVisibility: "hidden", toolOutputExpansion: "expanded",
  toolCallExpansionDefaults: { preset: "custom", thinking: "collapsed", tools: { other: "expanded", read: "expanded" } } })
render(() => <ConfigProvider><I18nProvider><ThemeProvider>
  <main style={{ width: "min(720px, 100%)", padding: "20px", "box-sizing": "border-box" }}>
    <Show when={mediaMode()}>
      <section class="media-policy">
        <Show when={mediaRecord()}>{record => <ToolCall toolCall={record().parts[record().partIds[0]].data as any}
          messageId={mediaMessage} instanceId={owner()} sessionId={mediaSession} partVersion={record().revision} />}</Show>
        <Show when={mediaPart()}>{part => <section class="media-markdown"><Markdown part={part()} instanceId={owner()} sessionId={mediaSession} disableHighlight /></section>}</Show>
        <Show when={userRecord()}>{record => <section class="media-attachment"><MessageItem record={record()} parts={record().partIds.map(id => record().parts[id].data)}
          instanceId={owner()} sessionId={mediaSession} technicalCleanupParts={() => []} /></section>}</Show>
        <PromptAsideWindow id="media-aside" instanceId={owner()} controller={asideController} />
      </section>
    </Show>
    <Show when={!mediaMode()}>
    <Show when={trustedVisible()}><section class="fixture-trusted"><Markdown
      part={{ id: "trusted-text", version: 1, type: "text", text: `![trusted](${window.location.origin}/trusted-image.png)` }}
      disableHighlight escapeRawHtml /></section></Show>
    <Show when={record()}>{part => <ToolCall toolCall={part().data as ToolCallPart} partVersion={part().revision}
      messageId={messageId} instanceId={instanceId} sessionId={sessionId} />}</Show>
    <Show when={answerRecord()}>{part => <section class="fixture-answer">
      <Markdown part={part().data as any} instanceId={instanceId} sessionId={sessionId} />
    </section>}</Show>
    </Show>
  </main>
</ThemeProvider></I18nProvider></ConfigProvider>, document.getElementById("root")!)
;(window as any).fixture = {
  media: seedMedia,
  owner: (id: string) => setOwner(id),
  aside: () => setAsideOpen(true),
  rotate: () => updateInstance(owner(), { capabilities: { ...instances().get(owner())!.capabilities!, generation: 2 } }),
  missing: () => setOwner("missing-owner"),
  settings: applyUiSettings,
  hideMedia: () => setMediaMode(false),
  showMedia: () => setMediaMode(true),
  sourceLength: () => mediaText().length,
  rebind: (serverId: string) => updateInstance(owner(), { binding: { serverId, directory: "/other" } }),
  rebindLocal: () => updateInstance(owner(), { binding: { serverId: "local-shared", directory: "/fixture" } }),
  clearMediaCaches: () => clearCacheForInstance(owner()),
  trusted: (visible: boolean) => { setMediaMode(false); setTrustedVisible(visible) },
  trustedCache: () => getCacheEntry({ scope: "markdown", cacheId: "trusted-text:light:0:1:1", version: "1" }),
  history: async (kind = "mixed", name = "forge-painter_txt2img") => {
    messages = [completed(kind, name)]
    await loadMessages(instanceId, sessionId, { force: true })
  },
  start: () => {
    emit("session.step.started", { agent: "build", model, started: 1 })
    emit("session.tool.input.started", { id: "tool", name: "forge-painter_txt2img" })
    emit("session.tool.called", { id: "tool", input: { return_image: true } })
  },
  finish: () => {
    messages = [completed("mixed", "forge-painter_txt2img")]
    emit("session.tool.success", { id: "tool", content: content("mixed"), executed: true })
  },
  reload: () => loadMessages(instanceId, sessionId, { force: true }),
  localImageAnswer: async (read: "none" | "valid" | "broken") => {
    messages = [...(read === "none" ? [] : [readSheep(read === "broken" ? "data:image/png;base64,broken" : png.uri)]), answer("Voici ton mouton !\n\n![Un petit mouton](C:/Users/me/Temp/images/sheep.png)\n\n![Absent](C:/Users/me/missing.png)")]
    await loadMessages(instanceId, sessionId, { force: true })
  },
  deferred: () => ({ path: deferredUri(), base64: png.uri.slice(png.uri.indexOf(",") + 1) }),
  execute: async (phase: string) => {
    const input = { code: "const results = await Promise.all([tools.paint({ prompt: 'sky' }), tools.fail({})]);\nreturn results" }
    const metadata = { toolCalls: [
      { tool: "paint", status: phase === "running" ? "running" : "completed", input: { prompt: "sky" } },
      { tool: "fail", status: phase === "running" ? "running" : "error", input: { test: true } },
    ], ...(phase === "running" ? {} : { error: true, truncated: true, outputPath: "/fixture/output.txt" }) }
    if (phase === "progress") {
      metadata.toolCalls.push({ tool: "third", status: "running", input: { test: true } })
      emit("session.tool.progress", { id: "tool", metadata })
      return
    }
    if (phase === "running") {
      emit("session.step.started", { agent: "build", model, started: 1 })
      emit("session.tool.input.started", { id: "tool", name: "execute" })
      emit("session.tool.called", { id: "tool", input })
      emit("session.tool.progress", { id: "tool", metadata })
      return
    }
    messages = [{ ...completed("mixed", "execute"), content: [{ id: "tool", type: "tool", name: "execute",
      time: { created: 1, completed: time }, state: { status: "completed", input, metadata, content: content("mixed") } }] }]
    if (phase === "history") await loadMessages(instanceId, sessionId, { force: true })
    else emit("session.tool.success", { id: "tool", content: content("mixed"), metadata, executed: true })
  },
}
