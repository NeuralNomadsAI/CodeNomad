import { createSignal } from "solid-js"
import { instances } from "./instances"
import { locationAuthorityKey } from "./request-locations"
import { nativeSessionLifecycleGeneration } from "./session-events"
import { sessions } from "./session-state"

const GRACE_MS = 15_000
const pending = new Map<string, { current: () => boolean; expires: number }>()
const [revision, setRevision] = createSignal(0)

function scope(instanceId: string, sessionId: string) {
  const instance = instances().get(instanceId)
  const session = sessions().get(instanceId)?.get(sessionId)
  if (!instance?.client || instance.status !== "ready" || !session?.location?.directory || session.catalogSnapshot) return
  const key = JSON.stringify([instanceId, sessionId, instance.folder, instance.proxyPath, locationAuthorityKey(session.location)])
  return { key, client: instance.client, session }
}

export function sessionPromptAwaitingExecution(instanceId: string, sessionId: string): boolean {
  revision()
  const identity = scope(instanceId, sessionId)
  const entry = identity && pending.get(identity.key)
  return !!entry && entry.current() && performance.now() < entry.expires
}

/** Capture the native admission boundary before dispatch; record only a confirmed steer. */
export function capturePromptAcknowledgement(instanceId: string, sessionId: string) {
  const identity = scope(instanceId, sessionId)
  const admission = identity?.session.generationAdmissionEpoch
  if (!identity || admission === undefined) return
  const generation = nativeSessionLifecycleGeneration(instanceId, sessionId)
  const idle = identity.session.time.idle ?? 0
  const current = () => {
    const latest = scope(instanceId, sessionId)
    return latest?.key === identity.key && latest.client === identity.client
      && nativeSessionLifecycleGeneration(instanceId, sessionId) === generation
      && (latest.session.time.idle ?? 0) <= idle && (latest.session.idleReadAdmissionEpoch ?? 0) < admission
  }
  return () => {
    if (!current()) return
    const entry = { current, expires: performance.now() + GRACE_MS }
    pending.set(identity.key, entry)
    setRevision(value => value + 1)
    setTimeout(() => {
      if (pending.get(identity.key) !== entry) return
      pending.delete(identity.key)
      setRevision(value => value + 1)
    }, GRACE_MS)
  }
}
