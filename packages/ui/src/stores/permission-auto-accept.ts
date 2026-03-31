import { createSignal } from "solid-js"

const STORAGE_KEY = "codenomad:permission-auto-accept:v1"

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
const [inFlightVersion, setInFlightVersion] = createSignal(0)

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
}

export function togglePermissionAutoAccept(instanceId: string, sessionId: string) {
  setPermissionAutoAcceptEnabled(instanceId, sessionId, !isPermissionAutoAcceptEnabled(instanceId, sessionId))
}

export function canAutoRespondPermission(instanceId: string, sessionId: string, requestId: string) {
  const key = makeKey(instanceId, sessionId)
  if (!autoAcceptState().get(key)) return false
  const requestKey = `${key}:${requestId}`
  if (inFlight.has(requestKey)) return false
  inFlight.add(requestKey)
  return true
}

export function getPermissionAutoAcceptInFlightVersion() {
  return inFlightVersion()
}

export function finishAutoRespondPermission(instanceId: string, sessionId: string, requestId: string) {
  if (!inFlight.delete(`${makeKey(instanceId, sessionId)}:${requestId}`)) {
    return
  }
  setInFlightVersion((value) => value + 1)
}
