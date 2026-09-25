type WorkspaceLoadResult = { error?: unknown }

export async function waitForLatestWorkspaceLoadResult(
  initial: Promise<WorkspaceLoadResult>,
  getLatest: () => Promise<WorkspaceLoadResult>,
  waitForChange: (current: Promise<WorkspaceLoadResult>, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let load = initial
  while (true) {
    signal?.throwIfAborted()
    const latest = getLatest()
    if (load !== latest) {
      load = latest
      continue
    }
    const changeController = new AbortController()
    const abortChangeWait = () => changeController.abort(signal?.reason)
    signal?.addEventListener("abort", abortChangeWait, { once: true })
    let outcome: { type: "result"; result: WorkspaceLoadResult } | { type: "change" }
    try {
      outcome = await Promise.race([
        load.then((result) => ({ type: "result" as const, result })),
        waitForChange(load, changeController.signal).then(() => ({ type: "change" as const })),
      ])
    } finally {
      signal?.removeEventListener("abort", abortChangeWait)
      changeController.abort()
    }
    if (outcome.type === "change") continue
    const result = outcome.result
    if (load !== getLatest()) continue
    if (result.error !== undefined) throw result.error
    return
  }
}
