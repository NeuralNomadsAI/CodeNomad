import { z } from "zod"
import { onCleanup } from "solid-js"
import { assetTargetSchema } from "../../../../server/src/opencode/session-pruning/assets-contract"
import { generationTargetSchema } from "../../../../server/src/opencode/session-pruning/assets-gallery-contract"
import { PANEL_EXTENSION_LIMITS } from "../../../../server/src/panel-extensions/contract"
import { panelExtensionsApi4 } from "../../lib/panel-extensions-api"
import { serverEvents } from "../../lib/server-events"
import { getActiveCatalogLocation } from "../../stores/session-api"
import { requestComposerFocus } from "../../stores/composer-focus"
import { resolveImagesConversation, showImagesConversation } from "../../stores/images-conversation"
import type { PromptInputApi } from "../prompt-input/types"
import { assertThumbnailBounds } from "./image-bounds"
import { thumbnail } from "./assets-channel"
import { composePrefill, prefillMarkers, PREFILL_LIMITS } from "./composer-prefill"

/** Frame deadline is 20 s; the host answers first and cancels its own work. */
export const API4_HOST_DEADLINE_MS = 19_500
const MAX_PENDING = 4, PREFILL_INTERVAL_MS = 1_000, CHANGE_DELAY_MS = 300

const requestSchema = z.object({ type: z.literal("api4:request"), id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  capability: z.enum(["images", "composer", "conversation", "preferences"]), method: z.string().max(32), input: z.unknown() }).strict()
const grants = { images: "session.images.read", composer: "composer.prefill", conversation: "images.conversation", preferences: "panel.preferences" } as const
const listSchema = z.object({ cursor: z.string().max(4096).optional() }).strict()
const readSchema = z.object({ target: assetTargetSchema, thumbnail: z.boolean() }).strict()
const prefillSchema = z.object({ text: z.string().max(64 * 1024), refs: z.array(z.union([assetTargetSchema, generationTargetSchema])).max(PREFILL_LIMITS.refs).optional() }).strict()

// Displayed-session transcript changes restart the gallery; catalogue, configuration,
// credential, skill and agent changes re-read the status (dev-docs/PANEL_EXTENSIONS.md#api-4).
const GALLERY_EVENTS = new Set(["session.tool.called", "session.tool.input.started", "session.tool.input.ended", "session.tool.success", "session.tool.failed",
  "session.synthetic", "session.updated", "session.moved", "session.deleted", "session.revert.staged", "session.revert.cleared", "session.revert.committed",
  "session.compaction.ended", "rpc.codenomad.session-pruning.pruned"])
const STATUS_EVENTS = new Set(["agent.updated", "skill.updated", "config.updated", "plugin.updated", "model.updated", "provider.updated", "models-dev.refreshed",
  "integration.updated", "credential.updated", "credential.switched"])

// At most one prefill a second per extension in this window, counted when accepted.
const lastPrefill = new Map<string, number>()

export interface Api4Host {
  /** The displayed conversation's composer. */
  promptInputApi: () => PromptInputApi | null
  activeSessionId: () => string | null
  isPhoneLayout: () => boolean
  closePanel: () => void
}

type Answer = { result: unknown; after?: () => void }

/**
 * The API 4 host side of one mounting: fixed methods per declared permission,
 * never an RPC proxy. Instance, session, Location, title, agent and model are
 * host-owned; at most four requests at once, each answered or failed within
 * 19.5 s, and nothing is delivered after unmount or a session change.
 */
export function useApi4Channel(props: {
  instanceId: string; id: string; digest: string; permissions: readonly string[]; sessionId: string | null
  send: (value: unknown) => void; host: Api4Host
}) {
  const pending = new Set<AbortController>()
  const authority = { instanceId: props.instanceId, id: props.id, digest: props.digest }
  const session = props.sessionId && props.sessionId !== "info" ? props.sessionId : null
  const granted = (permission: string) => props.permissions.includes(permission)
  let disposed = false, connected = true, nativeConnected = true, nativeGeneration: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined, changes = { gallery: false, status: false }
  const current = () => !disposed && connected && nativeConnected && (props.host.activeSessionId() ?? null) === props.sessionId
  const abort = () => { for (const request of pending) request.abort() }
  const invalidate = (gallery: boolean, status: boolean) => {
    if (disposed || !granted("session.images.read")) return
    changes = { gallery: changes.gallery || gallery, status: changes.status || status }
    timer ??= setTimeout(() => {
      timer = undefined
      const detail = changes
      changes = { gallery: false, status: false }
      if (!disposed && connected && nativeConnected) props.send({ type: "images:changed", ...detail })
    }, CHANGE_DELAY_MS)
  }
  onCleanup(serverEvents.on("instance.event", payload => {
    if (payload.type !== "instance.event" || payload.instanceId !== props.instanceId) return
    const event = payload.event as { type?: string; data?: { sessionID?: string } }
    const type = event.type ?? ""
    const own = Boolean(session) && event.data?.sessionID === session
    if (own && GALLERY_EVENTS.has(type)) invalidate(true, type === "session.updated" || type === "session.moved")
    else if (STATUS_EVENTS.has(type)) invalidate(false, true)
  }))
  onCleanup(serverEvents.on("instance.eventStatus", event => {
    if (event.type !== "instance.eventStatus" || event.instanceId !== props.instanceId) return
    nativeConnected = event.status === "connected"
    if (!nativeConnected || nativeGeneration !== event.generation) abort()
    nativeGeneration = event.generation
    if (nativeConnected) invalidate(true, true)
  }))
  onCleanup(serverEvents.onTransportStatus(status => {
    connected = status === "connected"
    if (!connected) abort()
    else invalidate(true, true)
  }))
  onCleanup(() => { disposed = true; clearTimeout(timer); abort(); pending.clear() })

  const location = () => getActiveCatalogLocation(props.instanceId).directory
  const methods: Record<keyof typeof grants, Record<string, (input: unknown, signal: AbortSignal) => Promise<Answer>>> = {
    images: {
      status: async (_input, signal) => ({ result: await panelExtensionsApi4.imagesStatus(authority,
        session ? { sessionID: session } : { directory: location() }, signal) }),
      list: async (input, signal) => {
        const { cursor } = listSchema.parse(input)
        // Without a displayed conversation the gallery is empty.
        if (!session) return { result: { status: "page", entries: [], cursor: null } }
        return { result: await panelExtensionsApi4.images(authority, session, cursor, signal) }
      },
      read: async (input, signal) => {
        const request = readSchema.parse(input)
        if (!session) throw new Error("No conversation")
        const image = await panelExtensionsApi4.imageRead(authority, session, request.target, signal)
        if (image.status !== "asset") return { result: image }
        // Decode bounds apply to the full size as to thumbnails.
        try {
          if (!/^image\/(png|jpeg|gif|webp|avif)$/i.test(image.mime)) throw new Error("Unsupported preview")
          assertThumbnailBounds(Uint8Array.from(atob(image.uri.slice(image.uri.indexOf(",") + 1)), char => char.charCodeAt(0)), image.mime)
        } catch { return { result: { status: "not-previewable" } } }
        return { result: request.thumbnail ? { status: "asset", ...await thumbnail(image) } : image }
      },
    },
    composer: { prefill: (input, signal) => prefill(input, signal) },
    conversation: {
      status: async (_input, signal) => ({ result: await panelExtensionsApi4.conversationStatus(authority, location(), session ?? undefined, signal) }),
      open: (_input, signal) => conversation("open", signal),
      startNew: (_input, signal) => conversation("new", signal),
    },
    preferences: {
      get: async (_input, signal) => {
        const answer = await panelExtensionsApi4.preferencesGet(authority, signal)
        return { result: answer.status === "ok" ? answer.value : "unavailable" }
      },
      set: async (input, signal) => {
        const { value } = z.object({ value: z.unknown() }).strict().parse(input)
        // Measured here too, so an oversized object never travels.
        let text: string | undefined
        try { text = JSON.stringify(value) } catch { return { result: "invalid" } }
        if (text !== undefined && new TextEncoder().encode(text).length > PANEL_EXTENSION_LIMITS.preferencesBytes) return { result: "too-large" }
        return { result: (await panelExtensionsApi4.preferencesSet(authority, value, signal)).status }
      },
    },
  }

  async function conversation(mode: "open" | "new", signal: AbortSignal): Promise<Answer> {
    const result = await resolveImagesConversation(props.instanceId, mode,
      (_instance, request) => panelExtensionsApi4.conversation(authority, request, signal))
    if (result.status !== "found") return { result: mode === "new" ? { opened: false } : { opened: false, created: false } }
    // Answer the frame first; showing the conversation then remounts the panel.
    return { result: mode === "new" ? { opened: true } : { opened: true, created: result.created }, after: () => {
      void showImagesConversation(props.instanceId, result)
      if (props.host.isPhoneLayout()) props.host.closePanel()
    } }
  }

  async function prefill(value: unknown, signal: AbortSignal): Promise<Answer> {
    const parsed = prefillSchema.safeParse(value)
    if (!parsed.success) return { result: "invalid" }
    const { text, refs = [] } = parsed.data
    const api = props.host.promptInputApi()
    if (!session || !api) return { result: "no-session" }
    const now = Date.now()
    if (api.getMode() === "shell" || now - (lastPrefill.get(props.id) ?? -Infinity) < PREFILL_INTERVAL_MS) return { result: "busy" }
    lastPrefill.set(props.id, now)
    if (prefillMarkers(text, refs.length) === "invalid") return { result: "invalid" }
    const paths = refs.length ? (await panelExtensionsApi4.prefillReferences(authority, session, refs, signal)).paths : []
    if (paths.some(path => path === null)) return { result: "invalid" }
    // The conversation captured at mount must still be displayed, with the same composer.
    if (!current() || props.host.promptInputApi() !== api) throw new Error("Conversation changed")
    if (api.getMode() === "shell") return { result: "busy" }
    const composed = composePrefill(api.getPromptText(), text, paths as string[])
    if (composed.status !== "added") return { result: composed.status }
    const phone = props.host.isPhoneLayout()
    api.setPromptText(composed.draft, { focus: !phone })
    if (phone) return { result: "added", after: () => { props.host.closePanel(); requestComposerFocus(props.instanceId, session) } }
    // Checked one frame later and taken once more if the frame kept it.
    requestAnimationFrame(() => { if (!disposed && document.activeElement?.closest?.(".prompt-input") == null) api.focus() })
    return { result: "added" }
  }

  return async (value: unknown) => {
    const parsed = requestSchema.safeParse(value)
    if (!parsed.success || disposed) return
    const { id, capability, method, input } = parsed.data
    const controller = new AbortController()
    let settled = false
    const answer = (message: Record<string, unknown>) => {
      if (settled) return false
      settled = true
      clearTimeout(deadline)
      pending.delete(controller)
      if (!disposed && (props.host.activeSessionId() ?? null) === props.sessionId) props.send({ type: "api4:result", id, ...message })
      return true
    }
    const deadline = setTimeout(() => { controller.abort(new Error("Deadline")); answer({ error: true }) }, API4_HOST_DEADLINE_MS)
    try {
      const run = methods[capability][method]
      if (!granted(grants[capability]) || !run || !connected || !nativeConnected || pending.size >= MAX_PENDING) throw new Error("Unavailable")
      pending.add(controller)
      const { result, after } = await run(input, controller.signal)
      if (!current() || controller.signal.aborted) throw new Error("Stale")
      // Host actions that remove the frame (navigation, closing the phone panel) wait one
      // task, so the frame handles its answer first.
      if (answer({ result }) && after) setTimeout(after, 0)
    } catch {
      answer({ error: true })
    }
  }
}
