interface ActiveWorkflowRefresh {
  revision?: number
  trailing: boolean
  promise: Promise<void>
}

export function createWorkflowRefreshCoordinator(refresh: (instanceId: string, runId: string, revision?: number) => Promise<void>) {
  const active = new Map<string, ActiveWorkflowRefresh>()

  return (instanceId: string, runId: string, revision?: number): Promise<void> => {
    const key = JSON.stringify([instanceId, runId])
    const current = active.get(key)
    if (current) {
      if (revision !== undefined && (current.revision === undefined || revision > current.revision)) {
        current.revision = revision
        current.trailing = true
      }
      return current.promise
    }

    const state: ActiveWorkflowRefresh = { revision, trailing: false, promise: Promise.resolve() }
    state.promise = (async () => {
      let failure: unknown
      do {
        state.trailing = false
        const revision = state.revision
        try {
          await refresh(instanceId, runId, revision)
          failure = undefined
        } catch (error) {
          failure = error
        }
      } while (state.trailing)
      if (failure !== undefined) throw failure
    })().finally(() => {
      if (active.get(key) === state) active.delete(key)
    })
    active.set(key, state)
    return state.promise
  }
}
