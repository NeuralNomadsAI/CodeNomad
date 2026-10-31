// The Status tab's goal line against OpenCode's `/goal` plugin: CodeNomad's goal route
// reads the native `opencode.goal` RPC, the native commands change it, and its `changed`
// events reach a workspace through CodeNomad's event relay.
// Usage: node --import tsx scripts/test-session-goal-native.mjs <absolute-cli>
import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import Fastify from "fastify"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { EventBus } from "../packages/server/src/events/bus.ts"
import { InstanceEventBridge } from "../packages/server/src/workspaces/instance-events.ts"
import { registerSessionGoalRoute } from "../packages/server/src/server/routes/session-goal.ts"
import { GOAL_CHANGED_EVENT, goalChangedSchema } from "../packages/server/src/opencode/goal-contract.ts"
import { getOpencodeErrorMessage } from "../packages/ui/src/lib/opencode-api.ts"

await withProductRuntime(process.argv[2], async () => ({}), async ({ client, root }) => {
  const owns = async (id, location) => id === "fixture" && location?.directory === root
  const records = [{ id: "fixture", path: root }]
  const manager = {
    list: () => records, ownsDirectory: async (id, directory) => owns(id, { directory }), ownsLocation: owns,
    getSharedServiceClient: async () => client, subscribeToSharedService: signal => client.event.subscribe({ signal }),
    invalidateWorktrees() {},
  }
  const bus = new EventBus(), routed = []
  let connected = false
  bus.on("instance.eventStatus", event => { if (event.status === "connected") connected = true })
  bus.on("instance.event", event => { if (event.event.type === GOAL_CHANGED_EVENT) routed.push(event) })
  const bridge = new InstanceEventBridge({ workspaceManager: manager, eventBus: bus, logger: { debug() {}, info() {}, warn() {}, error() {} } })
  const app = Fastify()
  registerSessionGoalRoute(app, { workspaceManager: manager })
  const until = async (predicate, message, timeout = 60_000) => {
    const deadline = Date.now() + timeout
    while (!await predicate()) {
      assert.ok(Date.now() < deadline, message)
      await delay(50)
    }
  }
  try {
    bus.publish({ type: "workspace.started", workspace: records[0] })
    await until(() => connected, "the relay connects")
    const session = await client.session.create({ location: { directory: root } })
    const read = async (sessionID = session.id, workspace = "fixture") => {
      const response = await app.inject({ method: "GET", url: `/api/workspaces/${workspace}/sessions/${sessionID}/goal` })
      return { status: response.statusCode, body: response.json() }
    }
    const command = text => client.session.command({ sessionID: session.id, name: "goal", text, delivery: "steer" })
    const changes = () => routed.filter(event => event.event.data?.sessionID === session.id)

    assert.deepEqual(await read(), { status: 200, body: { status: "goal", goal: null } }, "a new session has no goal")
    assert.equal((await read(session.id, "elsewhere")).status, 403, "another workspace cannot read it")
    const refused = await command("pause").then(() => undefined, error => error)
    assert.ok(refused, "pausing without a goal fails")
    assert.match(getOpencodeErrorMessage(refused, ""), /No active goal to pause/, "the failure carries the plugin's message")

    // The kickoff runs a turn; the fixture provider's plain reply is no verdict, so the
    // reviewer pauses the goal on its own.
    await command("Reach the fixture objective")
    await until(() => changes().some(event => event.event.data.goal?.status === "active"), "setting a goal publishes it")
    const set = changes()[0]
    assert.equal(set.instanceId, "fixture", "the change reaches the Session's workspace")
    assert.equal(set.event.location?.directory, root, "the change carries the Session's Location")
    assert.ok(goalChangedSchema.safeParse(set.event.data).success, "the published value matches the consumed contract")
    assert.equal(set.event.data.goal.objective, "Reach the fixture objective")
    await until(async () => (await read()).body.goal?.status === "paused", "the reviewer settles the goal")
    const paused = (await read()).body.goal
    assert.equal(typeof paused.reason, "string")
    assert.equal(paused.maxRounds > 0 && paused.rounds >= 0, true)
    // The read can answer before the relay delivers the same write's event.
    await until(() => changes().some(event => event.event.data.goal?.status === "paused"), "the pause is relayed too", 15_000)
    const pausedChange = changes().find(event => event.event.data.goal?.status === "paused")
    assert.equal(pausedChange.event.data.goal.reason, paused.reason, "the relayed pause carries the read's reason")

    const before = changes().length
    await command("resume")
    await until(() => changes().slice(before).some(event => event.event.data.goal?.status === "active"), "resuming publishes the active goal")
    await command("clear")
    await until(() => changes().at(-1)?.event.data.goal === null, "clearing publishes no goal")
    await until(async () => (await read()).body.goal === null, "the route reads the cleared goal")
    const cleared = await command("clear").then(() => undefined, error => error)
    assert.match(getOpencodeErrorMessage(cleared, ""), /No goal is set/)
    console.log(`PASS native session goal: route read, refused pause, ${changes().length} relayed changes (set, reviewer pause: "${paused.reason}", resume, clear)`)
  } finally {
    bridge.shutdown()
    await app.close()
  }
})
