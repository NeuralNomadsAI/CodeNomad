import { z } from "zod"
import { onCleanup } from "solid-js"
import { assetTargetSchema } from "../../../../server/src/opencode/session-pruning/assets-contract"
import { generationTargetSchema } from "../../../../server/src/opencode/session-pruning/assets-gallery-contract"
import { PANEL_EXTENSION_LIMITS } from "../../../../server/src/panel-extensions/contract"
import { panelExtensionsApi4 } from "../../lib/panel-extensions-api"
import { serverEvents } from "../../lib/server-events"
import { getActiveCatalogLocation } from "../../stores/session-api"
import { openListedSession } from "../../stores/history-search-sessions"
import { requestComposerFocus } from "../../stores/composer-focus"
import { resolveImagesConversation, showImagesConversation } from "../../stores/images-conversation"
import { beginGesture } from "../../stores/session-surface"
import type { PromptInputApi } from "../prompt-input/types"
import { assertThumbnailBounds } from "./image-bounds"
import { thumbnail } from "./assets-channel"
import { composePrefill, prefillMarkers, PREFILL_LIMITS } from "./composer-prefill"

/** Frame deadline is 20 s; the host answers first and cancels its own work. */
export const API4_HOST_DEADLINE_MS = 19_500
const MAX_PENDING = 4, PREFILL_INTERVAL_MS = 1_000, CHANGE_DELAY_MS = 300

const requestSchema = z.object({ type: z.literal("api4:request"), id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  capability: z.enum(["images", "composer", "conversation", "preferences", "notes"]), method: z.string().max(32), input: z.unknown() }).strict()
const grants = { images: "session.images.read", composer: "composer.prefill", conversation: "images.conversation", preferences: "panel.preferences",
  notes: "panel.notes" } as const
const empty = z.object({}).strict()
const listSchema = z.object({ cursor: z.string().max(4096).optional() }).strict()
const readSchema = z.object({ target: assetTargetSchema, thumbnail: z.boolean() }).strict()
const Session = z.string().min(1).max(256), Revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
// Text is measured in UTF-8 bytes below, so an oversized note answers `too-large`.
const noteSetSchema = z.object({ text: z.string(), revision: Revision }).strict()
const noteDeleteSchema = z.object({ sessionID: Session, revision: Revision.min(1) }).strict()
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
  // `epoch` counts disconnections: an approval taken before one never comes back with the reconnection.
  let disposed = false, connected = true, nativeConnected = true, nativeGeneration: number | undefined, epoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined, changes = { gallery: false, status: false, notes: false }
  const current = () => !disposed && connected && nativeConnected && (props.host.activeSessionId() ?? null) === props.sessionId
  const abort = () => { for (const request of pending) request.abort() }
  // Each kind only for its own permission, over one coalescing window.
  const invalidate = (gallery: boolean, status: boolean, notes = false) => {
    const images = granted("session.images.read")
    const next = { gallery: changes.gallery || (images && gallery), status: changes.status || (images && status),
      notes: changes.notes || (notes && granted("panel.notes")) }
    if (disposed || !(next.gallery || next.status || next.notes)) return
    changes = next
    timer ??= setTimeout(() => {
      timer = undefined
      const { notes, ...detail } = changes
      changes = { gallery: false, status: false, notes: false }
      if (disposed || !connected || !nativeConnected) return
      if (detail.gallery || detail.status) props.send({ type: "images:changed", ...detail })
      if (notes) props.send({ type: "notes:changed" })
    }, CHANGE_DELAY_MS)
  }
  onCleanup(serverEvents.on("instance.event", payload => {
    if (payload.type !== "instance.event") return
    const event = payload.event as { type?: string; data?: { sessionID?: string } }
    const type = event.type ?? ""
    // A deleted session leaves an orphan note, in any window sharing the project (another
    // clone, another instance); other title changes show on the next read.
    if (type === "session.deleted") invalidate(false, false, true)
    if (payload.instanceId !== props.instanceId) return
    const own = Boolean(session) && event.data?.sessionID === session
    if (own && GALLERY_EVENTS.has(type)) invalidate(true, type === "session.updated" || type === "session.moved")
    else if (STATUS_EVENTS.has(type)) invalidate(false, true)
  }))
  // Data-free and per package: the frame re-reads what its own authority shows.
  onCleanup(serverEvents.on("panelExtensions.notesChanged", event => {
    if (event.type === "panelExtensions.notesChanged" && event.id === props.id) invalidate(false, false, true)
  }))
  onCleanup(serverEvents.on("instance.eventStatus", event => {
    if (event.type !== "instance.eventStatus") return
    // Another instance resynchronized: it may have missed a deletion in a project these notes share.
    if (event.instanceId !== props.instanceId) { if (event.status === "connected") invalidate(false, false, true); return }
    nativeConnected = event.status === "connected"
    if (!nativeConnected) epoch++
    if (!nativeConnected || nativeGeneration !== event.generation) abort()
    nativeGeneration = event.generation
    if (nativeConnected) invalidate(true, true, true)
  }))
  onCleanup(serverEvents.onTransportStatus(status => {
    connected = status === "connected"
    if (!connected) { epoch++; abort() }
    else invalidate(true, true, true)
  }))
  onCleanup(() => { disposed = true; clearTimeout(timer); abort(); pending.clear() })

  const location = () => getActiveCatalogLocation(props.instanceId).directory
  /** The project's anchor: the displayed conversation, else the instance's Location. */
  const displayed = () => session ? { sessionID: session } : {}
  // Frame-supplied names select only these own entries (Maps, never property lookups on objects).
  const table = (entries: Record<string, (input: unknown, signal: AbortSignal) => Promise<Answer>>) => new Map(Object.entries(entries))
  const methods = new Map<keyof typeof grants, Map<string, (input: unknown, signal: AbortSignal) => Promise<Answer>>>(Object.entries({
    images: table({
      status: async (input, signal) => {
        empty.parse(input)
        return { result: await panelExtensionsApi4.imagesStatus(authority, session ? { sessionID: session } : { directory: location() }, signal) }
      },
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
    }),
    composer: table({ prefill: (input, signal) => prefill(input, signal) }),
    conversation: table({
      status: async (input, signal) => {
        empty.parse(input)
        return { result: await panelExtensionsApi4.conversationStatus(authority, location(), session ?? undefined, signal) }
      },
      open: (input, signal) => { empty.parse(input); return conversation("open", signal) },
      startNew: (input, signal) => { empty.parse(input); return conversation("new", signal) },
    }),
    preferences: table({
      get: async (input, signal) => {
        empty.parse(input)
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
    }),
    // The displayed conversation's note; its project (the agent-memory identity) lists every note.
    notes: table({
      get: async (input, signal) => {
        empty.parse(input)
        if (!session) return { result: null }
        return { result: (await panelExtensionsApi4.notes<{ note: unknown }>(authority, "notesGet", { sessionID: session }, signal)).note }
      },
      set: async (input, signal) => {
        const { text, revision } = noteSetSchema.parse(input)
        if (!session) return { result: { status: "no-session" } }
        if (new TextEncoder().encode(text).length > PANEL_EXTENSION_LIMITS.noteBytes) return { result: { status: "too-large" } }
        return { result: await panelExtensionsApi4.notes(authority, "notesSet", { sessionID: session, text, revision }, signal) }
      },
      list: async (input, signal) => {
        const { cursor } = listSchema.parse(input)
        return { result: await panelExtensionsApi4.notes(authority, "notesList", { ...displayed(), cursor }, signal) }
      },
      delete: async (input, signal) => {
        const { sessionID, revision } = noteDeleteSchema.parse(input)
        return { result: await panelExtensionsApi4.notes(authority, "notesDelete", { ...displayed(), target: sessionID, revision }, signal) }
      },
      open: async (input, signal) => {
        const { sessionID } = z.object({ sessionID: Session }).strict().parse(input)
        // Taken now, so anything the user does while the host checks wins over this navigation.
        const intent = beginGesture({ instanceId: props.instanceId, sessionId: props.sessionId ?? null })
        const { openable } = await panelExtensionsApi4.notes<{ openable: boolean }>(authority, "notesOpen", { ...displayed(), target: sessionID }, signal)
        if (!openable) return { result: { opened: false } }
        // Answer first: showing the session remounts the panel.
        // The approval holds only for this mounting, transport and native generation.
        const selected = props.sessionId, generation = nativeGeneration, approved = epoch
        const valid = () => !disposed && connected && nativeConnected && nativeGeneration === generation && epoch === approved
          && (props.host.activeSessionId() ?? null) === selected
        return { result: { opened: true }, after: () => {
          void openListedSession(props.instanceId, sessionID, valid,
            undefined, intent).then(opened => {
            if (opened && props.host.isPhoneLayout()) props.host.closePanel()
          }, () => {})
        } }
      },
    }),
  }) as Array<[keyof typeof grants, Map<string, (input: unknown, signal: AbortSignal) => Promise<Answer>>]>)

  async function conversation(mode: "open" | "new", signal: AbortSignal): Promise<Answer> {
    const intent = beginGesture({ instanceId: props.instanceId, sessionId: props.sessionId ?? null })
    const result = await resolveImagesConversation(props.instanceId, mode,
      (_instance, request) => panelExtensionsApi4.conversation(authority, request, signal))
    if (result.status !== "found") return { result: mode === "new" ? { opened: false } : { opened: false, created: false } }
    // Answer the frame first; showing the conversation then remounts the panel. A conversation
    // the user selects during hydration wins: navigation needs the mount's selection unchanged.
    const selected = props.sessionId
    return { result: mode === "new" ? { opened: true } : { opened: true, created: result.created }, after: () => {
      void showImagesConversation(props.instanceId, result, () => !signal.aborted && (props.host.activeSessionId() ?? null) === selected, intent)
      if (intent.current() && props.host.isPhoneLayout()) props.host.closePanel()
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
      const run = methods.get(capability)?.get(method)
      if (!granted(grants[capability]) || typeof run !== "function" || !connected || !nativeConnected || pending.size >= MAX_PENDING) throw new Error("Unavailable")
      pending.add(controller)
      const { result, after } = await run(input, controller.signal)
      if (!current() || controller.signal.aborted) throw new Error("Stale")
      // Host actions that remove the frame (navigation, closing the phone panel) wait one
      // task, so the frame handles its answer first. Only host functions, never a string.
      if (answer({ result }) && typeof after === "function") setTimeout(() => after(), 0)
    } catch {
      controller.abort()
      answer({ error: true })
    }
  }
}
