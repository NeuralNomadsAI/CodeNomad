import assert from "node:assert/strict"
import test from "node:test"

import { connectTauriWorkspaceEvents } from "./desktop-events.ts"

test("native reconnect opens once per connected transition", async () => {
  let statusHandler: ((event: { payload: any }) => void) | undefined
  const bridge = {
    invoke: async (command: string) => command === "desktop_events_start"
      ? { started: true, generation: 7 }
      : undefined,
    listen: async (eventName: string, handler: (event: { payload: any }) => void) => {
      if (eventName === "desktop:event-stream-status") statusHandler = handler
      return () => {}
    },
  } as any
  let opens = 0
  const connection = await connectTauriWorkspaceEvents({
    onBatch: () => {},
    onOpen: () => { opens += 1 },
  }, { reconnect: {} }, bridge)

  assert.ok(statusHandler)
  statusHandler({ payload: { generation: 7, state: "connected" } })
  statusHandler({ payload: { generation: 7, state: "connected" } })
  assert.equal(opens, 1)

  statusHandler({ payload: { generation: 7, state: "disconnected" } })
  statusHandler({ payload: { generation: 7, state: "connected" } })
  assert.equal(opens, 2)
  connection.disconnect()
})

test("native startup replay preserves status and batch order", async () => {
  let resolveStart!: (value: { started: true; generation: number }) => void
  const start = new Promise<{ started: true; generation: number }>((resolve) => { resolveStart = resolve })
  const handlers = new Map<string, (event: { payload: any }) => void>()
  const bridge = {
    invoke: () => start,
    listen: async (eventName: string, handler: (event: { payload: any }) => void) => {
      handlers.set(eventName, handler)
      return () => {}
    },
  } as any
  const events: string[] = []
  const pending = connectTauriWorkspaceEvents({
    onBatch: () => { events.push("batch") },
    onOpen: () => { events.push("open") },
    onStatus: (status) => { events.push(status) },
  }, { reconnect: {} }, bridge)
  await Promise.resolve()
  await Promise.resolve()

  handlers.get("desktop:event-stream-status")?.({ payload: { generation: 7, state: "connected" } })
  handlers.get("desktop:event-batch")?.({ payload: { generation: 7, sequence: 1, emittedAt: 0, events: [{}] } })
  handlers.get("desktop:event-stream-status")?.({ payload: { generation: 7, state: "disconnected" } })
  resolveStart({ started: true, generation: 7 })
  const connection = await pending

  assert.deepEqual(events, ["connected", "open", "batch", "disconnected"])
  connection.disconnect()
})
