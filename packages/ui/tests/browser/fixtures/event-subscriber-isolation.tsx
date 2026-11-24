import { createMemo, createRoot, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { serverEvents } from "../../../src/lib/server-events"
import { sseManager } from "../../../src/lib/sse-manager"
import { getLogger } from "../../../src/lib/logger"

const mode = new URLSearchParams(location.search).get("mode")
const native: string[] = [], typed: string[] = [], statuses: string[] = [], errors: unknown[][] = []
let faults = 0, opens = 0
const [version, setVersion] = createSignal(0)
const changed = () => setVersion(value => value + 1)
const fail = () => { faults++; changed(); throw new Error("synthetic subscriber failure") }
// Replace diagnostics only; dispatch, transport, native reducer entry and the
// browser's EventSource are production implementations.
getLogger("sse").error = (...args) => { errors.push(args) }
if (mode === "event") serverEvents.on("*", event => { if (event.type === "instance.event") fail() })
if (mode === "derived") createRoot(() => {
  const [broken, setBroken] = createSignal(false)
  createMemo(() => { if (broken()) throw new Error("synthetic deferred derivation failure") })
  serverEvents.on("*", event => {
    if (event.type !== "instance.event") return
    faults++
    changed()
    setBroken(true)
  })
})
if (mode === "open") serverEvents.onOpen(fail)
if (mode === "status") serverEvents.onTransportStatus(status => { if (status === "disconnected") fail() })
sseManager.onNativeSessionEvent = (_id, event) => { native.push(event.id); changed() }
const unsubscribe = serverEvents.on("instance.event", event => {
  if (event.type === "instance.event") typed.push(event.event.id)
  changed()
})
serverEvents.onOpen(() => { opens++; changed() })
serverEvents.onTransportStatus(status => { statuses.push(status); changed() })
;(window as any).fixture = {
  snapshot: () => ({ native, typed, statuses, faults, opens, errors }),
  restart: () => {
    try { serverEvents.restart("isolated subscriber fixture"); return null }
    catch (error) { return error instanceof Error ? error.message : String(error) }
  },
  unsubscribe,
}
render(() => <pre data-events>{version()}{JSON.stringify({ native, typed, statuses, faults, opens })}</pre>, document.getElementById("root")!)
