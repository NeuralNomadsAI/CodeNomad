type State = { active: boolean; waiters: Array<() => void> }

const states = new Map<string, State>()

export function isPromptControlMutation(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") return false
  return /^\/(?:api\/)?session\/[^/]+\/(?:abort|permission\/[^/]+\/reply|question\/[^/]+\/(?:reply|reject))$/.test(path)
    || /^\/(?:permission\/[^/]+\/reply|question\/[^/]+\/(?:reply|reject))$/.test(path)
}

export function isForbiddenDirectWorktreeMutation(method: string, path: string): boolean {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase())) return false
  return path === "/experimental/control-plane/move-session" || path === "/experimental/worktree"
}

export async function acquireWorkspaceMutation(instanceId: string, signal?: AbortSignal): Promise<() => void> {
  const state = states.get(instanceId) ?? { active: false, waiters: [] }
  states.set(instanceId, state)
  signal?.throwIfAborted()
  if (state.active) {
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }
      const abort = () => {
        const index = state.waiters.indexOf(start)
        if (index >= 0) state.waiters.splice(index, 1)
        reject(signal?.reason)
      }
      state.waiters.push(start)
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
  state.active = true
  let released = false
  return () => {
    if (released) return
    released = true
    const next = state.waiters.shift()
    if (next) next()
    else {
      state.active = false
      states.delete(instanceId)
    }
  }
}
