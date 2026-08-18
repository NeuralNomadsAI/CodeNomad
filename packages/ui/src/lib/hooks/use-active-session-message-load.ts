import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"

/**
 * Dependencies for {@link useActiveSessionMessageLoad}. Everything is injected
 * as accessors/callbacks so the reactive trigger can be unit-tested in
 * isolation (see use-active-session-message-load.test.ts) and reused by
 * SessionView without pulling the component's full dependency graph.
 */
export interface ActiveSessionMessageLoadDeps {
  /** Whether this SessionView is the active one. Read reactively. */
  isActive: () => boolean
  /** The owning instance id. Read reactively. */
  instanceId: () => string
  /** The current session object (or undefined). Read reactively. */
  session: () => { id: string } | undefined
  /** Optional reactive gate. Each false-to-true transition reloads the same session. */
  shouldLoad?: () => boolean
  /** Loads the messages for a session. */
  loadMessages: (
    instanceId: string,
    sessionId: string,
    options?: { registerInvalidation?: (invalidate: () => void) => void },
  ) => Promise<unknown> | void
  /** Resolves once the instance's workspace metadata has hydrated. */
  waitForHydration: (instanceId: string) => Promise<void>
  /** Optional error sink for a rejected load. */
  onError?: (error: unknown) => void
}

/**
 * Triggers the initial message load for the ACTIVE session, and only re-runs
 * when the active session *id* actually changes.
 *
 * The session id is derived through a value-diffed `createMemo`, so the effect
 * is NOT subscribed to the whole reactive sessions map. During a
 * foreground/reconnect refresh the many concurrent `loadMessages()` completions
 * each call `setSessions`, replacing session object references dozens of times;
 * reading the full object here would re-fire the effect on every one of those
 * mutations. One such re-fire — landing in the window where the loaded flag was
 * just invalidated — would issue a redundant `force:false` fetch that races the
 * authoritative `force:true` reload for the same (often very large) session,
 * saturating bandwidth-constrained links. Narrowing the dependency to the id
 * collapses that storm to a single load per real session change while
 * preserving load-on-activation and load-on-switch behavior.
 */
export function useActiveSessionMessageLoad(deps: ActiveSessionMessageLoadDeps): void {
  const activeBinding = createMemo(() => {
    const sessionId = deps.isActive() ? deps.session()?.id : undefined
    return sessionId ? `${deps.instanceId()}\u0000${sessionId}` : null
  })
  const [reloadVersion, setReloadVersion] = createSignal(0)
  let previousLoadBinding: string | null = null
  createEffect(() => {
    if (!deps.shouldLoad) return
    const binding = activeBinding()
    const loadBinding = binding && deps.shouldLoad() ? binding : null
    if (loadBinding && loadBinding !== previousLoadBinding) setReloadVersion((value) => value + 1)
    previousLoadBinding = loadBinding
  })

  createEffect(() => {
    const binding = activeBinding()
    if (deps.shouldLoad) {
      reloadVersion()
      if (!untrack(deps.shouldLoad)) return
    }
    if (!binding) return
    const [instanceId, sessionId] = binding.split("\u0000")
    let invalidate = () => {}
    let cancelled = false
    let pending = false
    onCleanup(() => {
      cancelled = true
      if (pending) invalidate()
    })
    void Promise.resolve(deps.waitForHydration(instanceId))
      .then(() => {
        // Re-check after the async gate: the user may have switched away or to
        // a different session while metadata was hydrating.
        if (cancelled || !deps.isActive() || deps.instanceId() !== instanceId || deps.session()?.id !== sessionId) return
        pending = true
        return Promise.resolve(deps.loadMessages(instanceId, sessionId, {
          registerInvalidation: (next) => { invalidate = next },
        })).finally(() => { pending = false })
      })
      .catch((error) => deps.onError?.(error))
  })
}
