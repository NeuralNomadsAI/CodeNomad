import { randomBytes } from "node:crypto"
import type { FastifyRequest } from "fastify"
import type { AuthManager } from "../auth/manager"
import type { EventBus } from "../events/bus"
import type { WorkspaceEventPayload } from "../api-types"
import type { WorkspaceManager } from "../workspaces/manager"
import { readLocationRef, sameLocation } from "../opencode/compatibility/location"
import type { PanelExtensionStore } from "./store"
import type { BundlesActions, BundlesAction, BundlesHostContext } from "./bundles-actions"
import { BundlesLifecycle, BundlesStalePlanError, type BundlesMount, type BundlesAck, type BundlesConfirmation } from "./bundles-lifecycle"
import type { BundlesChange, BundlesMountInput, BundlesManageInput, BundlesControlInput } from "./bundles-contract"

export type BundlesPrivateEvent = { mountID: string; view: BundlesConfirmation | null } | { mountID: string; change: BundlesChange }
export interface BundlesTransportDeps {
  auth: Pick<AuthManager, "getSessionFromRequest">
  store: Pick<PanelExtensionStore, "captureMutationAuthority">
  workspaceManager: Pick<WorkspaceManager, "getSharedServiceConnection" | "ownsLocation">
  actions: Pick<BundlesActions, "prepare" | "accepts">
  eventBus: Pick<EventBus, "onEvent">
  lifecycle?: BundlesLifecycle
  readTimeoutMs?: number
}
interface Owner {
  stream: object; request: FastifyRequest; principal: string; controller: AbortController
  write(payload: string): void; close(): void; mounts: Set<Mounted>; slots: number
}
interface Mounted {
  owner: Owner; context: BundlesHostContext; mount: BundlesMount; dispose(): void
  pending?: { requestID: string; afterAck(): void }
}
const opaque = () => randomBytes(32).toString("hex")
function refused(): never { throw new Error("Bundles request unavailable") }

/** Race cancellation even when a dependency ignores its signal; late continuations retain their fences. */
function bounded<T>(signal: AbortSignal, run: () => Promise<T>): Promise<T> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return run() }).then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
  })
}

/** One backend owner registry. Capabilities name actual authenticated SSE stream objects, never client IDs. */
export class BundlesTransport {
  readonly lifecycle: BundlesLifecycle
  private readonly owners = new Map<string, Owner>()
  private readonly streams = new WeakMap<object, Owner>()
  private readonly mounts = new Map<string, Mounted>()
  private readonly targets = new Map<AbortController, { instance: string; session: string }>()
  private slots = 0
  private readonly unsubscribe: () => void
  constructor(private readonly deps: BundlesTransportDeps) {
    this.lifecycle = deps.lifecycle ?? new BundlesLifecycle()
    this.unsubscribe = deps.eventBus.onEvent(event => this.invalidate(event))
  }

  /** Called only by /api/events, using its actual reply stream and its backpressure-aware write. */
  openStream(request: FastifyRequest, stream: object, write: (payload: string) => void): () => void {
    const principal = this.principal(request)
    if (!principal || this.owners.size >= 128 || this.streams.has(stream)) return () => {}
    const capability = opaque()
    const owner: Owner = { stream, request, principal, controller: new AbortController(), write, mounts: new Set(), slots: 0,
      close: () => {
        if (this.owners.get(capability) !== owner) return
        this.owners.delete(capability)
        if (this.streams.get(stream) === owner) this.streams.delete(stream)
        owner.controller.abort()
        for (const mounted of [...owner.mounts]) mounted.dispose()
      } }
    this.owners.set(capability, owner); this.streams.set(stream, owner)
    try { write(`event: codenomad.bundles.owner\ndata: ${JSON.stringify({ owner: capability })}\n\n`) }
    catch { owner.close() }
    return owner.close
  }

  private principal(request: FastifyRequest): string | undefined {
    const session = this.deps.auth.getSessionFromRequest(request)
    return session && session.sessionId && session.sessionId !== "auth-disabled" ? session.sessionId : undefined
  }
  private assertOwner(owner: Owner): void {
    owner.controller.signal.throwIfAborted()
    if (this.streams.get(owner.stream) !== owner || this.principal(owner.request) !== owner.principal) {
      owner.close(); refused()
    }
  }
  private owner(request: FastifyRequest, capability: string): Owner {
    const owner = this.owners.get(capability)
    if (!owner) refused()
    this.assertOwner(owner)
    if (this.principal(request) !== owner.principal) refused()
    return owner
  }
  private ownedMount(request: FastifyRequest, extension: string, input: { owner: string; mountID: string }, checked = false): Mounted {
    const owner = this.owner(request, input.owner), mounted = this.mounts.get(input.mountID)
    if (!mounted || mounted.owner !== owner || mounted.mount.extension !== extension) {
      if (checked) throw new BundlesStalePlanError()
      refused()
    }
    return mounted
  }
  private assertMounted(mounted: Mounted): void {
    mounted.mount.signal.throwIfAborted(); mounted.context.authority.assertCurrent()
  }

  async mount(request: FastifyRequest, extension: string, input: BundlesMountInput, signal: AbortSignal): Promise<{ mountID: string }> {
    const owner = this.owner(request, input.owner)
    if (owner.slots >= 8 || this.slots >= 256) refused()
    owner.slots++; this.slots++
    const controller = new AbortController()
    this.targets.set(controller, { instance: input.instanceId, session: input.sessionID })
    const liveSignal = AbortSignal.any([controller.signal, owner.controller.signal])
    const admissionSignal = AbortSignal.any([liveSignal, signal, AbortSignal.timeout(this.deps.readTimeoutMs ?? 8000)])
    let lease: Awaited<ReturnType<PanelExtensionStore["captureMutationAuthority"]>> | undefined
    let admitted = false
    const assertLive = () => { liveSignal.throwIfAborted(); this.assertOwner(owner); lease?.assertCurrent() }
    try {
      await bounded(admissionSignal, async () => {
        lease = await this.deps.store.captureMutationAuthority(extension, input.digest)
        if (admissionSignal.aborted) { lease.dispose(); admissionSignal.throwIfAborted() }
      })
      assertLive()
      const connection = await bounded(admissionSignal, () => this.deps.workspaceManager.getSharedServiceConnection(input.instanceId))
      assertLive(); admissionSignal.throwIfAborted()
      if (!connection) refused()
      connection.assertCurrent()
      const session = await bounded(admissionSignal, () => connection.client.session.get({ sessionID: input.sessionID }, { signal: admissionSignal }))
      assertLive(); connection.assertCurrent(); admissionSignal.throwIfAborted()
      if (session.id !== input.sessionID) refused()
      const location = Object.freeze(readLocationRef(session.location))
      if (location.workspaceID !== undefined) refused()
      const authority = {
        signal: AbortSignal.any([liveSignal, lease!.signal]),
        assertCurrent: () => { assertLive(); connection.assertCurrent() },
        revalidate: async () => {
          const checkSignal = AbortSignal.any([authority.signal, AbortSignal.timeout(this.deps.readTimeoutMs ?? 8000)])
          const check = () => { checkSignal.throwIfAborted(); authority.assertCurrent() }
          try { await bounded(checkSignal, async () => {
            check(); await lease!.revalidate(); check()
            const current = await this.deps.workspaceManager.getSharedServiceConnection(input.instanceId); check()
            if (current !== connection) refused()
            const fresh = await connection.client.session.get({ sessionID: input.sessionID }, { signal: checkSignal }); check()
            if (fresh.id !== input.sessionID || !sameLocation(readLocationRef(fresh.location), location)) refused()
            const owned = await this.deps.workspaceManager.ownsLocation(input.instanceId, location, connection.client, checkSignal); check()
            if (!owned) refused()
            await lease!.revalidate(); check()
          }) } catch (error) { controller.abort(); throw error }
        },
      }
      await bounded(admissionSignal, () => authority.revalidate())
      authority.assertCurrent(); admissionSignal.throwIfAborted()
      const emit = (event: BundlesPrivateEvent) => {
        if (owner.controller.signal.aborted) return
        try { this.assertOwner(owner); owner.write(`event: codenomad.bundles.event\ndata: ${JSON.stringify(event)}\n\n`) } catch { owner.close() }
      }
      const mount = this.lifecycle.mount({ extension, digest: input.digest, authority, signal: liveSignal,
        show: view => { emit({ mountID: mount.mountID, view }) }, changed: change => {
          mounted.pending = undefined; emit({ mountID: mount.mountID, change })
        } })
      const mounted: Mounted = { owner, mount, context: { instanceId: input.instanceId, sessionID: input.sessionID, location, connection, authority },
        dispose: () => {
          if (!this.mounts.delete(mount.mountID)) return
          this.targets.delete(controller)
          owner.mounts.delete(mounted); owner.slots--; this.slots--
          // Finish the lifecycle while the original SSE lane is still usable, then discard its identity.
          controller.abort(); lease!.dispose(); mounted.pending = undefined
        } }
      this.mounts.set(mount.mountID, mounted); owner.mounts.add(mounted)
      mount.signal.addEventListener("abort", mounted.dispose, { once: true })
      admitted = true
      return { mountID: mount.mountID }
    } finally {
      if (!admitted) { this.targets.delete(controller); controller.abort(); lease?.dispose(); owner.slots--; this.slots-- }
    }
  }

  async manage(request: FastifyRequest, extension: string, input: BundlesManageInput, signal: AbortSignal = AbortSignal.timeout(19_000)): Promise<BundlesAck> {
    const mounted = this.ownedMount(request, extension, input)
    try { this.assertMounted(mounted); signal.throwIfAborted() }
    catch (error) { this.lifecycle.budget.take(extension, "manage"); throw error }
    // Removal needs integration-owned enumeration; direct detach needs a proven specific user click.
    if (input.method === "detach" || input.method === "request" && input.input.action === "remove") {
      return { outcome: this.lifecycle.budget.take(extension, "manage") ? "invalid" : "busy" }
    }
    let action: BundlesAction
    switch (input.method) {
      case "request": {
        if (input.input.action === "remove") return { outcome: "invalid" }
        action = { ...input.input, action: input.input.action }; break
      }
      case "setActive": action = { action: "setActive", integration: input.input.integration, scope: input.input.scope, active: input.input.enabled }; break
      case "installHost": action = { action: "installHost", ...input.input }; break
      case "attach": action = { action: "attach", ...input.input }; break
    }
    if (!this.deps.actions.accepts(action)) {
      return { outcome: this.lifecycle.budget.take(extension, "manage") ? "invalid" : "busy" }
    }
    const result = this.lifecycle.request(mounted.mount, signal => {
      const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), 19_000)
      const preparation = AbortSignal.any([signal, mounted.mount.signal, deadline.signal])
      // Only preparation has this deadline; a prepared plan keeps its separate human-wait lifetime.
      return bounded(preparation, () => this.deps.actions.prepare(mounted.context, action, preparation)).finally(() => clearTimeout(timer))
    })
    if (result.ack.outcome === "confirming") mounted.pending = { requestID: result.ack.requestID, afterAck: result.afterAck }
    return result.ack
  }

  async control(request: FastifyRequest, extension: string, input: BundlesControlInput, signal: AbortSignal = AbortSignal.timeout(19_000)): Promise<{ ok: true }> {
    const mounted = this.ownedMount(request, extension, input, input.command === "confirm")
    signal.throwIfAborted()
    // Disposal removes authority; navigation must remain able to do it after native/consent staleness.
    if (input.command === "dispose") { mounted.dispose(); return { ok: true } }
    if (input.command === "confirm") {
      await this.lifecycle.confirmChecked(mounted.mount, input.planID, signal)
      return { ok: true }
    }
    this.assertMounted(mounted)
    switch (input.command) {
      case "start": {
        if (mounted.pending?.requestID !== input.requestID) refused()
        const pending = mounted.pending; mounted.pending = undefined; pending.afterAck(); break
      }
      case "displayed": this.lifecycle.displayed(mounted.mount, input.planID); break
      case "cancel": this.lifecycle.cancel(mounted.mount, input.planID); break
      case "userRemount": this.lifecycle.resetCutoffForUserRemount(extension); mounted.dispose(); break
    }
    return { ok: true }
  }

  private invalidate(event: WorkspaceEventPayload): void {
    for (const [controller, target] of this.targets) {
      const instance = target.instance
      if (event.type === "workspace.stopped" && event.workspaceId === instance
        || event.type === "instance.eventStatus" && event.instanceId === instance) controller.abort()
      if (event.type === "instance.event" && event.instanceId === instance
        && (event.event.type === "server.connected" || (event.event.type === "session.moved" || event.event.type === "session.deleted")
          && event.event.data.sessionID === target.session)) controller.abort()
    }
  }

  dispose(): void {
    this.unsubscribe()
    for (const owner of [...this.owners.values()]) owner.close()
    for (const mounted of [...this.mounts.values()]) mounted.dispose()
    this.lifecycle.dispose()
  }
}
