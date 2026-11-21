export interface DeveloperTargetSelector {
  nativeIdentity: string
  runId: string
  windowId: string
}

const component = /^[\w.:-]{1,128}$/

export function formatDeveloperTarget(target: DeveloperTargetSelector): string {
  return `${target.nativeIdentity}/${target.runId}/${target.windowId}`
}

export function parseDeveloperTarget(value: unknown): DeveloperTargetSelector {
  const pieces = typeof value === "string" ? value.split("/") : []
  if (pieces.length !== 3 || !pieces.every(part => component.test(part))) {
    throw new Error("Use a window identifier returned by inspect({targets:true})")
  }
  const [nativeIdentity, runId, windowId] = pieces
  return { nativeIdentity, runId, windowId }
}
