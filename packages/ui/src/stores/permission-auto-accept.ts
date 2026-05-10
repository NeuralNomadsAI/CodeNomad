import { createSignal } from "solid-js"
import type { PermissionReply, PermissionRequestLike } from "../types/permission"
import { getPermissionSessionId } from "../types/permission"
import { getLogger } from "../lib/logger"

const STORAGE_KEY = "codenomad:permission-auto-accept:v1"

const log = getLogger("api")

type AutoAcceptResponder = (instanceId: string, sessionId: string, requestId: string, reply: PermissionReply) => Promise<void>
type PendingPermissionChecker = (instanceId: string, requestId: string) => boolean

function makeKey(instanceId: string, sessionId: string) {
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
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(next)))
  } catch {
    // ignore persistence failures
  }
}

const [autoAcceptState, setAutoAcceptState] = createSignal(readInitialState())

const inFlight = new Set<string>()

export function isPermissionAutoAcceptEnabled(instanceId: string, sessionId: string) {
  return autoAcceptState().get(makeKey(instanceId, sessionId)) ?? false
}

export function setPermissionAutoAcceptEnabled(instanceId: string, sessionId: string, enabled: boolean) {
  const key = makeKey(instanceId, sessionId)
  setAutoAcceptState((prev) => {
    const next = new Map(prev)
    if (enabled) {
      next.set(key, true)
    } else {
      next.delete(key)
    }
    persist(next)
    return next
  })
  if (!enabled) {
    clearAutoAcceptSession(instanceId, sessionId)
  }
}

export function togglePermissionAutoAccept(instanceId: string, sessionId: string) {
  setPermissionAutoAcceptEnabled(instanceId, sessionId, !isPermissionAutoAcceptEnabled(instanceId, sessionId))
}

function makeRequestKey(instanceId: string, sessionId: string, requestId: string) {
  return `${makeKey(instanceId, sessionId)}:${requestId}`
}

export function clearAutoAcceptPermission(instanceId: string, sessionId: string, requestId: string) {
  const requestKey = makeRequestKey(instanceId, sessionId, requestId)
  inFlight.delete(requestKey)
}

export function clearAutoAcceptSession(instanceId: string, sessionId: string) {
  const prefix = `${makeKey(instanceId, sessionId)}:`
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
