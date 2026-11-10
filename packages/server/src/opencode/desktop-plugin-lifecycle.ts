import { readFile } from "node:fs/promises"
import { installDesktopPluginPresence, type DesktopPluginFeature, type DesktopPluginPaths } from "./desktop-plugin-installation"
import type { ServiceConnection } from "../workspaces/opencode-service"
import { setTimeout as delay } from "node:timers/promises"
import { isReadinessDirectory, READINESS_WAIT_MS } from "./desktop-plugin-readiness"

export interface DesktopPluginReadinessTarget {
  connection: ServiceConnection
  location: { readonly directory: string }
  signal: AbortSignal
  deadlineAt?: number
  /** Caller has already authorized this exact Location. Recheck captured
   * workspace/placement identity and authority before every new admission. */
  assertCurrent(): void
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) { signal.removeEventListener("abort", abort); abort() }
  })
}

const readPayload = (feature: DesktopPluginFeature, file: string) => readFile(new URL(`../plugins/${feature}/${file}`, import.meta.url))
  .catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
    return readFile(new URL(`../../dist/plugins/${feature}/${file}`, import.meta.url))
  })

type PreparedPlugin = { commit(): void; release(): Promise<void> }
type Presence = Awaited<ReturnType<typeof installDesktopPluginPresence>>
type Installation = {
  claims: Map<symbol, () => void>
  committed: boolean
  pending: Promise<Presence>
  closing?: Promise<void>
}

// One backend lease per namespace. Temporary claims keep overlapping connection
// attempts independent; only successful preparation retains the backend lease.
export class DesktopPluginLifecycle {
  private readonly installations = new Map<string, Installation>()
  private latest?: Installation
  private readonly connections = new WeakMap<ServiceConnection, Installation>()
  private stopped = false
  private leaseContent = ""

  constructor(
    private readonly feature: DesktopPluginFeature,
    private readonly readBundle = () => readPayload(feature, "plugin.mjs"),
    private readonly readProvider = () => readPayload("missions", "provider.mjs"),
  ) {}

  async start(paths: DesktopPluginPaths): Promise<void> {
    const prepared = await this.prepare(paths, () => {})
    try { prepared.commit() }
    finally { await prepared.release() }
  }

  async prepare(paths: DesktopPluginPaths, assertCurrent: () => void, connection?: ServiceConnection): Promise<PreparedPlugin> {
    const check = () => {
      if (this.stopped) throw new Error("Desktop plugin lifecycle has stopped")
      assertCurrent()
    }
    check()
    const key = paths.config
    const claim = Symbol()
    let entry = this.installations.get(key)
    if (!entry) {
      const claims = new Map<symbol, () => void>()
      const current = (): void => {
        if (this.stopped) throw new Error("Desktop plugin lifecycle has stopped")
        for (const validate of claims.values()) {
          try { validate(); return } catch { /* Another attempt may still own this installation. */ }
        }
        throw new Error("Desktop plugin preparation is no longer current")
      }
      entry = {
        claims, committed: false,
        pending: Promise.resolve().then(async () => {
          current()
          const bundle = await this.readBundle()
          current()
          const provider = this.feature === "missions" ? await this.readProvider() : undefined
          current()
          return installDesktopPluginPresence(this.feature, bundle, paths, current, () => this.leaseContent, provider)
        }),
      }
      this.installations.set(key, entry)
      const installation = entry
      void entry.pending.catch(() => {
        if (this.installations.get(key) === installation) this.installations.delete(key)
      })
    }
    const installation = entry
    installation.claims.set(claim, check)
    const release = async () => {
      installation.claims.delete(claim)
      if (installation.committed || installation.claims.size) return
      if (this.installations.get(key) === installation) this.installations.delete(key)
      await this.close(installation)
    }
    try {
      await installation.pending
      check()
      return {
        commit: () => {
          check(); installation.committed = true; this.latest = installation
          if (connection) this.connections.set(connection, installation)
        },
        release,
      }
    } catch (error) {
      await release()
      throw error
    }
  }

  /**
   * No argument: bounded startup marker wait. Targeted: fresh observed pruning
   * registration for an already-authorized Location, failing closed on timeout.
   */
  async ready(target?: DesktopPluginReadinessTarget): Promise<void> {
    if (!target) {
      await this.latest?.pending.then(presence => presence.ready, () => undefined)
      return
    }
    const { connection, assertCurrent } = target
    const location = { directory: target.location.directory }
    if (Object.keys(target.location).join(",") !== "directory" || !isReadinessDirectory(location.directory)) throw new Error("Invalid readiness Location")
    const controller = new AbortController()
    const signal = AbortSignal.any([target.signal, controller.signal])
    const deadlineAt = Math.min(Date.now() + READINESS_WAIT_MS, target.deadlineAt ?? Infinity)
    const check = () => {
      signal.throwIfAborted()
      if (Date.now() >= deadlineAt) throw new Error("Pruning Location readiness timed out or unsupported")
      if (this.stopped) throw new Error("Desktop plugin lifecycle has stopped")
      connection.assertCurrent()
      assertCurrent()
    }
    check()
    const timer = setTimeout(() => controller.abort(new Error("Pruning Location readiness timed out or unsupported")),
      Math.max(0, deadlineAt - Date.now()))
    try {
      const installation = this.connections.get(connection)
      if (!installation || installation.closing || this.feature !== "session-pruning") throw new Error("Pruning presence unavailable for captured connection")
      const presence = await abortable(installation.pending, signal)
      check()
      while (true) {
        check()
        // This call owns its transport. Cancellation must settle that transport
        // before returning; only the shared installation uses an early waiter.
        let catalogue
        try { catalogue = await connection.client.plugin.list({ location }, { signal }) }
        catch (error) { check(); throw error }
        check()
        if (catalogue.location.directory !== location.directory) throw new Error("Pruning catalogue Location changed")
        const plugin = catalogue.data.find(plugin => plugin.id === "codenomad-session-pruning")
        if (plugin?.state.status === "active") break
        if (plugin?.state.status === "failed") throw new Error("Pruning plugin unavailable")
        await delay(100, undefined, { signal })
        check()
      }
      check()
      await presence.prepare(location.directory, signal, check, deadlineAt)
      check()
    } finally { controller.abort(); clearTimeout(timer) }
  }

  /**
   * Backend state carried by every lease this lifecycle retains, one per
   * namespace. Pending and later installations are created with it; settles once
   * each existing lease has attempted its rewrite (a failure retries at its next heartbeat).
   */
  async setLeaseContent(content: string): Promise<void> {
    this.leaseContent = content
    await Promise.all([...this.installations.values()].map(installation =>
      installation.pending.then(presence => presence.sync(), () => {})))
  }

  private close(installation: Installation): Promise<void> {
    return installation.closing ??= installation.pending.then(dispose => dispose(), () => {})
  }

  async stop(): Promise<void> {
    this.stopped = true
    const pending = [...this.installations.values()].map(installation => this.close(installation))
    this.installations.clear()
    await Promise.all(pending)
  }
}

// Commit feature claims together. A failed/stale attempt relinquishes only
// its new claims, never another attempt's committed lease or another backend's.
export async function prepareDesktopPluginPresence(
  paths: DesktopPluginPaths,
  assertCurrent: () => void,
  lifecycles: { pruning: DesktopPluginLifecycle; automation?: DesktopPluginLifecycle; missions?: DesktopPluginLifecycle; memory?: DesktopPluginLifecycle },
  connection?: ServiceConnection,
): Promise<void> {
  const prepared: PreparedPlugin[] = []
  try {
    assertCurrent()
    prepared.push(await lifecycles.pruning.prepare(paths, assertCurrent, connection))
    assertCurrent()
    if (lifecycles.automation) prepared.push(await lifecycles.automation.prepare(paths, assertCurrent))
    assertCurrent()
    if (lifecycles.missions) prepared.push(await lifecycles.missions.prepare(paths, assertCurrent))
    assertCurrent()
    if (lifecycles.memory) prepared.push(await lifecycles.memory.prepare(paths, assertCurrent))
    assertCurrent()
    for (const entry of prepared) entry.commit()
  } finally {
    await Promise.all(prepared.map(entry => entry.release()))
  }
}
