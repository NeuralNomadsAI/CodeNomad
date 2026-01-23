import { createSignal } from "solid-js"

export interface GitStatus {
  branch?: string
  ahead?: number
  behind?: number
  staged?: number
  unstaged?: number
  untracked?: number
}

const [gitStatusByInstance, setGitStatusByInstance] = createSignal<Map<string, GitStatus>>(new Map())

export function getGitStatus(instanceId: string): GitStatus | undefined {
  return gitStatusByInstance().get(instanceId)
}

export function setGitStatus(instanceId: string, status: GitStatus): void {
  setGitStatusByInstance((prev) => {
    const next = new Map(prev)
    next.set(instanceId, status)
    return next
  })
}

export function clearGitStatus(instanceId: string): void {
  setGitStatusByInstance((prev) => {
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
}
