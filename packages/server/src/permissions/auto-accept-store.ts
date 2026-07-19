/**
 * In-memory permission auto-accept (Yolo) state, owned by the server.
 *
 * This is a faithful port of the previous frontend implementation
 * (`packages/ui/src/stores/permission-auto-accept.ts`) so the inheritance
 * semantics are preserved exactly:
 *   - state is keyed by the resolved *family root* session id
 *   - a session with a `revert` snapshot is treated as its own root (fork)
 *   - enabling any session enables its whole family root and vice-versa
 *
 * This store remains in-memory; AutoAcceptManager hydrates and persists it
 * through OpenCode session metadata.
 */

export interface AutoAcceptSessionInfo {
  id: string
  parentId?: string | null
  /** Truthy value marks the session as a fork that roots at itself. */
  revert?: unknown
}

type SessionLookup = (sessionId: string) => AutoAcceptSessionInfo | undefined

/**
 * Resolve the family-root session id for `sessionId` by walking the parent
 * chain. Mirrors `resolvePermissionAutoAcceptFamilyRoot` from the UI so
 * inheritance behaviour does not change.
 */
export function resolveFamilyRoot(sessionId: string, getSession: SessionLookup): string {
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

export class AutoAcceptStore {
  /** instanceId -> set of enabled family-root session ids */
  private readonly enabled = new Map<string, Set<string>>()
  /** instanceId -> (sessionId -> info) */
  private readonly sessions = new Map<string, Map<string, AutoAcceptSessionInfo>>()

  isEnabled(instanceId: string, sessionId: string): boolean {
    const root = this.familyRoot(instanceId, sessionId)
    return this.enabled.get(instanceId)?.has(root) ?? false
  }

  setEnabled(instanceId: string, sessionId: string, enabled: boolean): void {
    const root = this.familyRoot(instanceId, sessionId)
    let roots = this.enabled.get(instanceId)
    if (!roots) {
      if (!enabled) return
      roots = new Set()
      this.enabled.set(instanceId, roots)
    }
    if (enabled) {
      roots.add(root)
    } else {
      roots.delete(root)
      if (roots.size === 0) {
        this.enabled.delete(instanceId)
      }
    }
  }

  toggle(instanceId: string, sessionId: string): boolean {
    const next = !this.isEnabled(instanceId, sessionId)
    this.setEnabled(instanceId, sessionId, next)
    return next
  }

  upsertSession(instanceId: string, info: AutoAcceptSessionInfo): void {
    let tree = this.sessions.get(instanceId)
    if (!tree) {
      tree = new Map()
      this.sessions.set(instanceId, tree)
    }
    tree.set(info.id, {
      id: info.id,
      parentId: info.parentId ?? null,
      revert: info.revert,
    })
    this.migrateEnabledRoots(instanceId)
  }

  removeSession(instanceId: string, sessionId: string): void {
    this.sessions.get(instanceId)?.delete(sessionId)
  }

  clearInstance(instanceId: string): void {
    this.sessions.delete(instanceId)
    this.enabled.delete(instanceId)
  }

  /** Resolves the family-root session id for the given session. */
  familyRoot(instanceId: string, sessionId: string): string {
    const tree = this.sessions.get(instanceId)
    return resolveFamilyRoot(sessionId, (id) => tree?.get(id))
  }

  enabledRoots(instanceId: string): string[] {
    return [...(this.enabled.get(instanceId) ?? [])]
  }

  /**
   * Re-resolves every enabled family root for an instance after the session
   * tree changes (new session, updated parent/revert). If a root now resolves
   * to a different id, the enabled entry is migrated so toggles survive late
   * ancestry discovery.
   */
  private migrateEnabledRoots(instanceId: string): void {
    const roots = this.enabled.get(instanceId)
    if (!roots || roots.size === 0) return
    for (const oldRoot of Array.from(roots)) {
      const newRoot = this.familyRoot(instanceId, oldRoot)
      if (newRoot !== oldRoot) {
        roots.delete(oldRoot)
        roots.add(newRoot)
      }
    }
  }
}
