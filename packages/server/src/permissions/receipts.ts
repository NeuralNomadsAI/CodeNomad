import path from "node:path"
import { isSessionNotFoundError } from "@opencode/client"
import type { PermissionReceipt, WorkspaceEventPayload } from "../api-types"
import type { EventBus } from "../events/bus"
import type { Logger } from "../logger"
import type { WorkspaceManager } from "../workspaces/manager"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { nativeEventConnections } from "../workspaces/opencode-service"
import { locationRequestOptions, readLocationRef } from "../opencode/compatibility/location"
import { PermissionReceiptStore, permissionSnapshot, receiptHash, type ReceiptQuery } from "./receipt-store"

type Manager = Pick<WorkspaceManager, "get" | "getSharedServiceConnection" | "ownsLocation" | "getServiceWslDistro" | "getServicePathStyle">
type InstanceEvent = Extract<WorkspaceEventPayload, { type: "instance.event" }>
export class PermissionReceipts {
  private readonly scopes = new WeakMap<ServiceConnection, Promise<string>>()
  private readonly events = new Map<string, Promise<unknown>>()
  private readonly confirmations = new Set<Promise<unknown>>()
  private readonly observers = new Map<string, Set<string>>()
  constructor(private readonly store: PermissionReceiptStore, private readonly manager: Manager,
    private readonly bus: EventBus, private readonly logger: Logger) {}

  start() { this.bus.on("instance.event", this.onEvent); this.bus.on("instance.eventStatus", this.onStatus) }
  async stop() {
    this.bus.off("instance.event", this.onEvent); this.bus.off("instance.eventStatus", this.onStatus)
    await Promise.allSettled(this.events.values())
    await Promise.allSettled(this.confirmations)
  }
  private scope(instanceId: string, connection: ServiceConnection): Promise<string> {
    let pending = this.scopes.get(connection)
    if (!pending) {
      const distro = this.manager.getServiceWslDistro(instanceId)?.toLowerCase()
      const style = this.manager.getServicePathStyle(instanceId)
      if (!style) return Promise.reject(new Error("Workspace execution identity is unavailable"))
      const paths = style === "win32" ? path.win32 : path.posix
      pending = connection.client.config.get(undefined, { signal: AbortSignal.timeout(10_000) }).then(entries => {
        connection.assertCurrent()
        const root = entries.find(entry => entry.type === "directory")?.path
        if (typeof root !== "string" || !paths.isAbsolute(root) || root.includes("\0")) throw new Error("Missing native discovery identity")
        const directory = paths === path.win32 ? paths.normalize(root).toLowerCase() : paths.normalize(root)
        // Native discovery root, not backend environment or transient workspace ID.
        // The authenticated service channel distinguishes daemons sharing a config
        // root without tying persistence to a transient PID/port. Never store auth.
        const auth = connection.endpoint.auth
        const channel = auth ? receiptHash(JSON.stringify([auth.type, auth.username, auth.password])) : connection.endpoint.url
        return JSON.stringify([distro ? `wsl:${distro}` : `host:${process.platform}`, directory, channel])
      })
      this.scopes.set(connection, pending)
      void pending.catch(() => { if (this.scopes.get(connection) === pending) this.scopes.delete(connection) })
    }
    return pending
  }
  private enqueue(instanceId: string, run: () => Promise<unknown>) {
    const task = (this.events.get(instanceId) ?? Promise.resolve()).catch(() => {}).then(run)
    this.events.set(instanceId, task)
    void task.catch(() => this.logger.error({ instanceId }, "Failed to persist permission receipt"))
      .finally(() => { if (this.events.get(instanceId) === task) this.events.delete(instanceId) })
  }
  private observe(instanceId: string, scope: string, sessionId: string) {
    const key = JSON.stringify([scope, sessionId])
    let instances = this.observers.get(key)
    if (!instances) {
      instances = new Set()
      this.observers.set(key, instances)
      if (this.observers.size > 1024) this.observers.delete(this.observers.keys().next().value!)
    }
    instances.add(instanceId)
    return instances
  }
  private readonly onEvent = (payload: InstanceEvent) => {
    const event = payload.event as { type?: string; data?: any; created?: number }
    if (!event || !["permission.asked", "permission.replied", "session.deleted"].includes(event.type ?? "")) return
    const { instanceId } = payload
    // Acquire while the ownership-validated event is delivered; stale connections
    // fail their fence rather than being reassigned to a replacement daemon.
    const connection = nativeEventConnections.get(payload.event)
    if (!connection) return
    const scope = this.scope(instanceId, connection)
    void scope.catch(() => {})
    const request = event.type === "permission.asked" ? permissionSnapshot(event.data) : undefined
    this.enqueue(instanceId, async () => {
      const identity = await scope
      if (request) {
        this.observe(instanceId, identity, request.sessionId)
        return this.store.capture(identity, request)
      }
      const sessionId = event.data?.sessionID
      if (typeof sessionId !== "string" || !sessionId || sessionId.length > 512) return
      if (event.type === "session.deleted") {
        this.observers.delete(JSON.stringify([identity, sessionId]))
        return this.store.remove(identity, sessionId)
      }
      const requestId = event.data?.requestID
      const decision = event.data?.reply
      if (typeof requestId !== "string" || !requestId || requestId.length > 512 || !["once", "always", "reject"].includes(decision)) return
      await this.resolve(instanceId, identity, { sessionId, requestId, resources: [], decision, origin: "native",
        resolvedAt: typeof event.created === "number" && Number.isFinite(event.created) && event.created >= 0 ? event.created : Date.now() })
    })
  }
  private readonly onStatus = (event: Extract<WorkspaceEventPayload, { type: "instance.eventStatus" }>) => {
    if (event.status !== "connected") return
    const workspace = this.manager.get(event.instanceId)
    if (!workspace) return
    this.enqueue(event.instanceId, async () => {
      const connection = await this.manager.getSharedServiceConnection(event.instanceId)
      if (!connection) return
      const current = () => {
        connection.assertCurrent()
        return this.manager.get(event.instanceId) === workspace
      }
      if (!current()) return
      const scope = await this.scope(event.instanceId, connection)
      if (!current()) return
      const locations = await connection.client.debug.location.list({ signal: AbortSignal.timeout(10_000) })
      // Pending permissions live in loaded native Locations, including descendant
      // directories that neither the daemon cwd nor worktree-root lists cover.
      for (const value of locations) {
        if (!current()) return
        const location = readLocationRef(value)
        if (!await this.manager.ownsLocation(event.instanceId, location, connection.client, undefined, "event")) continue
        if (!current()) return
        const pending = await connection.client.permission.request.list({ location: { directory: location.directory } }, {
          ...locationRequestOptions(location), signal: AbortSignal.timeout(10_000),
        })
        for (const value of pending.data) {
          if (!current()) return
          const request = permissionSnapshot(value)
          if (!request) continue
          let session
          try { session = await connection.client.session.get({ sessionID: request.sessionId }, { signal: AbortSignal.timeout(10_000) }) }
          catch (error) { if (isSessionNotFoundError(error)) continue; throw error }
          if (!current()) return
          if (!await this.manager.ownsLocation(event.instanceId, session.location, connection.client, undefined, "event")) continue
          if (!current()) return
          await this.store.capture(scope, request)
        }
      }
    })
  }

  /** Called after proxy/Yolo ownership checks, before the native mutation. */
  async prepare(instanceId: string, connection: ServiceConnection, sessionId: string, requestId: string,
    decision: PermissionReceipt["decision"], origin: "codenomad" | "yolo", reason?: string) {
    const scope = await this.scope(instanceId, connection)
    const pending = await connection.client.permission.get({ sessionID: sessionId, requestID: requestId }, { signal: AbortSignal.timeout(10_000) })
    const request = permissionSnapshot(pending)
    if (!request || request.sessionId !== sessionId || request.requestId !== requestId) throw new Error("Permission request identity mismatch")
    connection.assertCurrent()
    await this.store.capture(scope, request)
    this.observe(instanceId, scope, sessionId)
    // Confirmation is independent of the SSE event order. No call on failure.
    return () => {
      const task = this.resolve(instanceId, scope, { ...request, decision, origin, reason: reason?.slice(0, 4096), resolvedAt: Date.now() }).catch(() => {
        // The native mutation already succeeded: never convert this into a
        // transport error inviting a replay, and never publish an unpersisted row.
        this.logger.error({ instanceId, sessionId, requestId }, "Native permission reply succeeded but receipt persistence failed")
      })
      this.confirmations.add(task)
      void task.finally(() => this.confirmations.delete(task))
      return task
    }
  }
  async prepareDeletion(instanceId: string, connection: ServiceConnection, sessionId: string) {
    const scope = await this.scope(instanceId, connection)
    return async () => {
      try { await this.store.remove(scope, sessionId) }
      catch { this.logger.error({ instanceId, sessionId }, "Native session deletion succeeded but receipt cleanup failed") }
    }
  }
  private async resolve(instanceId: string, scope: string, receipt: PermissionReceipt) {
    const observers = this.observe(instanceId, scope, receipt.sessionId)
    const saved = await this.store.resolve(scope, receipt)
    if (saved) for (const observer of observers) {
      if (this.manager.get(observer)) this.bus.publish({ type: "permission.receiptsChanged", instanceId: observer, sessionId: saved.sessionId, messageId: saved.source?.messageId })
    }
  }
  async list(instanceId: string, sessionId: string, query: ReceiptQuery) {
    const workspace = this.manager.get(instanceId)
    if (!workspace) throw Object.assign(new Error("Workspace not found"), { statusCode: 404 })
    const connection = await this.manager.getSharedServiceConnection(instanceId)
    if (!connection) throw Object.assign(new Error("OpenCode is unavailable"), { statusCode: 503 })
    let session
    try { session = await connection.client.session.get({ sessionID: sessionId }, { signal: AbortSignal.timeout(10_000) }) }
    catch (error) {
      if (!isSessionNotFoundError(error)) throw error
      await this.store.remove(await this.scope(instanceId, connection), sessionId)
      throw Object.assign(new Error("Session not found"), { statusCode: 404 })
    }
    if (!await this.manager.ownsLocation(instanceId, session.location, connection.client)) {
      throw Object.assign(new Error("Session does not belong to workspace"), { statusCode: 403 })
    }
    const scope = await this.scope(instanceId, connection)
    this.observe(instanceId, scope, sessionId)
    const result = await this.store.list(scope, sessionId, query)
    connection.assertCurrent()
    if (this.manager.get(instanceId) !== workspace) throw Object.assign(new Error("Workspace changed"), { statusCode: 409 })
    return result
  }
}
