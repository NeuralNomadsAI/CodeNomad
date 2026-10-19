import { AsyncLocalStorage } from "node:async_hooks"
import { Effect } from "effect"

// Match the native decision evidence read bound (native-human-evidence.ts).
export const NATIVE_HUMAN_ANSWER_TIMEOUT_MS = 10_000
type Runner = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>
const track = <A>(pending: Set<Promise<unknown>>, promise: Promise<A>) => {
  pending.add(promise)
  void promise.then(() => pending.delete(promise), () => pending.delete(promise))
  return promise
}

/** Bridge Promise business code back into this invocation, never plugin setup.
 * Each check's answer runtimes share cancellation/deadline and join before graph
 * release. A noninterruptible native finalizer must still finish: abandoning it
 * at a wall-clock deadline would be an unsafe use-after-release. */
export function nativeInvocation() {
  type Invocation = { active: boolean; pending: Set<Promise<unknown>>;
    signal: AbortSignal; run: <A, E>(effect: Effect.Effect<A, E>, signal: AbortSignal) => Promise<A> }
  const local = new AsyncLocalStorage<Invocation>()
  const capture = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => Effect.gen(function* () {
    const graph = yield* Effect.context<R>()
    return yield* Effect.callback<A, E>((resume, signal) => {
      const invocation: Invocation = { active: true, pending: new Set(), signal,
        run: (effect, signal) => Effect.runPromiseWith(graph)(effect, { signal }) }
      const done = local.run(invocation, () => Effect.runPromiseExitWith(graph)(effect, { signal }))
      const drained = done.then(async exit => {
        invocation.active = false
        await Promise.allSettled(invocation.pending)
        return exit
      })
      void drained.then(resume)
      // Join actual read runtimes, including their cancellation finalizers; never
      // race away from a read still using this graph.
      return Effect.promise(() => drained.then(() => undefined))
    })
  })
  const check = <A>(use: (run: Runner) => Promise<A>): Promise<A> => {
    const invocation = local.getStore()
    if (!invocation?.active) return Promise.reject(new Error("Native Mission invocation unavailable"))
    const cancel = new AbortController(), signal = AbortSignal.any([invocation.signal, cancel.signal])
    const pending = new Set<Promise<unknown>>()
    const run: Runner = effect => {
      if (!invocation.active) return Promise.reject(new Error("Native Mission invocation unavailable"))
      if (signal.aborted) return Promise.reject(signal.reason)
      return track(invocation.pending, track(pending, invocation.run(effect, signal)))
    }
    const timer = setTimeout(() => cancel.abort(new Error("Native human answer read timed out")), NATIVE_HUMAN_ANSWER_TIMEOUT_MS)
    const done = (async () => {
      try { return await run(Effect.tryPromise({ try: () => use(run), catch: error => error })) }
      finally { clearTimeout(timer); cancel.abort(); await Promise.allSettled(pending) }
    })()
    return track(invocation.pending, done)
  }
  return { capture, check }
}
