/** A cleanup excludes addressed native proxy mutations for the same session,
 * across workspace tabs. A conflicting operation is refused, never replayed. */
export class SessionCleanupFence {
  private readonly cleaning = new Set<string>()
  private readonly mutations = new Map<string, number>()
  private readonly uncertain = new Set<string>()

  markUncertain(id: string) { this.uncertain.add(id) }
  observeAbsent(id: string) { this.uncertain.delete(id) }
  hasUncertain(id: string) { return this.uncertain.has(id) }

  enterCleanup(id: string): (() => void) | undefined {
    if (this.cleaning.has(id) || this.mutations.has(id) || this.uncertain.has(id)) return
    this.cleaning.add(id)
    return () => { this.cleaning.delete(id) }
  }

  enterMutation(id: string): (() => void) | undefined {
    if (this.cleaning.has(id) || this.uncertain.has(id)) return
    this.mutations.set(id, (this.mutations.get(id) ?? 0) + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const count = this.mutations.get(id)!
      if (count === 1) this.mutations.delete(id)
      else this.mutations.set(id, count - 1)
    }
  }
}
