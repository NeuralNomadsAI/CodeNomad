// Guards for isolated fixture-owned children and native acceptance pagination.
async function completesWithin(promise, timeoutMs) {
  let timer
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

export async function stopFixtureChild(child, stopped, graceMs = 1_000, forceMs = 2_000) {
  child.kill()
  if (await completesWithin(stopped, graceMs)) return
  child.kill("SIGKILL")
  if (await completesWithin(stopped, forceMs)) return
  // A failed OS kill must report failure rather than retaining test handles.
  child.stdout?.destroy()
  child.stderr?.destroy()
  child.stdin?.destroy()
  child.unref()
  throw new Error(`Fixture-owned child ${child.pid} did not exit after forced termination`)
}

export function fixturePaginationGuard() {
  const seen = new Set()
  return cursor => {
    if (seen.has(cursor)) throw new Error("Native fixture pagination repeated a nonterminal cursor")
    seen.add(cursor)
  }
}
