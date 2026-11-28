import type { DeveloperTargetSelector as DeveloperTarget } from "./developer-target-selector"
export type { DeveloperTarget }

export interface DeveloperRestart extends DeveloperTarget {
  restartId: string
}

export const restartIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/

export function readDeveloperTarget(value: unknown): DeveloperTarget | undefined {
  if (!value || typeof value !== "object") return
  const { runId, nativeIdentity, windowId, windowInstance } = value as Partial<DeveloperTarget>
  if (typeof runId === "string" && runId.length > 0 && runId.length <= 128
    && typeof nativeIdentity === "string" && nativeIdentity.length > 0 && nativeIdentity.length <= 128
    && typeof windowId === "string" && windowId.length > 0 && windowId.length <= 128
    && (windowInstance === undefined || typeof windowInstance === "string" && windowInstance.length > 0 && windowInstance.length <= 128)) {
    return { runId, nativeIdentity, windowId, ...(windowInstance ? { windowInstance } : {}) }
  }
}

export function readDeveloperRestart(value: unknown): DeveloperRestart | undefined {
  const target = readDeveloperTarget(value)
  if (!target || Object.keys(value as object).length !== (target.windowInstance ? 5 : 4)) return
  const { restartId } = value as Partial<DeveloperRestart>
  if (typeof restartId === "string" && restartIdPattern.test(restartId)) return { ...target, restartId }
}

export function sameDeveloperTarget(a: DeveloperTarget, b: DeveloperTarget): boolean {
  return a.nativeIdentity === b.nativeIdentity && a.runId === b.runId && a.windowId === b.windowId
    && a.windowInstance === b.windowInstance
}

export function isRestartSuccessor(expected: DeveloperRestart, target: DeveloperTarget, restartId: unknown): boolean {
  return restartId === expected.restartId && target.nativeIdentity === expected.nativeIdentity
    && target.runId !== expected.runId && target.windowId === expected.windowId
    && (target.windowInstance === undefined || target.windowInstance !== expected.windowInstance)
}
