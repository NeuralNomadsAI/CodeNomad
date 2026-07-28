import assert from "node:assert/strict"
import test from "node:test"
import { EventBus } from "../events/bus"
import { InstanceEventBridge } from "./instance-events"

test("instance event bridge parses CRLF-delimited SSE frames with a stream id", () => {
  const eventBus = new EventBus()
  const published: any[] = []
  eventBus.on("instance.event", (event) => published.push(event))
  const bridge = new InstanceEventBridge({
    eventBus,
    workspaceManager: {} as any,
    logger: { debug() {}, trace() {}, warn() {}, isLevelEnabled: () => false } as any,
  })

  const remaining = (bridge as any).flushEvents(
    'data: {"type":"session.idle","properties":{"sessionID":"s"}}\r\n\r\n',
    "instance",
    "stream",
  )

  assert.equal(remaining, "")
  assert.equal(published[0]?.streamId, "stream")
  bridge.shutdown()
})

test("instance event bridge parses CR-delimited SSE frames", () => {
  const eventBus = new EventBus()
  const published: any[] = []
  eventBus.on("instance.event", (event) => published.push(event))
  const bridge = new InstanceEventBridge({
    eventBus,
    workspaceManager: {} as any,
    logger: { debug() {}, trace() {}, warn() {}, isLevelEnabled: () => false } as any,
  })

  const remaining = (bridge as any).flushEvents(
    'data: {"type":"session.idle","properties":{"sessionID":"s"}}\r\r',
    "instance",
    "stream",
  )

  assert.equal(remaining, "")
  assert.equal(published.length, 1)
  bridge.shutdown()
})

test("instance event bridge rotates stream authority when the workspace pid changes", () => {
  const eventBus = new EventBus()
  const bridge = new InstanceEventBridge({
    eventBus,
    workspaceManager: { getInstancePort: () => undefined } as any,
    logger: { debug() {}, trace() {}, warn() {}, isLevelEnabled: () => false } as any,
  })
  const workspace = { id: "instance", pid: 1 }
  eventBus.publish({ type: "workspace.started", workspace } as any)
  const first = (bridge as any).streams.get(workspace.id)
  eventBus.publish({ type: "workspace.started", workspace } as any)
  assert.equal((bridge as any).streams.get(workspace.id).streamId, first.streamId)

  eventBus.publish({ type: "workspace.started", workspace: { ...workspace, pid: 2 } } as any)
  const second = (bridge as any).streams.get(workspace.id)
  assert.notEqual(second.streamId, first.streamId)
  assert.equal(first.controller.signal.aborted, true)
  bridge.shutdown()
})
