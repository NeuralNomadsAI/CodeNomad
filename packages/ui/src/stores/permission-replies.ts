const repliedPermissionIdsByInstance = new Map<string, Map<string, number>>()

function pruneRepliedPermissions(instanceId: string, remotePendingIds: Set<string>, syncStartedAt: number): void {
  const replied = repliedPermissionIdsByInstance.get(instanceId)
  if (!replied) return
  for (const [permissionId, repliedAt] of replied) {
    // Only a sync started after the local reply can prove the server no longer
    // considers this permission pending.
    if (!remotePendingIds.has(permissionId) && syncStartedAt >= repliedAt) {
      replied.delete(permissionId)
    }
  }
  if (replied.size === 0) {
    repliedPermissionIdsByInstance.delete(instanceId)
  }
}

function markPermissionReplied(instanceId: string, permissionId: string, repliedAt = Date.now()): void {
  if (!permissionId) return
  let replied = repliedPermissionIdsByInstance.get(instanceId)
  if (!replied) {
    replied = new Map()
    repliedPermissionIdsByInstance.set(instanceId, replied)
  }
  replied.set(permissionId, repliedAt)
}

function hasRepliedPermission(instanceId: string, permissionId: string): boolean {
  const replied = repliedPermissionIdsByInstance.get(instanceId)
  if (!replied) return false
  return replied.has(permissionId)
}

function clearRepliedPermissions(instanceId: string): void {
  repliedPermissionIdsByInstance.delete(instanceId)
}

export { clearRepliedPermissions, hasRepliedPermission, markPermissionReplied, pruneRepliedPermissions }
