export interface DeveloperTargetSelector {
  nativeIdentity: string
  runId: string
  windowId: string
  windowInstance?: string
}

const component = /^[\w.:-]{1,128}$/

export function formatDeveloperTarget(target: DeveloperTargetSelector): string {
  return `${target.nativeIdentity}/${target.runId}/${target.windowId}${target.windowInstance ? `/${target.windowInstance}` : ""}`
}

export function parseDeveloperTarget(value: unknown): DeveloperTargetSelector {
  const pieces = typeof value === "string" ? value.split("/") : []
  if ((pieces.length !== 3 && pieces.length !== 4) || !pieces.every(part => component.test(part))) {
    throw new Error("Use a window identifier returned by inspect({targets:true})")
  }
  const [nativeIdentity, runId, windowId, windowInstance] = pieces
  return { nativeIdentity, runId, windowId, ...(windowInstance ? { windowInstance } : {}) }
}
