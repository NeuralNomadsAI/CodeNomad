import assert from "node:assert/strict"
import test from "node:test"
import { ServerEvents } from "./server-events"
import { serverApi } from "./api-client"

test("actual event transport rejects forged grants and irreversibly retires old callbacks and owners", async t => {
  const callbacks: Array<(payload: unknown) => void> = []
  let closed = 0
  t.mock.method(serverApi, "connectEvents", (...args: Parameters<typeof serverApi.connectEvents>) => {
    callbacks.push(args[3]!)
    return { close() { closed++ } } as unknown as EventSource
  })
  const events = new ServerEvents()
  const native = events as unknown as { connect(): Promise<void>; connection: { disconnect(): void }; watchdog: { dispose(): void } }
  t.after(() => { native.connection?.disconnect(); native.watchdog.dispose() })
  const grants: Array<{ token: string; current: () => boolean } | undefined> = []
  events.onParticipation(grant => grants.push(grant))
  await native.connect()
  const before = grants.length
  for (const forged of [null, "private", { token: "short" }, { token: "a".repeat(64), owner: "forged" }]) callbacks[0]!(forged)
  assert.equal(grants.length, before)
  callbacks[0]!({ token: "a".repeat(64) })
  const first = grants.at(-1)!
  assert.equal(first.current(), true)
  callbacks[0]!({ token: "b".repeat(64) })
  const rotated = grants.at(-1)!
  assert.equal(first.current(), false)
  assert.equal(rotated.current(), true)
  await native.connect()
  assert.equal(rotated.current(), false)
  assert.equal(closed, 1)
  const after = grants.length
  callbacks[0]!({ token: "c".repeat(64) })
  assert.equal(grants.length, after, "superseded callback publishes zero grants")
  callbacks[1]!({ token: "d".repeat(64) })
  assert.equal(grants.at(-1)!.current(), true)
  assert.equal(first.current(), false)
  assert.equal(rotated.current(), false)
})
