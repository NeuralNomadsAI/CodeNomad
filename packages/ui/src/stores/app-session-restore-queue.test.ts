import assert from "node:assert/strict"
import { it } from "node:test"
import { runWithSerializedCommits } from "./app-session-restore-queue.ts"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

it("starts create requests concurrently but commits mounts in saved order", async () => {
  const requests = [deferred(), deferred(), deferred()]
  const hydrations = [deferred(), deferred(), deferred()]
  const started: number[] = []
  const commits: number[] = []
  let mounted = 0
  const restoration = runWithSerializedCommits([0, 1, 2], async (index, waitForCommit, finishCommit) => {
    started.push(index)
    await requests[index]!.promise
    await waitForCommit
    mounted += 1
    assert.equal(mounted, 1, "workspace mounts never overlap")
    commits.push(index)
    await Promise.resolve()
    mounted -= 1
    finishCommit()
    await hydrations[index]!.promise
  })

  assert.deepEqual(started, [0, 1, 2], "all network requests start without waiting for a prior mount")
  requests[2]!.resolve(); requests[1]!.resolve()
  await Promise.resolve()
  assert.deepEqual(commits, [], "later responses wait for their saved-order commit turn")
  requests[0]!.resolve()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(commits, [0, 1, 2], "post-mount hydration does not hold the commit queue")
  hydrations.forEach(({ resolve }) => resolve())
  await restoration
})
