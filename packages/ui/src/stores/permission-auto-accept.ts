import { createSignal } from "solid-js"
import type { PermissionReply, PermissionRequestLike } from "../types/permission"
import { getPermissionSessionId } from "../types/permission"
import { getLogger } from "../lib/logger"
import {
  isYoloEligibleSubagentSession,
  shouldSubagentInheritPermissionAutoAcceptValue as shouldSubagentInheritPermissionAutoAcceptRule,
} from "./permission-auto-accept-rules"
import type { Session } from "../types/session"

const log = getLogger("api")

type AutoAcceptResponder = (instanceId: string, sessionId: string, requestId: string, reply: PermissionReply) => Promise<void>
type PendingPermissionChecker = (instanceId: string, requestId: string) => boolean
type AutoAcceptSession = Pick<Session, "id" | "parentId" | "revert">
type SessionProvider = () => Map<string, Map<string, AutoAcceptSession>>
type SessionPermissionDrainer = (instanceId: string, sessionId: string) => void

let sessionProvider: SessionProvider | null = null
let drainSessionPermissions: SessionPermissionDrainer = () => {}

export function registerPermissionAutoAcceptSessionProvider(provider: SessionProvider) {
  sessionProvider = provider
}

export function registerPermissionAutoAcceptPermissionDrainer(drainer: SessionPermissionDrainer) {
  drainSessionPermissions = drainer
}

function hasPermissionAutoAcceptState(instanceId: string, sessionId: string) {
  const state = autoAcceptState()
  return state.get(makeRuntimeKey(instanceId, sessionId)) ?? false
}

function makeRuntimeKey(instanceId: string, sessionId: string) {
  return `${instanceId}:${sessionId}`
}

const [autoAcceptState, setAutoAcceptState] = createSignal(new Map<string, boolean>())

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

  const key = makeRuntimeKey(instanceId, sessionId)
  setAutoAcceptState((prev) => {
    const currentlyEnabled = prev.get(key) === true
    if (currentlyEnabled === enabled) return prev

    const next = new Map(prev)
    if (enabled) {
      next.set(key, true)
    } else {
      next.delete(key)
    }
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
