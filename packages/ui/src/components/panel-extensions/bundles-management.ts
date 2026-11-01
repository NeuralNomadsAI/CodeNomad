import { bundlesManageInputSchema, type BundlesControlInput } from "../../../../server/src/panel-extensions/bundles-contract"
import { bundlesPrivateEvents, type BundlesConfirmation } from "../../lib/bundles-private-events"
import { PanelExtensionHttpError, panelExtensionsApi4 } from "../../lib/panel-extensions-api"

type Command = BundlesControlInput extends infer T ? T extends BundlesControlInput ? Omit<T, "owner" | "mountID"> : never : never
const inputs = new Map(bundlesManageInputSchema.options.map(option => [option.shape.method.value, option.shape.input]))
export function createBundlesManagement(props: { id: string; instanceId: string; digest: string; sessionID: string | null
  current(): boolean; send(value: unknown): void; show(view: BundlesConfirmation | undefined): void }) {
  const lifetime = new AbortController()
  let captured: { owner: string; mountID: string } | undefined, closed = false, release: (() => void) | undefined, releaseOwner: (() => void) | undefined
  let opening: Promise<void> | undefined, shown: BundlesConfirmation | undefined
  const show = (view: BundlesConfirmation | undefined) => {
    const previous = shown; shown = view; props.show(view)
    if (previous && previous.requestID !== view?.requestID) {
      // One task after Kobalte has removed its trap and restored the parent iframe.
      setTimeout(() => { if (props.current()) props.send({ type: "bundles:focus", requestID: previous.requestID }) }, 0)
    }
  }
  const control = async (command: Command) => {
    if (!captured || closed) throw new Error("Bundles unavailable")
    await panelExtensionsApi4.bundlesControl(props.id, { ...captured, ...command }, AbortSignal.timeout(19_000))
  }
  const dispose = () => {
    if (closed) return
    const old = captured
    closed = true; captured = undefined; lifetime.abort(); release?.(); releaseOwner?.(); show(undefined)
    if (old) void panelExtensionsApi4.bundlesControl(props.id, { ...old, command: "dispose" }, AbortSignal.timeout(19_000)).catch(() => {})
  }
  const mount = () => opening ??= (async () => {
    if (!props.sessionID || closed || !props.current()) throw new Error("Bundles unavailable")
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(19_000)])
    const owner = await bundlesPrivateEvents.capture(signal)
    owner.signal.addEventListener("abort", dispose, { once: true })
    releaseOwner = () => owner.signal.removeEventListener("abort", dispose)
    const result = await panelExtensionsApi4.bundlesMount(props.id, { owner: owner.value, instanceId: props.instanceId,
      digest: props.digest, sessionID: props.sessionID }, signal)
    const value = { owner: owner.value, mountID: result.mountID }
    if (closed || owner.signal.aborted || !props.current()) {
      void panelExtensionsApi4.bundlesControl(props.id, { ...value, command: "dispose" }, AbortSignal.timeout(19_000)).catch(() => {})
      throw new Error("Bundles unavailable")
    }
    captured = value
    release = bundlesPrivateEvents.subscribe(result.mountID, event => {
      if (closed || !props.current()) { dispose(); return }
      if ("view" in event) show(event.view ?? undefined)
      else props.send({ type: "bundles:changed", ...event.change })
    })
  })().catch(error => { dispose(); throw error })
  return {
    mount, dispose,
    async manage(method: string, input: unknown, signal: AbortSignal) {
      // Admission never waits for acquisition and never queues an author action.
      const schema = inputs.get(method as Parameters<typeof inputs.get>[0])
      if (!schema) throw new Error("Bundles unavailable")
      schema.parse(input)
      signal.throwIfAborted()
      if (closed || !props.current()) throw new Error("Bundles unavailable")
      if (!captured) { void mount().catch(() => {}); return { result: { outcome: "busy" as const } } }
      const result = await panelExtensionsApi4.bundlesManage(props.id,
        bundlesManageInputSchema.parse({ ...captured, method, input }), signal)
      return { result, ...(result.outcome === "confirming" ? { after: () => {
        void control({ command: "start", requestID: result.requestID }).catch(dispose)
      } } : {}) }
    },
    displayed: (planID: string) => control({ command: "displayed", planID }),
    confirm: (planID: string) => { void control({ command: "confirm", planID }).catch(error => {
      // Stale admission has its own terminal event, possibly still behind SSE backpressure.
      if (!(error instanceof PanelExtensionHttpError && error.status === 409)) dispose()
    }) },
    cancel: (planID: string) => { void control({ command: "cancel", planID }).catch(dispose) },
    async userRemount(available: () => boolean) {
      // Only the trusted toolbar calls this. Disposed mounts cannot reset a cutoff:
      // reacquire the current stream's owner and a fresh, fully authorized mount.
      dispose()
      if (!props.sessionID || !available()) throw new Error("Bundles unavailable")
      const signal = AbortSignal.timeout(19_000), owner = await bundlesPrivateEvents.capture(signal)
      if (!available()) throw new Error("Bundles unavailable")
      const { mountID } = await panelExtensionsApi4.bundlesMount(props.id, { owner: owner.value,
        instanceId: props.instanceId, digest: props.digest, sessionID: props.sessionID }, signal)
      const fresh = { owner: owner.value, mountID }
      let reset = false
      try {
        owner.signal.throwIfAborted()
        if (!available()) throw new Error("Bundles unavailable")
        await panelExtensionsApi4.bundlesControl(props.id, { ...fresh, command: "userRemount" }, signal)
        reset = true
      } finally {
        if (!reset) void panelExtensionsApi4.bundlesControl(props.id, { ...fresh, command: "dispose" }, AbortSignal.timeout(19_000)).catch(() => {})
      }
    },
  }
}
export type BundlesManagement = ReturnType<typeof createBundlesManagement>
