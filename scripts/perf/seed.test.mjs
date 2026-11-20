import assert from "node:assert/strict"
import { test } from "node:test"
import { seed, withSampleSessions } from "./seed.mjs"

test("a seed execution that became idle after failure cannot qualify an empty history", async () => {
  const daemon = {
    async call(method, route) {
      if (route === "/api/session") return { data: { id: "foreground" } }
      if (route === "/api/session/active") return { data: {} }
      if (method === "POST") return { data: { type: "user" } }
      return { data: { outcome: "failed" } }
    },
  }
  await assert.rejects(() => seed(daemon, 1, 1), /Seed turn failed/)
})

test("each sample forks the same inputs and removes only its own output sessions", async () => {
  let next = 0
  const requests = []
  const daemon = { async call(method, route, body) {
    requests.push([method, route, body])
    return method === "POST" ? { data: { id: `fork-${++next}` } } : undefined
  } }
  const sample = async () => withSampleSessions(daemon, ["seed-a", "seed-b"], async ids => ids)
  await sample()
  await sample()
  assert.deepEqual(requests.filter(([method]) => method === "POST").map(([, route]) => route),
    ["/api/session/seed-a/fork", "/api/session/seed-b/fork", "/api/session/seed-a/fork", "/api/session/seed-b/fork"])
  assert.deepEqual(requests.filter(([method]) => method === "DELETE").map(([, route]) => route),
    ["/api/session/fork-1", "/api/session/fork-2", "/api/session/fork-3", "/api/session/fork-4"])
})

test("sample cleanup attempts every removal and preserves the measurement failure", async () => {
  const attempts = []
  const primary = Error("measurement failed")
  let next = 0
  const daemon = { async call(method, route) {
    if (method === "POST") return { data: { id: `fork-${++next}` } }
    if (method === "DELETE") {
      attempts.push(route)
      if (attempts.length === 1) throw Error("cleanup failed")
    }
  } }
  await assert.rejects(() => withSampleSessions(daemon, ["a", "b"], async () => { throw primary }), error => error.cause === primary)
  assert.deepEqual(attempts, ["/api/session/fork-1", "/api/session/fork-2"])
})
