export const BUNDLES_READS_PER_MINUTE = 60, BUNDLES_MANAGE_PER_MINUTE = 10, BUNDLES_RATE_WINDOW_MS = 60_000

/** Backend-owned sliding budgets: package replacement and mounting never reset them. */
export class BundlesBudget {
  private calls = new Map<string, { read: number[]; manage: number[] }>()
  constructor(private readonly now: () => number = Date.now) {}
  take(extension: string, kind: "read" | "manage"): boolean {
    const at = this.now()
    for (const [id, calls] of this.calls) {
      calls.read = calls.read.filter(time => time > at - BUNDLES_RATE_WINDOW_MS)
      calls.manage = calls.manage.filter(time => time > at - BUNDLES_RATE_WINDOW_MS)
      if (!calls.read.length && !calls.manage.length) this.calls.delete(id)
    }
    const calls = this.calls.get(extension) ?? { read: [], manage: [] }
    if (calls[kind].length >= (kind === "read" ? BUNDLES_READS_PER_MINUTE : BUNDLES_MANAGE_PER_MINUTE)) return false
    calls[kind].push(at); this.calls.set(extension, calls)
    return true
  }
}
