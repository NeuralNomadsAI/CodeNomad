import { readFile } from "node:fs/promises"
import { installDesktopPluginPresence, type DesktopPluginFeature, type DesktopPluginPaths } from "./desktop-plugin-installation"

type PreparedPlugin = { commit(): void; release(): Promise<void> }
type Installation = {
  claims: Map<symbol, () => void>
  committed: boolean
  pending: Promise<() => Promise<void>>
  closing?: Promise<void>
}

// One backend lease per namespace. Temporary claims keep overlapping connection
// attempts independent; only successful preparation retains the backend lease.
export class DesktopPluginLifecycle {
  private readonly installations = new Map<string, Installation>()
  private stopped = false

  constructor(
    private readonly feature: DesktopPluginFeature,
    private readonly readBundle = () => readFile(new URL(`../plugins/${feature}/plugin.mjs`, import.meta.url))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return readFile(new URL(`../../dist/plugins/${feature}/plugin.mjs`, import.meta.url))
      }),
  ) {}

  async start(paths: DesktopPluginPaths): Promise<void> {
    const prepared = await this.prepare(paths, () => {})
    try { prepared.commit() }
    finally { await prepared.release() }
  }

  async prepare(paths: DesktopPluginPaths, assertCurrent: () => void): Promise<PreparedPlugin> {
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
          return installDesktopPluginPresence(this.feature, bundle, paths, current)
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
        commit: () => { check(); installation.committed = true },
        release,
      }
    } catch (error) {
      await release()
      throw error
    }
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

// Commit both feature claims together. A failed/stale attempt relinquishes only
// its new claims, never another attempt's committed lease or another backend's.
export async function prepareDesktopPluginPresence(
  paths: DesktopPluginPaths,
  assertCurrent: () => void,
  lifecycles: { pruning: DesktopPluginLifecycle; automation?: DesktopPluginLifecycle },
): Promise<void> {
  const prepared: PreparedPlugin[] = []
  try {
    assertCurrent()
    prepared.push(await lifecycles.pruning.prepare(paths, assertCurrent))
    assertCurrent()
    if (lifecycles.automation) prepared.push(await lifecycles.automation.prepare(paths, assertCurrent))
    assertCurrent()
    for (const entry of prepared) entry.commit()
  } finally {
    await Promise.all(prepared.map(entry => entry.release()))
  }
}
