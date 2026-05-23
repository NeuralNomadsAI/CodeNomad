import { createSignal } from "solid-js"
import type { PermissionReply, PermissionRequestLike } from "../types/permission"
import { getPermissionSessionId } from "../types/permission"
import { getLogger } from "../lib/logger"
import { storage } from "../lib/storage"
import {
  isYoloEligibleSubagentSession,
  shouldSubagentInheritPermissionAutoAcceptValue as shouldSubagentInheritPermissionAutoAcceptRule,
} from "./permission-auto-accept-rules"
import {
  createPermissionAutoAcceptServerPersistence,
  makePermissionAutoAcceptScope,
  makePermissionAutoAcceptStateKey,
  mergeUnmigratedPermissionAutoAcceptState,
  migrateLegacyPermissionAutoAcceptState,
  readPersistedPermissionAutoAcceptState,
  serializePermissionAutoAcceptState,
} from "./permission-auto-accept-persistence"
import type { Session } from "../types/session"

const STORAGE_KEY = "codenomad:permission-auto-accept:v1"
const PERSISTED_STATE_OWNER = "ui"

const log = getLogger("api")

type AutoAcceptResponder = (instanceId: string, sessionId: string, requestId: string, reply: PermissionReply) => Promise<void>
type PendingPermissionChecker = (instanceId: string, requestId: string) => boolean
type AutoAcceptSession = Pick<Session, "id" | "parentId" | "revert">
type SessionProvider = () => Map<string, Map<string, AutoAcceptSession>>
type SessionPermissionDrainer = (instanceId: string, sessionId: string) => void

const scopeByInstanceId = new Map<string, string>()
let sessionProvider: SessionProvider | null = null
let drainSessionPermissions: SessionPermissionDrainer = () => {}

export function registerPermissionAutoAcceptSessionProvider(provider: SessionProvider) {
  sessionProvider = provider
}

export function registerPermissionAutoAcceptPermissionDrainer(drainer: SessionPermissionDrainer) {
  drainSessionPermissions = drainer
}

export function registerPermissionAutoAcceptScope(instanceId: string, workspacePath: string) {
  if (!instanceId || !workspacePath) return
  const scope = makePermissionAutoAcceptScope(workspacePath)
  scopeByInstanceId.set(instanceId, scope)

  setAutoAcceptState((prev) => {
    const next = migrateLegacyPermissionAutoAcceptState(prev, instanceId, scope)
    if (!next) return prev
    persist(next)
    persistToServer(next, prev)
    return next
  })
  syncAllInheritedPermissionAutoAccept()
}

export function unregisterPermissionAutoAcceptScope(instanceId: string) {
  scopeByInstanceId.delete(instanceId)
}

function getPermissionAutoAcceptScope(instanceId: string) {
  return scopeByInstanceId.get(instanceId) ?? null
}

function migrateKnownPermissionAutoAcceptScopes(state: Map<string, boolean>) {
  let current = state
  let changed = false
  for (const [instanceId, scope] of scopeByInstanceId) {
    const next = migrateLegacyPermissionAutoAcceptState(current, instanceId, scope)
    if (!next) continue
    current = next
    changed = true
  }
  return changed ? current : state
}

function hasPermissionAutoAcceptState(instanceId: string, sessionId: string) {
  const scope = getPermissionAutoAcceptScope(instanceId)
  const state = autoAcceptState()
  const key = scope ? makePermissionAutoAcceptStateKey(scope, sessionId) : makeRuntimeKey(instanceId, sessionId)
  return state.get(key) ?? false
}

function makeRuntimeKey(instanceId: string, sessionId: string) {
  return `${instanceId}:${sessionId}`
}

function readInitialState() {
  if (typeof window === "undefined" || !window.localStorage) {
    return new Map<string, boolean>()
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return new Map<string, boolean>()
    const parsed = JSON.parse(raw) as Record<string, boolean>
    return new Map(Object.entries(parsed).filter((entry): entry is [string, boolean] => entry[1] === true))
  } catch {
    return new Map<string, boolean>()
  }
}

function persist(next: Map<string, boolean>) {
  if (typeof window === "undefined" || !window.localStorage) {
    return
  }

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(serializePermissionAutoAcceptState(next)))
  } catch {
    // ignore persistence failures
  }
}

const serverPersistence = createPermissionAutoAcceptServerPersistence({
  owner: PERSISTED_STATE_OWNER,
  patchStateOwner: (owner, patch) => storage.patchStateOwner(owner, patch),
  applyPersistedBucket: applyPersistedPermissionAutoAcceptState,
  logError: (message, error) => log.error(message, error),
})

function persistToServer(next: Map<string, boolean>, previous = new Map<string, boolean>()) {
  serverPersistence.persistToServer(next, previous)
}

const [autoAcceptState, setAutoAcceptState] = createSignal(readInitialState())

function applyPersistedPermissionAutoAcceptState(bucket: Record<string, unknown>) {
  const persisted = readPersistedPermissionAutoAcceptState(bucket)
  if (!persisted) {
    const current = autoAcceptState()
    if (current.size > 0) persistToServer(current)
    return
  }

  const merged = mergeUnmigratedPermissionAutoAcceptState(persisted, autoAcceptState())
  const migrated = migrateKnownPermissionAutoAcceptScopes(merged)
  setAutoAcceptState(migrated)
  persist(migrated)
  syncAllInheritedPermissionAutoAccept()
  if (migrated !== merged) persistToServer(migrated, persisted)
}

storage.onStateOwnerChanged(PERSISTED_STATE_OWNER, (bucket) => {
  const persisted = readPersistedPermissionAutoAcceptState(bucket)
  if (!serverPersistence.shouldApplyPersistedState(persisted)) return
  applyPersistedPermissionAutoAcceptState(bucket)
})

const inFlight = new Set<string>()
const inheritedParentBySession = new Map<string, string>()
const manuallyDisabledInheritedSessions = new Set<string>()

export function isPermissionAutoAcceptEnabled(instanceId: string, sessionId: string) {
  return hasPermissionAutoAcceptState(instanceId, sessionId)
}

function getInheritanceKey(instanceId: string, sessionId: string) {
  return makeRuntimeKey(instanceId, sessionId)
}

function setPermissionAutoAcceptEnabledInternal(
  instanceId: string,
  sessionId: string,
  enabled: boolean,
  options: { inheritedFromParentId?: string | null; manual?: boolean } = {},
) {
  const inheritanceKey = getInheritanceKey(instanceId, sessionId)
  if (enabled) {
    if (options.inheritedFromParentId) {
      inheritedParentBySession.set(inheritanceKey, options.inheritedFromParentId)
      manuallyDisabledInheritedSessions.delete(inheritanceKey)
    }
  } else if (options.manual !== false && inheritedParentBySession.has(inheritanceKey)) {
    manuallyDisabledInheritedSessions.add(inheritanceKey)
  } else if (options.manual === false) {
    inheritedParentBySession.delete(inheritanceKey)
    manuallyDisabledInheritedSessions.delete(inheritanceKey)
  }

  const scope = getPermissionAutoAcceptScope(instanceId)
  const key = scope ? makePermissionAutoAcceptStateKey(scope, sessionId) : makeRuntimeKey(instanceId, sessionId)
  setAutoAcceptState((prev) => {
    const currentlyEnabled = prev.get(key) === true
    if (currentlyEnabled === enabled) return prev

    const next = new Map(prev)
    if (enabled) {
      next.set(key, true)
    } else {
      next.delete(key)
    }
    persist(next)
    if (scope) persistToServer(next, prev)
    return next
  })
  if (!enabled) {
    clearAutoAcceptSession(instanceId, sessionId)
  }
}

export function setPermissionAutoAcceptEnabled(instanceId: string, sessionId: string, enabled: boolean) {
  setPermissionAutoAcceptEnabledInternal(instanceId, sessionId, enabled)
}

export function togglePermissionAutoAccept(instanceId: string, sessionId: string) {
  setPermissionAutoAcceptEnabled(instanceId, sessionId, !isPermissionAutoAcceptEnabled(instanceId, sessionId))
}

function makeRequestKey(instanceId: string, sessionId: string, requestId: string) {
  return `${makeRuntimeKey(instanceId, sessionId)}:${requestId}`
}

export function shouldSubagentInheritPermissionAutoAccept(
  instanceId: string,
  session: Pick<Session, "parentId" | "revert">,
) {
  return shouldSubagentInheritPermissionAutoAcceptRule(
    session,
    Boolean(session.parentId && isPermissionAutoAcceptEnabled(instanceId, session.parentId)),
  )
}

export function adoptSubagentPermissionAutoAccept(instanceId: string, session: Pick<Session, "id" | "parentId" | "revert">) {
  if (!shouldSubagentInheritPermissionAutoAccept(instanceId, session)) return false
  setPermissionAutoAcceptEnabledInternal(instanceId, session.id, true, { inheritedFromParentId: session.parentId })
  return true
}

export function syncInheritedPermissionAutoAcceptForChildren(
  instanceId: string,
  parentSessionId: string,
  sessions?: Iterable<AutoAcceptSession>,
  drainPermissions: SessionPermissionDrainer = drainSessionPermissions,
) {
  const instanceSessions = sessions ?? sessionProvider?.().get(instanceId)?.values()
  if (!instanceSessions) return

  const parentEnabled = isPermissionAutoAcceptEnabled(instanceId, parentSessionId)
  const sessionList = Array.isArray(instanceSessions) ? instanceSessions : Array.from(instanceSessions)

  for (const session of sessionList) {
    if (session.parentId !== parentSessionId || !isYoloEligibleSubagentSession(session)) continue

    const inheritanceKey = getInheritanceKey(instanceId, session.id)
    if (parentEnabled) {
      if (manuallyDisabledInheritedSessions.has(inheritanceKey)) continue

      const wasEnabled = isPermissionAutoAcceptEnabled(instanceId, session.id)
      setPermissionAutoAcceptEnabledInternal(instanceId, session.id, true, {
        inheritedFromParentId: parentSessionId,
        manual: false,
      })
      if (!wasEnabled) drainPermissions(instanceId, session.id)
      continue
    }

    setPermissionAutoAcceptEnabledInternal(instanceId, session.id, false, { manual: false })
    syncInheritedPermissionAutoAcceptForChildren(instanceId, session.id, sessionList, drainPermissions)
  }
}

export function syncAllInheritedPermissionAutoAccept() {
  const allSessions = sessionProvider?.()
  if (!allSessions) return

  for (const [instanceId, instanceSessions] of allSessions) {
    for (const session of instanceSessions.values()) {
      syncInheritedPermissionAutoAcceptForChildren(instanceId, session.id, instanceSessions.values())
    }
  }
}

export function clearAutoAcceptPermission(instanceId: string, sessionId: string, requestId: string) {
  const requestKey = makeRequestKey(instanceId, sessionId, requestId)
  inFlight.delete(requestKey)
}

export function clearAutoAcceptSession(instanceId: string, sessionId: string) {
  const prefix = `${makeRuntimeKey(instanceId, sessionId)}:`
  for (const requestKey of Array.from(inFlight)) {
    if (requestKey.startsWith(prefix)) {
      inFlight.delete(requestKey)
    }
  }
}

export function drainAutoAcceptPermission(
  instanceId: string,
  permission: PermissionRequestLike,
  responder: AutoAcceptResponder,
  isPending: PendingPermissionChecker,
) {
  const sessionId = getPermissionSessionId(permission)
  if (!sessionId || !permission?.id) return
  if (!isPermissionAutoAcceptEnabled(instanceId, sessionId)) return
  if (!isPending(instanceId, permission.id)) return

  const requestKey = makeRequestKey(instanceId, sessionId, permission.id)
  if (inFlight.has(requestKey)) return

  inFlight.add(requestKey)

  void responder(instanceId, sessionId, permission.id, "once")
    .catch((error) => {
      log.error("Failed to auto-accept permission", error)
    })
    .finally(() => {
      inFlight.delete(requestKey)
    })
}

export function drainAutoAcceptPermissions(
  instanceId: string,
  permissions: PermissionRequestLike[],
  responder: AutoAcceptResponder,
  isPending: PendingPermissionChecker,
) {
  for (const permission of permissions) {
    drainAutoAcceptPermission(instanceId, permission, responder, isPending)
  }
}
