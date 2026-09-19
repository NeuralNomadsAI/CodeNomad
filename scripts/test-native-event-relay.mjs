// Called only by the isolated location fixture. Native events and the shared
// SDK subscription are real; one recipient's ownership I/O is held deliberately.
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { tsImport } from "tsx/esm/api"

export async function testNativeEventRelay({ client, location }) {
  const { EventBus } = await tsImport("../packages/server/src/events/bus.ts", import.meta.url)
  const { InstanceEventBridge } = await tsImport("../packages/server/src/workspaces/instance-events.ts", import.meta.url)
  const controller = new AbortController()
  let release
  const slow = new Promise(resolve => { release = resolve })
  const records = ["fast", "slow"].map(id => ({ id, path: location.directory }))
  const owns = async (id, directory) => directory === location.directory && (id === "slow" ? slow : true)
  const bus = new EventBus(), routed = [], native = [], sessions = []
  let connected = false, nativeConnected = false
  const manager = {
    list: () => records,
    ownsDirectory: owns,
    ownsLocation: (id, ref) => owns(id, ref.directory),
    getSharedServiceClient: async () => client,
    subscribeToSharedService: signal => client.event.subscribe({ signal }),
    invalidateWorktrees() {},
  }
  bus.on("instance.eventStatus", event => { if (event.status === "connected") connected = true })
  bus.on("instance.event", event => routed.push(event))
  const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger: { debug() {}, warn() {} } })
  const subscriber = (async () => {
    for await (const event of client.event.subscribe({ signal: controller.signal })) {
      if (event.type === "server.connected") nativeConnected = true
      native.push(event)
    }
  })()
  // Keep the async subscriber's rejection handled even if an earlier assertion fails.
  void subscriber.catch(() => {})
  const until = async predicate => {
    const deadline = Date.now() + 10_000
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "native relay stalled behind another recipient")
      await delay(10)
    }
  }
  try {
    bus.publish({ type: "workspace.started", workspace: records[0] })
    await until(() => connected && nativeConnected)
    const session = await client.session.create({ location: { directory: location.directory } })
    sessions.push(session.id)
    const titles = Array.from({ length: 8 }, (_, index) => `relay-fixture-${index}`)
    for (const title of titles) await client.session.update({ sessionID: session.id, title })
    const renames = events => events.filter(event => event.type === "session.renamed" && event.data.sessionID === session.id).map(event => event.data.title)
    await until(() => renames(native).length === titles.length && renames(routed.filter(x => x.instanceId === "fast").map(x => x.event)).length === titles.length)
    assert.deepEqual(renames(native), titles, "another subscriber on the same SDK client must keep receiving")
    assert.deepEqual(renames(routed.filter(x => x.instanceId === "fast").map(x => x.event)), titles)
    assert.equal(renames(routed.filter(x => x.instanceId === "slow").map(x => x.event)).length, 0)
    release(true)
    await until(() => renames(routed.filter(x => x.instanceId === "slow").map(x => x.event)).length === titles.length)
    assert.deepEqual(renames(routed.filter(x => x.instanceId === "slow").map(x => x.event)), titles)
    console.log("PASS: native relay isolates slow recipients, preserves session ordering and does not block another shared SDK subscriber")
  } finally {
    release(false)
    bridge.shutdown()
    controller.abort()
    await subscriber.catch(() => {})
    await Promise.allSettled(sessions.map(sessionID => client.session.remove({ sessionID })))
  }
}
