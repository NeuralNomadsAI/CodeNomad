import { z } from "zod"
import { SupervisionError, supervisionStatus, type SupervisionObservation, type SupervisionStatus, type SupervisionTarget } from "./service-supervision-contract"
import type { ServiceSupervisionStore } from "./service-supervision-store"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { createHash, randomUUID } from "node:crypto"

export const supervisionSettingsControlSchema = z.object({
  serviceKey: z.string().regex(/^[a-f0-9]{64}$/), requestID: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  action: z.enum(["on", "off", "retry"]),
}).strict()
export type SupervisionSettingsControl = z.infer<typeof supervisionSettingsControlSchema>
export type SupervisionSettingsResponse = SupervisionStatus & {
  serviceKey: string
  request?: { requestID: string; state: "recorded" | "unknown"; action?: "on" | "off" | "first-play" | "retry" | "select-binary"; appliedRevision?: number }
}
export interface AcquiredSupervision {
  /** Acquired from the authorized Settings execution host, never from UI paths,
   * a workspace inventory or the currently selected conversation. */
  store: ServiceSupervisionStore
  adapter: { observe(): Promise<SupervisionObservation>; reconcile(revision: number): Promise<void> }
  assertCurrent(): void
  selectedTarget?: SupervisionTarget
}

/** The resolver owns exact native namespace, executable and durable runtime
 * provisioning. This service owns intent/OS-effect sequencing and safe readout. */
export class ServiceSupervisionSettings {
  constructor(private readonly acquire: (connection?: ServiceConnection) => Promise<AcquiredSupervision>,
    private readonly acquireSelection = () => acquire()) {}

  /** Internal explicit selection/verified-install/restart seam shared by desktop
   * hosts. Passive acquisition never replaces another profile's chosen target. */
  async selectBinary(assertCurrent: () => void = () => {}): Promise<void> {
    let scope: AcquiredSupervision
    try { scope = await this.acquireSelection() }
    catch (error) { if (error instanceof SupervisionError && error.code === "unknown-request") return; throw error }
    const before = await scope.store.read()
    const target = scope.selectedTarget
    const check = () => { assertCurrent(); scope.assertCurrent() }
    check()
    if (!target) return
    const same = JSON.stringify(before.target) === JSON.stringify(target)
    if (same && (before.reconciledRevision === before.revision || before.receipt?.control.action !== "select-binary")) return
    const next = same ? before : await scope.store.control({ action: "select-binary", target, expectedRevision: before.revision,
      requestID: randomUUID() }, check)
    check()
    if (next.desired === "unset") await scope.store.acknowledge(next.revision)
    else await this.reconcile(scope, next.revision, check)
    check()
    if ((await scope.store.read()).reconciledRevision !== next.revision) throw new SupervisionError("busy")
  }

  /** Product Play pins the already authorized connection. The resolver must prove
   * that its Settings namespace is this service before changing the preference. */
  async missionPlay(connection: ServiceConnection, requestID: string, authorize: () => void): Promise<SupervisionSettingsResponse> {
    authorize(); connection.assertCurrent()
    const scope = await this.acquire(connection), manifest = await scope.store.read()
    const hex = createHash("sha256").update(`${manifest.key}\0${requestID}`).digest("hex")
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    return new ServiceSupervisionSettings(async () => scope).firstPlay({ serviceKey: manifest.key, requestID: id }, () => {
      authorize(); connection.assertCurrent()
    })
  }

  async read(input: { serviceKey?: string; requestID?: string } = {}): Promise<SupervisionSettingsResponse> {
    const scope = await this.acquire()
    return this.snapshot(scope, input)
  }

  async control(raw: SupervisionSettingsControl, authorize: () => void): Promise<SupervisionSettingsResponse> {
    const parsed = supervisionSettingsControlSchema.safeParse(raw)
    if (!parsed.success) throw new SupervisionError("invalid")
    authorize()
    const scope = await this.acquire(), input = parsed.data
    const check = () => { authorize(); scope.assertCurrent() }
    await this.checkKey(scope, input.serviceKey)
    check()
    const manifest = await scope.store.control({ action: input.action, requestID: input.requestID,
      expectedRevision: input.expectedRevision }, check)
    check()
    // Repeating an acknowledged request observes the installation. Only explicit
    // Retry repairs it at the same revision. Deferred Linux linger rollback is
    // reconciled separately by the adapter's status/startup acquisition.
    if (manifest.desired !== "unset" && (input.action === "retry" || manifest.reconciledRevision !== manifest.revision))
      await this.reconcile(scope, manifest.revision, check)
    check()
    return this.snapshot(scope, input)
  }

  /** Internal first-Play seam. Call only after human Play admission on this exact
   * acquired service; creating/reading a Mission never calls it. Explicit OFF wins. */
  async firstPlay(input: { serviceKey: string; requestID: string }, authorize: () => void): Promise<SupervisionSettingsResponse> {
    if (!z.object({ serviceKey: z.string().regex(/^[a-f0-9]{64}$/), requestID: z.string().uuid() }).strict().safeParse(input).success)
      throw new SupervisionError("invalid")
    authorize()
    const scope = await this.acquire()
    const check = () => { authorize(); scope.assertCurrent() }
    const before = await this.checkKey(scope, input.serviceKey)
    check()
    if (before.desired !== "unset") return this.snapshot(scope, input)
    const manifest = await scope.store.control({ action: "first-play", requestID: input.requestID,
      expectedRevision: before.revision }, check)
    check()
    if (manifest.desired === "on" && manifest.reconciledRevision !== manifest.revision)
      await this.reconcile(scope, manifest.revision, check)
    check()
    return this.snapshot(scope, input)
  }

  private async reconcile(scope: AcquiredSupervision, revision: number, check: () => void): Promise<void> {
    check()
    await scope.store.recordAttempt(revision, null)
    check()
    try { await scope.adapter.reconcile(revision) }
    catch {
      // A competing OFF may have won during the native operation. Its intent and
      // diagnostics must survive; never write this older failure over it.
      try { await scope.store.recordAttempt(revision, "adapter-failed") }
      catch (error) { if (!(error instanceof SupervisionError) || error.code !== "conflict") throw error }
    }
  }

  private async checkKey(scope: AcquiredSupervision, serviceKey?: string) {
    scope.assertCurrent()
    const manifest = await scope.store.read()
    scope.assertCurrent()
    if (serviceKey !== undefined && manifest.key !== serviceKey) throw new SupervisionError("conflict")
    return manifest
  }

  private async snapshot(scope: AcquiredSupervision, input: { serviceKey?: string; requestID?: string }): Promise<SupervisionSettingsResponse> {
    const before = await this.checkKey(scope, input.serviceKey)
    const observation = await scope.adapter.observe().catch((): SupervisionObservation => ({ revision: before.revision,
      resources: "unknown", guard: "unknown", health: { state: "unknown" } }))
    const manifest = await this.checkKey(scope, before.key)
    // A concurrent preference change is returned with stale observation rather
    // than being labelled protected using another revision's healthy service.
    const request = input.requestID ? manifest.receipt?.control.requestID === input.requestID
      ? { requestID: input.requestID, state: "recorded" as const, action: manifest.receipt.control.action,
        appliedRevision: manifest.receipt.appliedRevision }
      : { requestID: input.requestID, state: "unknown" as const } : undefined
    return { serviceKey: manifest.key, ...supervisionStatus(manifest, observation), ...(request ? { request } : {}) }
  }
}
