import { z } from "zod"
import { onCleanup } from "solid-js"
import { openExternalUrl } from "../../lib/external-url"
import { panelExtensionsApi } from "../../lib/panel-extensions-api"
import { serverEvents } from "../../lib/server-events"

const kind = z.enum(["issue", "pullRequest"])
const requestSchema = z.object({ type: z.literal("workItems:request"), id: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  method: z.enum(["list", "open"]), input: z.unknown() }).strict()
const listSchema = z.object({ kind, query: z.string().max(200), page: z.number().int().min(1).max(50), fresh: z.boolean() }).strict()
const openSchema = z.object({ kind, number: z.number().int().min(1).max(999_999_999) }).strict()
const OPEN_INTERVAL_MS = 1_000

/**
 * Fixed `repository.workItems.read` capability, not an RPC proxy: the host owns
 * the project and extension authority; the addon chooses kind, query, page or
 * an item to open. Opening goes through the host's external-link opener, at
 * most once a second, to the forge page the server builds for that number.
 */
export function useWorkItemsChannel(props: { instanceId: string; id: string; digest: string; send: (value: unknown) => void }) {
  const pending = new Set<AbortController>()
  let disposed = false, connected = true, lastOpen = 0
  const abort = () => { for (const request of pending) request.abort() }
  onCleanup(serverEvents.onTransportStatus(status => {
    connected = status === "connected"
    if (!connected) abort()
  }))
  onCleanup(() => { disposed = true; abort(); pending.clear() })
  return async (value: unknown) => {
    const parsed = requestSchema.safeParse(value)
    if (!parsed.success || disposed) return
    const { id, method, input } = parsed.data
    const controller = new AbortController()
    try {
      if (!connected || pending.size >= 4) throw new Error("Unavailable")
      pending.add(controller)
      const args = [props.instanceId, props.id, props.digest] as const
      let result: unknown
      if (method === "list") {
        result = await panelExtensionsApi.workItems(...args, listSchema.parse(input), controller.signal)
      } else {
        const request = openSchema.parse(input)
        if (Date.now() - lastOpen < OPEN_INTERVAL_MS) throw new Error("Too frequent")
        lastOpen = Date.now()
        const { url } = await panelExtensionsApi.workItemUrl(...args, request.kind, request.number, controller.signal)
        if (new URL(url).protocol !== "https:" || controller.signal.aborted) throw new Error("Unavailable")
        result = { opened: await openExternalUrl(url, "panel-extension") }
      }
      if (!disposed && connected && !controller.signal.aborted) props.send({ type: "workItems:result", id, result })
    } catch {
      if (!disposed) props.send({ type: "workItems:result", id, error: true })
    } finally { pending.delete(controller) }
  }
}
