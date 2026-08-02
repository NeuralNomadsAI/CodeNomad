import assert from "node:assert/strict"
import test from "node:test"

import { connectTauriWorkspaceEvents } from "./desktop-events.ts"

test("native reconnect opens once per connected transition", async () => {
  let statusHandler: ((event: { payload: any }) => void) | undefined
  const bridge = {
    invoke: async (command: string) => {
      if (command === "desktop_events_reserve_start") return { logicalStartEpoch: 1 }
      if (command === "desktop_events_start") return { started: true, generation: 7, lease: 1 }
      return undefined
    },
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
  let resolveStart!: (value: { started: true; generation: number; lease: number }) => void
  const start = new Promise<{ started: true; generation: number; lease: number }>((resolve) => { resolveStart = resolve })
  const handlers = new Map<string, (event: { payload: any }) => void>()
  const bridge = {
    invoke: (command: string) => command === "desktop_events_reserve_start"
      ? Promise.resolve({ logicalStartEpoch: 1 })
      : start,
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
  resolveStart({ started: true, generation: 7, lease: 1 })
  const connection = await pending

  assert.deepEqual(events, ["connected", "open", "batch", "disconnected"])
  connection.disconnect()
})

test("a later native reservation rejects an older start delayed by listener setup", async () => {
  let releaseOlderListen!: () => void
  const olderListenBlocked = new Promise<void>((resolve) => {
    releaseOlderListen = resolve
  })
  const stops: number[] = []
  const arrivedEpochs: number[] = []
  let listenCalls = 0
  let latestEpoch = 0
  const bridge = {
    invoke: async (command: string, args?: { lease?: number; request?: { logicalStartEpoch: number } }) => {
      if (command === "desktop_events_reserve_start") {
        latestEpoch += 1
        return { logicalStartEpoch: latestEpoch }
      }
      if (command === "desktop_events_stop") {
        stops.push(args?.lease ?? -1)
        return
      }
      const epoch = args?.request?.logicalStartEpoch ?? 0
      arrivedEpochs.push(epoch)
      if (epoch !== latestEpoch) return { started: false, reason: "stale logical desktop event start" }
      return { started: true, generation: 1, lease: 1 }
    },
    listen: async () => {
      listenCalls += 1
      if (listenCalls === 1) await olderListenBlocked
      return () => {}
    },
  } as any

  const olderPending = connectTauriWorkspaceEvents({ onBatch: () => {} }, { reconnect: {} }, bridge)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(arrivedEpochs.length, 0)

  const current = await connectTauriWorkspaceEvents({ onBatch: () => {} }, { reconnect: {} }, bridge)
  releaseOlderListen()
  await assert.rejects(olderPending, /stale logical desktop event start/)

  assert.equal(arrivedEpochs.length, 2)
  assert.ok(arrivedEpochs[0] > arrivedEpochs[1])
  assert.deepEqual(stops, [])
  current.disconnect()
  assert.deepEqual(stops, [1])
})

test("a reloaded webview module reserves a newer native start epoch", async () => {
  type DesktopEventsModule = typeof import("./desktop-events.ts")
  let moduleId = 0
  const loadModule = () => import(`./desktop-events.ts?reload=${moduleId++}`) as Promise<DesktopEventsModule>
  const firstModule = await loadModule()
  const reloadedModule = await loadModule()
  const reservations: number[] = []
  const starts: number[] = []
  let latestEpoch = 40
  let activeLease: number | undefined
  const bridge = {
    invoke: async (command: string, args?: { lease?: number; request?: { logicalStartEpoch: number } }) => {
      if (command === "desktop_events_reserve_start") {
        latestEpoch += 1
        reservations.push(latestEpoch)
        return { logicalStartEpoch: latestEpoch }
      }
      if (command === "desktop_events_start") {
        const epoch = args?.request?.logicalStartEpoch ?? 0
        starts.push(epoch)
        if (epoch !== latestEpoch) return { started: false, reason: "stale logical desktop event start" }
        activeLease = epoch
        return { started: true, generation: epoch, lease: epoch }
      }
      if (command === "desktop_events_stop" && args?.lease === activeLease) activeLease = undefined
      return undefined
    },
    listen: async () => () => {},
  } as any

  const first = await firstModule.connectTauriWorkspaceEvents({ onBatch: () => {} }, { reconnect: {} }, bridge)
  const reloaded = await reloadedModule.connectTauriWorkspaceEvents({ onBatch: () => {} }, { reconnect: {} }, bridge)

  assert.deepEqual(reservations, [41, 42])
  assert.deepEqual(starts, [41, 42])
  first.disconnect()
  assert.equal(activeLease, 42)
  reloaded.disconnect()
  assert.equal(activeLease, undefined)
})
