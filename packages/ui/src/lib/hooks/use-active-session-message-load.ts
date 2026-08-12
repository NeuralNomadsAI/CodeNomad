import { createEffect, createMemo } from "solid-js"

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
  /** Loads the messages for a session. */
  loadMessages: (instanceId: string, sessionId: string) => Promise<void> | void
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
  const activeSessionId = createMemo(() => (deps.isActive() ? (deps.session()?.id ?? null) : null))
  createEffect(() => {
    const sessionId = activeSessionId()
    if (!sessionId) return
    const instanceId = deps.instanceId()
    void Promise.resolve(deps.waitForHydration(instanceId))
      .then(() => {
        // Re-check after the async gate: the user may have switched away or to
        // a different session while metadata was hydrating.
        if (!deps.isActive() || deps.session()?.id !== sessionId) return
        return deps.loadMessages(instanceId, sessionId)
      })
      .catch((error) => deps.onError?.(error))
  })
}
