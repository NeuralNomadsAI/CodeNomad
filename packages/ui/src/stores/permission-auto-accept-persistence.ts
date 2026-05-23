import type { OwnerBucket } from "../lib/storage"

export const PERMISSION_AUTO_ACCEPT_STATE_KEY = "permissionAutoAccept"
const SERVER_PERSIST_RETRY_DELAY_MS = 1000

export function makePermissionAutoAcceptScope(workspacePath: string): string {
  return `workspace:${encodeURIComponent(workspacePath)}`
}

export function makePermissionAutoAcceptStateKey(scope: string, sessionId: string): string {
  return `${scope}:session:${sessionId}`
}

export function isPersistedPermissionAutoAcceptStateKey(key: string): boolean {
  return key.startsWith("workspace:")
}

function filterPersistedPermissionAutoAcceptState(state: Map<string, boolean>): Map<string, boolean> {
  return new Map([...state].filter(([key, value]) => value === true && isPersistedPermissionAutoAcceptStateKey(key)))
}

export function mergeUnmigratedPermissionAutoAcceptState(
  persisted: Map<string, boolean>,
  local: Map<string, boolean>,
): Map<string, boolean> {
  const next = new Map(persisted)
  for (const [key, value] of local) {
    if (value === true && !isPersistedPermissionAutoAcceptStateKey(key)) next.set(key, true)
  }
  return next
}

export function migrateLegacyPermissionAutoAcceptState(
  state: Map<string, boolean>,
  instanceId: string,
  scope: string,
): Map<string, boolean> | null {
  const legacyPrefix = `${instanceId}:`
  let migrated = false
  const next = new Map(state)

  for (const key of state.keys()) {
    if (!key.startsWith(legacyPrefix)) continue
    const sessionId = key.slice(legacyPrefix.length)
    if (!sessionId) continue
    next.delete(key)
    next.set(makePermissionAutoAcceptStateKey(scope, sessionId), true)
    migrated = true
  }

  return migrated ? next : null
}

export function readPersistedPermissionAutoAcceptState(bucket: OwnerBucket): Map<string, boolean> | null {
  const raw = bucket[PERMISSION_AUTO_ACCEPT_STATE_KEY]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  return new Map(Object.entries(raw as Record<string, unknown>).filter((entry): entry is [string, boolean] => entry[1] === true))
}

export function serializePermissionAutoAcceptState(state: Map<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(state)
}

export function arePermissionAutoAcceptStatesEqual(a: Map<string, boolean>, b: Map<string, boolean>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false
  }
  return true
}

export function shouldApplyPersistedPermissionAutoAcceptState(
  persisted: Map<string, boolean> | null,
  pending: Map<string, boolean> | null,
): boolean {
  if (!pending) return true
  return arePermissionAutoAcceptStatesEqual(persisted ?? new Map<string, boolean>(), pending)
}

interface PermissionAutoAcceptServerPersistenceOptions {
  owner: string
  patchStateOwner: (owner: string, patch: unknown) => Promise<OwnerBucket>
  applyPersistedBucket: (bucket: OwnerBucket) => void
  logError: (message: string, error: unknown) => void
}

export function createPermissionAutoAcceptServerPersistence(options: PermissionAutoAcceptServerPersistenceOptions) {
  let confirmedServerState: Map<string, boolean> | null = null
  let pendingServerState: Map<string, boolean> | null = null
  let isPersisting = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  function persistToServer(next: Map<string, boolean>, previous = new Map<string, boolean>()) {
    const previousSnapshot = filterPersistedPermissionAutoAcceptState(previous)
    const nextSnapshot = filterPersistedPermissionAutoAcceptState(next)
    if (!confirmedServerState) confirmedServerState = previousSnapshot
    pendingServerState = nextSnapshot
    clearRetryTimer()
    void flushPendingServerState()
  }

  function clearRetryTimer() {
    if (retryTimer === null) return
    clearTimeout(retryTimer)
    retryTimer = null
  }

  function scheduleRetry() {
    if (retryTimer !== null) return
    retryTimer = setTimeout(() => {
      retryTimer = null
      void flushPendingServerState()
    }, SERVER_PERSIST_RETRY_DELAY_MS)
  }

  async function flushPendingServerState() {
    if (isPersisting) return
    isPersisting = true
    try {
      while (pendingServerState) {
        const nextSnapshot = pendingServerState
        const previousSnapshot = confirmedServerState ?? new Map<string, boolean>()
        const bucket = await options
          .patchStateOwner(options.owner, {
            [PERMISSION_AUTO_ACCEPT_STATE_KEY]: makePermissionAutoAcceptStatePatch(previousSnapshot, nextSnapshot),
          })
          .catch((error) => {
            options.logError("Failed to persist permission auto-accept state", error)
            return null
          })

        if (!bucket) {
          if (pendingServerState && !arePermissionAutoAcceptStatesEqual(pendingServerState, nextSnapshot)) continue
          scheduleRetry()
          break
        }
        confirmedServerState = nextSnapshot
        if (!pendingServerState || !arePermissionAutoAcceptStatesEqual(pendingServerState, nextSnapshot)) continue
        pendingServerState = null
        clearRetryTimer()
        options.applyPersistedBucket(bucket)
      }
    } finally {
      isPersisting = false
    }
  }

  function shouldApplyPersistedState(persisted: Map<string, boolean> | null): boolean {
    const persistedSnapshot = persisted ? filterPersistedPermissionAutoAcceptState(persisted) : null
    if (!pendingServerState) {
      confirmedServerState = persistedSnapshot ?? new Map<string, boolean>()
    }
    return shouldApplyPersistedPermissionAutoAcceptState(persistedSnapshot, pendingServerState)
  }

  return { persistToServer, shouldApplyPersistedState }
}

export function makePermissionAutoAcceptStatePatch(
  previous: Map<string, boolean>,
  next: Map<string, boolean>,
): Record<string, boolean | null> {
  const patch: Record<string, boolean | null> = {}
  for (const key of previous.keys()) {
    if (!next.has(key)) patch[key] = null
  }
  for (const [key, value] of next) {
    if (value === true) patch[key] = true
  }
  return patch
}
