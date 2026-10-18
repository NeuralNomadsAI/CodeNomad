/** Refs handed to an agent for one page. A ref names one DOM node within the page
 * generation it was issued for: a navigation or a replaced target makes it stale.
 * The same node keeps its ref across inspections of the same generation. */
export class RefTable {
  private entries = new Map<string, { backendNodeId: number; generation: string }>()
  private byNode = new Map<string, string>()
  private next = 0

  constructor(private readonly retry = "inspect again", private readonly prefix = "e", private readonly limit = 5_000) {}

  /** A full inspection keeps only the refs it shows; a scoped one adds to the table. */
  issuer(generation: string, replace: boolean): (backendNodeId: number) => string {
    const previous = this.byNode
    if (replace) {
      this.entries = new Map()
      this.byNode = new Map()
    }
    return (backendNodeId) => {
      const key = `${generation}\0${backendNodeId}`
      let ref = this.byNode.get(key)
      if (ref) return ref
      ref = previous.get(key) ?? `${this.prefix}${++this.next}`
      this.entries.set(ref, { backendNodeId, generation })
      this.byNode.set(key, ref)
      if (this.entries.size > this.limit) {
        const [oldest, entry] = this.entries.entries().next().value!
        this.entries.delete(oldest)
        this.byNode.delete(`${entry.generation}\0${entry.backendNodeId}`)
      }
      return ref
    }
  }

  resolve(ref: string, generation: string): number {
    const entry = this.entries.get(ref)
    if (!entry || entry.generation !== generation) throw new Error(`Unknown or stale ref ${ref}; ${this.retry}`)
    return entry.backendNodeId
  }

  clear(): void {
    this.entries.clear()
    this.byNode.clear()
  }
}
