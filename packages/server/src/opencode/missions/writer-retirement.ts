/** Local writer drain only. The native runtime must independently attest the
 * registration/incarnation, artifact, disposal, and complete inventory.
 * A successful drain is NOT a native disposal receipt. */
export function createMissionWriterRetirement() {
  const inFlight = new Set<Promise<unknown>>()
  let retired = false
  let writeFailure: Error | undefined
  let disposal: Promise<void> | undefined

  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      if (retired) return Promise.reject(new Error("CodeNomad Missions is no longer available"))
      // Admit synchronously, before the first await; a captured callback cannot
      // enter after retirement, even if native unregister races with it.
      const result = (async () => work())()
      inFlight.add(result)
      void result.then(() => inFlight.delete(result), () => inFlight.delete(result))
      return result
    },
    write<T>(work: () => Promise<T>): Promise<T> {
      return this.run(async () => {
        try { return await work() }
        catch (error) {
          // A rejected native set can have an unknown effect even if it finished
          // before retirement. No local callback can reconcile that publication.
          writeFailure ??= error instanceof Error ? error : new Error("Mission write failed")
          throw error
        }
      })
    },
    retire(unregister: () => Promise<void>): Promise<void> {
      retired = true
      // Unregistration alone does not wait for callbacks already admitted.
      return disposal ??= (async () => {
        const results = await Promise.allSettled([Promise.resolve().then(unregister), ...inFlight])
        if (results[0].status === "rejected") throw results[0].reason
        if (writeFailure) throw writeFailure
      })()
    },
  }
}
