type RepliedPermission = { repliedAt: number; missingPasses: number }
const repliedPermissionIdsByInstance = new Map<string, Map<string, RepliedPermission>>()
const REPLIED_PERMISSION_TOMBSTONE_TTL_MS = 10 * 60 * 1_000
const MAX_REPLIED_PERMISSION_TOMBSTONES = 4_096

function pruneExpiredRepliedPermissions(replied: Map<string, RepliedPermission>, now: number): void {
  for (const [permissionId, state] of replied) {
    if (now - state.repliedAt < REPLIED_PERMISSION_TOMBSTONE_TTL_MS) break
    replied.delete(permissionId)
  }
}

function pruneRepliedPermissions(instanceId: string, remotePendingIds: Set<string>, syncStartedAt: number): void {
  const replied = repliedPermissionIdsByInstance.get(instanceId)
  if (!replied) return
  pruneExpiredRepliedPermissions(replied, syncStartedAt)
  for (const [permissionId, state] of replied) {
    if (remotePendingIds.has(permissionId)) {
      state.missingPasses = 0
      continue
    }
    // Only a sync started after the local reply can prove the server no longer
    // considers this permission pending. Keep it through one complete reconnect
    // snapshot so delayed events from that stream remain fenced.
    if (syncStartedAt < state.repliedAt) continue
    if (state.missingPasses > 0) replied.delete(permissionId)
    else state.missingPasses += 1
  }
  if (replied.size === 0) {
    repliedPermissionIdsByInstance.delete(instanceId)
  }
}

function markPermissionReplied(instanceId: string, permissionId: string, repliedAt = Date.now()): void {
  if (!permissionId) return
  let replied = repliedPermissionIdsByInstance.get(instanceId)
  if (!replied) {
    replied = new Map<string, RepliedPermission>()
    repliedPermissionIdsByInstance.set(instanceId, replied)
  }
  pruneExpiredRepliedPermissions(replied, repliedAt)
  replied.delete(permissionId)
  replied.set(permissionId, { repliedAt, missingPasses: 0 })
  while (replied.size > MAX_REPLIED_PERMISSION_TOMBSTONES) replied.delete(replied.keys().next().value!)
}

function hasRepliedPermission(instanceId: string, permissionId: string, now = Date.now()): boolean {
  const replied = repliedPermissionIdsByInstance.get(instanceId)
  if (!replied) return false
  pruneExpiredRepliedPermissions(replied, now)
  if (replied.size === 0) repliedPermissionIdsByInstance.delete(instanceId)
  return replied.has(permissionId)
}

function clearRepliedPermissions(instanceId: string): void {
  repliedPermissionIdsByInstance.delete(instanceId)
}

export { clearRepliedPermissions, hasRepliedPermission, markPermissionReplied, pruneRepliedPermissions }
