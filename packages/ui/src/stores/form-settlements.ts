const settledFormIdsByInstance = new Map<string, Map<string, number>>()

export function markFormSettled(instanceId: string, formId: string, settledAt = Date.now()): void {
  const settled = settledFormIdsByInstance.get(instanceId) ?? new Map<string, number>()
  settled.set(formId, settledAt)
  settledFormIdsByInstance.set(instanceId, settled)
}

export function hasSettledForm(instanceId: string, formId: string): boolean {
  return settledFormIdsByInstance.get(instanceId)?.has(formId) ?? false
}

export function pruneSettledForms(instanceId: string, remotePendingIds: Set<string>, syncStartedAt: number): void {
  const settled = settledFormIdsByInstance.get(instanceId)
  if (!settled) return
  for (const [formId, settledAt] of settled) {
    if (!remotePendingIds.has(formId) && syncStartedAt >= settledAt) settled.delete(formId)
  }
  if (!settled.size) settledFormIdsByInstance.delete(instanceId)
}

export function clearSettledForms(instanceId: string): void {
  settledFormIdsByInstance.delete(instanceId)
}
