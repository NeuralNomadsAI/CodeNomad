import { createSignal } from "solid-js"
import type { PermissionRequest } from "../types/permission"
import { getFormQueue, type FormWithLocation } from "./forms"
import { instances, isWorkspaceClosing, getPermissionQueue, capturePendingLiveConnection, isPendingCapabilityMetadataCurrent } from "./instances"
import { sessions, captureSessionPlacementAuthority } from "./session-state"
import { captureInstanceRequestAuthority, captureSessionRequestAuthority } from "./session-api"
import type { RequestLocation } from "./request-locations"
import { getOpenCodeInstanceGeneration } from "./opencode-data"
import type { InstanceEventContext } from "../lib/server-events"

type Kind = "permission" | "form"
type Request = PermissionRequest | FormWithLocation
type Authority = { signature: string; current: () => boolean; location?: RequestLocation; connectionGeneration?: number }
const [authorities, setAuthorities] = createSignal(new Map<string, Authority>())
const key = (instanceId: string, kind: Kind, id: string) => JSON.stringify([instanceId, kind, id])

export function isLiveOnlyInterruption(instanceId: string): boolean {
  const instance = instances().get(instanceId)
  return Boolean(instance?.binding && instance.binding.serverId !== "local-shared")
}

/** Admission belongs to the exact live request, independently of its retained editor. */
export function admitInterruption(instanceId: string, kind: Kind, request: Request, location?: RequestLocation, live = false, context?: InstanceEventContext): void {
  if (isLiveOnlyInterruption(instanceId) && !live) return
  const instance = instances().get(instanceId)
  const explicit = isLiveOnlyInterruption(instanceId)
  const generation = getOpenCodeInstanceGeneration(instanceId), client = instance?.client, serverId = instance?.binding?.serverId,
    directory = instance?.binding?.directory, folder = instance?.folder
  const owner = explicit ? () => {
    const live = instances().get(instanceId)
    return Boolean(live && live.client === client && live.binding?.serverId === serverId && live.binding?.directory === directory
      && live.folder === folder && getOpenCodeInstanceGeneration(instanceId) === generation)
  } : captureInstanceRequestAuthority(instanceId)
  const session = sessions().get(instanceId)?.get(request.sessionID)
  const sessionCurrent = !explicit && session ? captureSessionRequestAuthority(instanceId, request.sessionID) : owner
  const capturedLocation = location ? { ...location } : session?.location ? { ...session.location } : undefined
  const placementOwner = request.sessionID === "global" ? () => true
    : captureSessionPlacementAuthority(instanceId, request.sessionID, capturedLocation)
  const connectionGeneration = context?.source?.connectionGeneration
  const connectionCurrent = explicit ? capturePendingLiveConnection(instanceId, context) : () => true
  if (explicit && (!context || !connectionCurrent())) return
  const placementCurrent = () => {
    const live = sessions().get(instanceId)?.get(request.sessionID)
    return placementOwner() && (!session || Boolean(live)) && (!live || !capturedLocation || (live.location?.directory === capturedLocation.directory
      && live.location?.workspaceID === capturedLocation.workspaceID))
  }
  const current = () => Boolean(instance?.client && owner() && sessionCurrent() && connectionCurrent() && !isWorkspaceClosing(instanceId)
    && instances().get(instanceId)?.status === "ready" && placementCurrent()
    && (!explicit || (instances().get(instanceId)?.capabilities?.features?.[kind === "permission" ? "permissions" : "questions"]?.state === "available"
      && isPendingCapabilityMetadataCurrent(instanceId)
      && instances().get(instanceId)?.capabilities?.serverId === serverId
      && Number.isSafeInteger(connectionGeneration) && connectionGeneration! > 0
      && instances().get(instanceId)?.capabilities?.generation === connectionGeneration
      && capturedLocation?.directory === instance.binding?.directory && capturedLocation?.workspaceID === undefined)))
  setAuthorities(previous => new Map(previous).set(key(instanceId, kind, request.id), {
    signature: JSON.stringify(request), current, location: capturedLocation, connectionGeneration: explicit ? connectionGeneration : undefined,
  }))
}

/** Matching late metadata qualifies only candidates already captured from that connection. */
export function retireIncompatibleInterruptionAuthority(instanceId: string, connectionGeneration: number | undefined): void {
  setAuthorities(previous => {
    const next = new Map(previous)
    for (const [entry, authority] of previous) if (JSON.parse(entry)[0] === instanceId && authority.connectionGeneration !== connectionGeneration) next.delete(entry)
    return next.size === previous.size ? previous : next
  })
}

export function retireInterruptionAuthority(instanceId: string, kind?: Kind, id?: string, reversible = false): () => void {
  const retired = new Map<string, { previous: Authority; marker: Authority }>()
  setAuthorities(previous => {
    const next = new Map(previous)
    for (const entry of previous.keys()) {
      const [owner, entryKind, entryId] = JSON.parse(entry)
      if (owner === instanceId && (!kind || kind === entryKind) && (!id || id === entryId)) {
        if (reversible) {
          const saved = previous.get(entry)!, marker = { ...saved, current: () => false }
          retired.set(entry, { previous: saved, marker })
          next.set(entry, marker)
        } else next.delete(entry)
      }
    }
    return retired.size || next.size !== previous.size ? next : previous
  })
  return () => setAuthorities(previous => {
    const next = new Map(previous)
    for (const [entry, saved] of retired) {
      const [, kind, id] = JSON.parse(entry)
      const request = (kind === "form" ? getFormQueue(instanceId) : getPermissionQueue(instanceId)).find(item => item.id === id)
      if (previous.get(entry) === saved.marker && saved.previous.current() && JSON.stringify(request) === saved.previous.signature) next.set(entry, saved.previous)
    }
    return next
  })
}

export function captureInterruptionAuthority(instanceId: string, kind: Kind, request: Request) {
  const identity = key(instanceId, kind, request.id)
  const authority = authorities().get(identity)
  const current = () => Boolean(authority && authorities().get(identity) === authority && authority.current()
    && JSON.stringify(request) === authority.signature)
  return { current, location: authority?.location }
}

export function canAnswerInterruption(instanceId: string, kind: Kind, request: Request | undefined): boolean {
  return Boolean(request && captureInterruptionAuthority(instanceId, kind, request).current())
}

/** Even a same-payload native event supersedes an older explicit read. */
export function captureInterruptionRevision(instanceId: string, kind: Kind, id: string): () => boolean {
  const identity = key(instanceId, kind, id), captured = authorities().get(identity)
  return () => authorities().get(identity) === captured
}

export function publishVerifiedFormAuthority(instanceId: string, form: FormWithLocation, location: RequestLocation, current: () => boolean, pending: boolean): () => boolean {
  const identity = key(instanceId, "form", form.id)
  const authority: Authority = { signature: JSON.stringify(form), location, current: () => pending && current(),
    connectionGeneration: instances().get(instanceId)?.capabilities?.generation }
  setAuthorities(previous => new Map(previous).set(identity, authority))
  return () => authorities().get(identity) === authority && current()
}
