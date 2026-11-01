import { z } from "zod"
import { bundlesChangeSchema } from "../../../server/src/panel-extensions/bundles-contract"
import type { BundlesConfirmation } from "../../../server/src/panel-extensions/bundles-lifecycle"

const capability = z.string().regex(/^[a-f0-9]{32,64}$/)
// Native display bounds count Unicode code points, including astral characters.
const display = (max: number, min = 0) => z.string().refine(value => {
  const length = [...value].length
  return length >= min && length <= max
})
const view = z.object({ requestID: capability, planID: capability,
  action: z.enum(["install", "update", "remove", "enable", "disable", "installHost", "attach"]),
  integration: display(120, 1), scope: z.enum(["global", "project"]), version: display(120),
  conversation: display(256), document: display(243).optional() }).strict()
const event = z.union([z.object({ mountID: capability, view: view.nullable() }).strict(),
  z.object({ mountID: capability, change: bundlesChangeSchema }).strict()])
export type BundlesPrivateEvent = z.infer<typeof event>
type Owner = { value: string; signal: AbortSignal }
let owner: Owner | undefined, controller = new AbortController(), streamGeneration = 0
const owners = new Set<() => void>(), listeners = new Map<string, (event: BundlesPrivateEvent) => void>()

/** Parent memory only. Never publish these events through the application event bus. */
export const bundlesPrivateEvents = {
  stream() {
    const generation = ++streamGeneration
    bundlesPrivateEvents.reset()
    return {
      onPrivateOwner: (value: unknown) => { if (generation === streamGeneration) bundlesPrivateEvents.owner(value) },
      onPrivateEvent: (value: unknown) => { if (generation === streamGeneration) bundlesPrivateEvents.event(value) },
      onReset: () => { if (generation === streamGeneration) bundlesPrivateEvents.reset() },
    }
  },
  reset() {
    owner = undefined
    controller.abort(); controller = new AbortController()
    listeners.clear()
  },
  owner(value: unknown) {
    const parsed = z.object({ owner: capability }).strict().safeParse(value)
    if (!parsed.success) return
    bundlesPrivateEvents.reset()
    owner = { value: parsed.data.owner, signal: controller.signal }
    for (const notify of owners) notify()
  },
  event(value: unknown) {
    const parsed = event.safeParse(value)
    if (owner && parsed.success) listeners.get(parsed.data.mountID)?.(parsed.data)
  },
  async capture(signal: AbortSignal): Promise<Owner> {
    signal.throwIfAborted()
    if (owner) return owner
    return new Promise((resolve, reject) => {
      const cleanup = () => { owners.delete(available); signal.removeEventListener("abort", abort) }
      const available = () => { if (owner) { cleanup(); resolve(owner) } }
      const abort = () => { cleanup(); reject(new Error("Bundles unavailable")) }
      owners.add(available); signal.addEventListener("abort", abort, { once: true })
    })
  },
  subscribe(mountID: string, receive: (event: BundlesPrivateEvent) => void) {
    listeners.set(mountID, receive)
    return () => { if (listeners.get(mountID) === receive) listeners.delete(mountID) }
  },
}
export type { BundlesConfirmation }
