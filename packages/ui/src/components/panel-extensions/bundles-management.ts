import { createSignal } from "solid-js"
import { bundlesManageInputSchema, type BundlesCatalogResult, type BundlesControlInput, type BundlesStateResult } from "../../../../server/src/panel-extensions/bundles-contract"
import { bundlesPrivateEvents, type BundlesConfirmation } from "../../lib/bundles-private-events"
import { PanelExtensionHttpError, panelExtensionsApi4 } from "../../lib/panel-extensions-api"
import { pluginSourcesStore } from "../../stores/plugin-sources"
import { openBundlesDocs } from "./bundles-docs-opener"

type Control = Exclude<BundlesControlInput, { command: "detach" }>
type Command = Control extends infer T ? T extends Control ? Omit<T, "owner" | "mountID"> : never : never
/** One trusted host-banner row per authoritatively attached native integration. */
export interface BundlesHostControl { integration: string; name: string; label: string; phase: "attached" | "detaching" | "unknown" }
export type BundlesHostNotice = { key: "integrations.host.detaching" | "integrations.binding.unknown" | "integrations.host.detached"; label: string }
const inputs = new Map(bundlesManageInputSchema.options.map(option => [option.shape.method.value, option.shape.input]))
export function createBundlesManagement(props: { id: string; instanceId: string; digest: string; sessionID: string | null
  current(): boolean; send(value: unknown): void; show(view: BundlesConfirmation | undefined): void }) {
  const lifetime = new AbortController()
  const [hostControls, setHostControls] = createSignal<readonly BundlesHostControl[]>([])
  const [hostNotice, setHostNotice] = createSignal<BundlesHostNotice>()
  const names = new Map<string, string>()
  // Reads that started before a detach began or ended cannot overwrite its result.
  let epoch = 0
  const find = (integration: string) => hostControls().find(control => control.integration === integration)
  const put = (integration: string, next?: BundlesHostControl) => setHostControls(list => next
    ? list.some(control => control.integration === integration) ? list.map(control => control.integration === integration ? next : control) : [...list, next]
    : list.filter(control => control.integration !== integration))
  const observeState = (token: number, state: BundlesStateResult, own = false) => {
    if (closed || token !== epoch) return
    const present = new Set<string>()
    for (const item of state.integrations) {
      if (item.family !== "native") continue
      present.add(item.id)
      const current = find(item.id)
      if (current?.phase === "detaching" && !own) continue
      if (item.attachment.state === "attached") {
        put(item.id, { integration: item.id, name: names.get(item.id) ?? item.id, label: item.attachment.label, phase: "attached" })
      } else if (item.attachment.state === "none") {
        put(item.id)
        if (current && current.phase !== "attached") setHostNotice({ key: "integrations.host.detached", label: current.label })
      } else if (current) {
        put(item.id, { ...current, phase: "unknown" }); setHostNotice({ key: "integrations.binding.unknown", label: current.label })
      }
    }
    for (const control of hostControls()) if (!present.has(control.integration)) put(control.integration)
  }
  const reread = async () => {
    const token = epoch
    try {
      if (!props.sessionID || closed || !props.current()) throw new Error("Bundles unavailable")
      const state = await panelExtensionsApi4.bundlesState({ instanceId: props.instanceId, id: props.id, digest: props.digest }, props.sessionID,
        AbortSignal.any([lifetime.signal, AbortSignal.timeout(19_000)]))
      if (props.current()) observeState(token, state, true)
    } catch {
      for (const control of hostControls()) if (control.phase === "detaching") put(control.integration, { ...control, phase: "unknown" })
    }
  }
  const trackingOwner = {}
  const attempts = new Map<string, ReturnType<typeof pluginSourcesStore.begin>>()
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
    closed = true; captured = undefined; lifetime.abort(); release?.(); releaseOwner?.(); show(undefined); setHostControls([])
    pluginSourcesStore.clearOwner(trackingOwner); attempts.clear()
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
      else {
        if (event.change.kind === "request") {
          const attempt = attempts.get(event.change.requestID)
          if (attempt) {
            if (event.change.outcome === "confirmed") pluginSourcesStore.submitted(attempt)
            else pluginSourcesStore.consume(attempt)
            attempts.delete(event.change.requestID)
          }
        }
        props.send({ type: "bundles:changed", ...event.change })
      }
    })
  })().catch(error => { dispose(); throw error })
  return {
    mount, dispose, hostControls, hostNotice,
    readToken: () => epoch,
    observeState: (token: number, state: BundlesStateResult) => observeState(token, state),
    observeCatalog(catalog: BundlesCatalogResult) {
      for (const entry of catalog.integrations) names.set(entry.id, entry.displayName)
      setHostControls(list => list.map(control => ({ ...control, name: names.get(control.integration) ?? control.name })))
    },
    /** Only the trusted banner button calls this: one click, one transmission, never replayed. */
    async detach(integration: string) {
      const current = find(integration), envelope = captured
      if (!envelope || closed || !props.current() || current?.phase !== "attached") return
      epoch++
      put(integration, { ...current, phase: "detaching" }); setHostNotice({ key: "integrations.host.detaching", label: current.label })
      let outcome: "detached" | "none" | "unknown" | "busy"
      try {
        outcome = (await panelExtensionsApi4.bundlesDetach(props.id, { ...envelope, command: "detach", integration },
          AbortSignal.timeout(19_000))).outcome
      } catch { outcome = "unknown" }
      if (closed || captured !== envelope) return
      epoch++
      const latest = find(integration)
      if (outcome === "busy") { if (latest) put(integration, { ...latest, phase: "attached" }); return }
      if (outcome === "unknown" && latest) {
        put(integration, { ...latest, phase: "unknown" }); setHostNotice({ key: "integrations.binding.unknown", label: latest.label })
      }
      // Success follows the authoritative re-read only.
      if (props.current()) props.send({ type: "bundles:changed", kind: "state" })
      await reread()
    },
    async openDocs(integration: string, signal: AbortSignal) {
      if (closed || signal.aborted || !props.current()) return { outcome: "unavailable" as const }
      if (!captured) { void mount().catch(() => {}); return { outcome: "busy" as const } }
      const envelope = captured
      return openBundlesDocs(integration, () => panelExtensionsApi4.bundlesOpenDocs(props.id, { ...envelope, integration },
        AbortSignal.any([signal, lifetime.signal])), () => !closed && !signal.aborted && captured === envelope && props.current())
    },
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
    confirm: (planID: string) => {
      const view = shown
      if (closed || !props.current() || view?.planID !== planID) return
      if (view.action === "install" && view.installation && !attempts.has(view.requestID)) {
        const target = view.installation
        attempts.set(view.requestID, pluginSourcesStore.begin(props.instanceId, { directory: target.directory }, target.scope, target.target,
          { integration: target.integration, runtimeID: target.runtimeID, owner: trackingOwner }))
      }
      void control({ command: "confirm", planID }).catch(error => {
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
