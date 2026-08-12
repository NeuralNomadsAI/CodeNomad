import type { Session } from "../types/session"
import { workspaceDirectoriesEqual } from "./opencode-workspace-matching"

type SessionLocation = Pick<Session, "directory" | "workspaceId">

interface LocationAuthority {
  epoch: number
  expected?: SessionLocation
  previous?: SessionLocation
  serverUpdated?: number
}

const instanceEpochs = new Map<string, number>()
const authorities = new Map<string, Map<string, LocationAuthority>>()

function nextEpoch(instanceId: string): number {
  const epoch = (instanceEpochs.get(instanceId) ?? 0) + 1
  instanceEpochs.set(instanceId, epoch)
  return epoch
}

function setAuthority(instanceId: string, sessionId: string, authority: LocationAuthority): void {
  const instanceAuthorities = authorities.get(instanceId) ?? new Map<string, LocationAuthority>()
  instanceAuthorities.set(sessionId, authority)
  authorities.set(instanceId, instanceAuthorities)
}

export function captureSessionLocationEpoch(instanceId: string): number {
  return instanceEpochs.get(instanceId) ?? 0
}

export function setAuthoritativeSessionLocation(
  instanceId: string,
  sessionId: string,
  expected: SessionLocation,
  previous?: SessionLocation,
  serverUpdated?: number,
): void {
  setAuthority(instanceId, sessionId, { epoch: nextEpoch(instanceId), expected, previous, serverUpdated })
}

export function isSessionLocationHydrationCurrent(instanceId: string, sessionId: string, epoch: number): boolean {
  return (authorities.get(instanceId)?.get(sessionId)?.epoch ?? 0) <= epoch
}

export function protectHydratedSessionLocation(
  instanceId: string,
  incoming: Session,
  current: Session | undefined,
  epoch: number,
): Session {
  if (!current || isSessionLocationHydrationCurrent(instanceId, incoming.id, epoch)) return incoming
  return { ...incoming, directory: current.directory, workspaceId: current.workspaceId }
}

export function resolveSessionEventLocation(
  instanceId: string,
  sessionId: string,
  incoming: SessionLocation,
  current: SessionLocation | undefined,
  options: { hasDirectory?: boolean; hasWorkspaceId?: boolean; serverUpdated?: number } = {},
): SessionLocation {
  const authority = authorities.get(instanceId)?.get(sessionId)
  const hasDirectory = options.hasDirectory ?? incoming.directory !== undefined
  const hasWorkspaceId = options.hasWorkspaceId ?? incoming.workspaceId !== undefined
  const candidate = {
    directory: hasDirectory ? incoming.directory : current?.directory,
    workspaceId: hasWorkspaceId ? incoming.workspaceId : current?.workspaceId,
  }
  if (authority?.expected) {
    const expected = authority.expected
    const matches = hasDirectory
      && workspaceDirectoriesEqual(candidate.directory, expected.directory)
      && (!hasWorkspaceId || candidate.workspaceId === expected.workspaceId)
    const newer = options.serverUpdated !== undefined
      && authority.serverUpdated !== undefined
      && options.serverUpdated > authority.serverUpdated
    if (!matches && !newer) return current ?? expected
    setAuthority(instanceId, sessionId, { epoch: nextEpoch(instanceId), serverUpdated: options.serverUpdated })
    if (newer) return candidate
    return expected
  }
  const conflicts = Boolean(current) && (
    (hasDirectory && !workspaceDirectoriesEqual(candidate.directory, current?.directory))
    || (hasWorkspaceId && candidate.workspaceId !== current?.workspaceId)
  )
  if (conflicts && options.serverUpdated !== undefined && authority?.serverUpdated !== undefined
    && options.serverUpdated <= authority.serverUpdated) return current!
  setAuthority(instanceId, sessionId, { epoch: nextEpoch(instanceId), serverUpdated: options.serverUpdated ?? authority?.serverUpdated })
  return candidate
}

export function clearSessionLocationAuthority(instanceId: string, sessionId?: string): void {
  if (sessionId) {
    authorities.get(instanceId)?.delete(sessionId)
    return
  }
  authorities.delete(instanceId)
  instanceEpochs.delete(instanceId)
}
