import { createSignal } from "solid-js"

/**
 * UI-side mirror of the server-owned Yolo (permission auto-accept) state.
 *
 * The server is authoritative: it holds the toggle state, resolves
 * family-root inheritance, and performs the actual `"once"` replies. This
 * module only keeps a runtime (NON-persisted) projection so the UI can render
 * the badge / switch synchronously.
 *
 * State is populated from:
 *   - local toggles (optimistic, then confirmed via REST)
 *   - `yolo.stateChanged` SSE events (wired in the app bootstrap, see
 *     `stores/instances.ts`, so toggles from other clients reflect)
 *
 * `resolvePermissionAutoAcceptFamilyRoot` is retained as a display aid so the
 * badge correctly lights up for child/sub-sessions of an enabled family root,
 * preserving the previous inheritance UX exactly. The server performs the same
 * resolution independently when deciding whether to auto-reply.
 *
 * NOTE: intentionally pure — no SSE/REST side effects at module load, so it
 * stays unit-testable.
 */

export type PermissionAutoAcceptSession = {
  id: string
  parentId?: string | null
  revert?: unknown
}
type SessionLookup = (sessionId: string) => PermissionAutoAcceptSession | undefined
type FamilyRootResolver = (instanceId: string, sessionId: string) => string

let resolveFamilyRoot: FamilyRootResolver = (_instanceId, sessionId) => sessionId

export function resolvePermissionAutoAcceptFamilyRoot(sessionId: string, getSession: SessionLookup): string {
  let currentId = sessionId
  let lastKnownId = sessionId
  const seen = new Set<string>()

  while (currentId && !seen.has(currentId)) {
    seen.add(currentId)
    const session = getSession(currentId)
    if (!session) return lastKnownId
    lastKnownId = session.id
    if (session.revert) return session.id
    if (!session.parentId) return session.id
    currentId = session.parentId
  }

  return currentId || sessionId
}

export function setPermissionAutoAcceptFamilyRootResolver(resolver: FamilyRootResolver) {
  resolveFamilyRoot = resolver
}

function makeKey(instanceId: string, sessionId: string) {
  return `${instanceId}:${resolveFamilyRoot(instanceId, sessionId)}`
}

const [autoAcceptState, setAutoAcceptState] = createSignal<Map<string, boolean>>(new Map())

export function isPermissionAutoAcceptEnabled(instanceId: string, sessionId: string) {
  return autoAcceptState().get(makeKey(instanceId, sessionId)) ?? false
}

export function setPermissionAutoAcceptEnabled(instanceId: string, sessionId: string, enabled: boolean) {
  setAutoAcceptState((prev) => {
    const key = makeKey(instanceId, sessionId)
    if (prev.get(key) === enabled) return prev
    const next = new Map(prev)
    if (enabled) {
      next.set(key, true)
    } else {
      next.delete(key)
    }
    return next
  })
}

export function togglePermissionAutoAccept(instanceId: string, sessionId: string) {
  const next = !isPermissionAutoAcceptEnabled(instanceId, sessionId)
  setPermissionAutoAcceptEnabled(instanceId, sessionId, next)
  return next
}
