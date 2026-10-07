import { z } from "zod"
import { onCleanup } from "solid-js"
import { assetTargetSchema } from "../../../../server/src/opencode/session-pruning/assets-contract"
import { panelExtensionsApi } from "../../lib/panel-extensions-api"
import { serverEvents } from "../../lib/server-events"
import { assertThumbnailBounds } from "./image-bounds"

const requestSchema = z.object({ type: z.literal("assets:request"), id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  method: z.enum(["list", "read"]), input: z.unknown() }).strict()
const listSchema = z.object({ cursor: z.string().max(4096).optional() }).strict()
const readSchema = z.object({ target: assetTargetSchema, thumbnail: z.boolean() }).strict()

/** Fixed read capability, not an RPC proxy. Session/extension authority is host-owned. */
export function useAssetsChannel(props: {
  instanceId: string; id: string; digest: string; sessionId: () => string | null;
  send: (value: unknown) => void
}) {
  const pending = new Set<AbortController>()
  let disposed = false, connected = true, timer: ReturnType<typeof setTimeout> | undefined
  const invalidate = () => {
    if (timer || disposed) return
    timer = setTimeout(() => { timer = undefined; if (!disposed) props.send({ type: "assets:changed" }) }, 300)
  }
  onCleanup(serverEvents.on("instance.event", payload => {
    if (payload.type !== "instance.event" || payload.instanceId !== props.instanceId) return
    const event = payload.event as { type?: string; data?: { sessionID?: string } }
    if (event.data?.sessionID === props.sessionId() && ["session.tool.success", "session.message.content.updated", "session.moved", "session.deleted",
      "session.revert.staged", "session.revert.cleared", "session.revert.committed", "session.compaction.ended"].includes(event.type ?? "")) invalidate()
  }))
  onCleanup(serverEvents.onTransportStatus(status => {
    connected = status === "connected"
    if (!connected) for (const request of pending) request.abort()
    else invalidate()
  }))
  onCleanup(() => { disposed = true; clearTimeout(timer); for (const request of pending) request.abort(); pending.clear() })
  return async (value: unknown) => {
    const parsed = requestSchema.safeParse(value)
    if (!parsed.success || disposed) return
    const { id, method, input } = parsed.data, session = props.sessionId()
    const controller = new AbortController()
    try {
      if (!connected || !session || pending.size >= 4) throw new Error("Unavailable")
      pending.add(controller)
      const args = [props.instanceId, props.id, props.digest, session] as const
      let result
      if (method === "list") {
        const request = listSchema.parse(input)
        result = await panelExtensionsApi.assets(...args, request.cursor, controller.signal)
      } else {
        const request = readSchema.parse(input)
        const asset = await panelExtensionsApi.assetRead(...args, request.target, controller.signal)
        result = request.thumbnail ? await thumbnail(asset) : asset
      }
      if (!disposed && connected && !controller.signal.aborted && props.sessionId() === session) props.send({ type: "assets:result", id, result })
    } catch {
      if (!disposed && props.sessionId() === session) props.send({ type: "assets:result", id, error: true })
    } finally { pending.delete(controller) }
  }
}

async function thumbnail(asset: { mime: string; uri: string }) {
  if (!/^image\/(png|jpeg|gif|webp|avif)$/i.test(asset.mime)) throw new Error("Unsupported preview")
  const bytes = Uint8Array.from(atob(asset.uri.slice(asset.uri.indexOf(",") + 1)), char => char.charCodeAt(0))
  assertThumbnailBounds(bytes, asset.mime)
  const image = await createImageBitmap(new Blob([bytes], { type: asset.mime }))
  try {
    const scale = Math.min(1, 256 / image.width, 256 / image.height)
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(image.width * scale)); canvas.height = Math.max(1, Math.round(image.height * scale))
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Unsupported preview")
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return { mime: "image/png", uri: canvas.toDataURL("image/png") }
  } finally { image.close() }
}
