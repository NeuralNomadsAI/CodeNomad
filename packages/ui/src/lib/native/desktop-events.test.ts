import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  connectTauriWorkspaceEvents,
  createTerminalErrorNotifier,
  mapDesktopEventTransportStatus,
} from "./desktop-events.ts"

describe("createTerminalErrorNotifier", () => {
  it("calls onError once for repeated terminal notifications", () => {
    let errors = 0
    const notifyTerminalError = createTerminalErrorNotifier({
      onError: () => {
        errors += 1
      },
    })

    notifyTerminalError()
    notifyTerminalError()

    assert.equal(errors, 1)
  })
})

describe("mapDesktopEventTransportStatus", () => {
  it("maps native connected state to shared connected state", () => {
    assert.equal(mapDesktopEventTransportStatus("connected"), "connected")
  })

  it("maps native connecting state to shared connecting state", () => {
    assert.equal(mapDesktopEventTransportStatus("connecting"), "connecting")
  })

  it("maps native transient failures to shared disconnected state", () => {
    assert.equal(mapDesktopEventTransportStatus("disconnected"), "disconnected")
    assert.equal(mapDesktopEventTransportStatus("error"), "disconnected")
    assert.equal(mapDesktopEventTransportStatus("unauthorized"), "disconnected")
  })
})

describe("connectTauriWorkspaceEvents", () => {
  it("discards R1 deltas when an R2 snapshot supersedes hydration", async () => {
    let batchHandler: ((event: { payload: any }) => void) | undefined
    let resetHandler: ((event: { payload: any }) => void) | undefined
    const acknowledgements: any[] = []
    const bridge = {
      invoke: async (command: string) => command === "desktop_events_start"
        ? { started: true, generation: 4, leaseId: 9 }
        : undefined,
      listen: async (eventName: string, handler: (event: { payload: any }) => void) => {
        if (eventName === "desktop:event-batch") batchHandler = handler
        if (eventName === "desktop:event-replay-reset") resetHandler = handler
        return () => undefined
      },
      emit: async (eventName: string, payload: any) => {
        acknowledgements.push({ eventName, payload })
      },
    } as any
    let currentCursor = "9"
    const committed: string[] = []
    const cursor = {
      read: () => currentCursor,
      commit: (next?: string) => {
        currentCursor = next ?? ""
        if (next) committed.push(next)
        return true
      },
    }
    let finishR1!: (accepted: boolean) => void
    let finishR2!: (accepted: boolean) => void
    let hydration = 0
    const applied: string[] = []
    const connection = await connectTauriWorkspaceEvents({
      onBatch: (events) => {
        applied.push(...events.map((event: any) => event.marker))
      },
      onReplayReset: () => {
        hydration += 1
        return new Promise<boolean>((resolve) => {
          if (hydration === 1) finishR1 = resolve
          else {
            finishR2 = (accepted) => {
              if (accepted) applied.push("shared")
              resolve(accepted)
            }
          }
        })
      },
    }, { reconnect: {} }, bridge, cursor)

    resetHandler!({ payload: { generation: 4, details: { reset: "R1" }, lastEventId: "10" } })
    batchHandler!({ payload: {
      generation: 4, sequence: 11, emittedAt: 11, lastEventId: "11",
      events: [{ type: "workspace.log", marker: "shared" }],
    } })
    resetHandler!({ payload: { generation: 4, details: { reset: "R2" }, lastEventId: "20" } })
    batchHandler!({ payload: {
      generation: 4, sequence: 21, emittedAt: 21, lastEventId: "21",
      events: [{ type: "workspace.created", marker: "post-R2" }],
    } })

    finishR1(true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(hydration, 2)
    assert.deepEqual(applied, [])
    assert.deepEqual(committed, [])

    finishR2(true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(applied, ["shared", "post-R2"])
    assert.deepEqual(committed, ["21"])
    assert.equal(currentCursor, "21")
    assert.deepEqual(acknowledgements, [{
      eventName: "desktop:event-ack",
      payload: { generation: 4, lastEventId: "21" },
    }])
    connection.disconnect()
  })

  it("buffers post-reset batches until hydration succeeds and then commits their latest cursor", async () => {
    let batchHandler: ((event: { payload: any }) => void) | undefined
    let resetHandler: ((event: { payload: any }) => void) | undefined
    const acknowledgements: any[] = []
    const bridge = {
      invoke: async (command: string) => command === "desktop_events_start"
        ? { started: true, generation: 4, leaseId: 9 }
        : undefined,
      listen: async (eventName: string, handler: (event: { payload: any }) => void) => {
        if (eventName === "desktop:event-batch") batchHandler = handler
        if (eventName === "desktop:event-replay-reset") resetHandler = handler
        return () => undefined
      },
      emit: async (eventName: string, payload: any) => {
        acknowledgements.push({ eventName, payload })
      },
    } as any
    let currentCursor = "before-reset"
    const committed: Array<string | undefined> = []
    const cursor = {
      read: () => currentCursor,
      commit: (next?: string) => {
        currentCursor = next ?? ""
        committed.push(next)
        return true
      },
    }
    let finishHydration!: (accepted: boolean) => void
    const batches: string[][] = []
    const connection = await connectTauriWorkspaceEvents({
      onBatch: (events) => {
        batches.push(events.map((event: any) => event.type))
      },
      onReplayReset: () => new Promise<boolean>((resolve) => { finishHydration = resolve }),
    }, { reconnect: {} }, bridge, cursor)

    resetHandler!({ payload: { generation: 4, details: {}, lastEventId: "reset:10" } })
    batchHandler!({ payload: {
      generation: 4, sequence: 11, emittedAt: Date.now(), lastEventId: "reset:11",
      events: [{ type: "workspace.log" }],
    } })
    batchHandler!({ payload: {
      generation: 3, sequence: 12, emittedAt: Date.now(), lastEventId: "stale:12",
      events: [{ type: "workspace.stopped" }],
    } })
    batchHandler!({ payload: {
      generation: 4, sequence: 12, emittedAt: Date.now(), lastEventId: "reset:12",
      events: [{ type: "workspace.created" }],
    } })
    assert.deepEqual(batches, [])
    assert.deepEqual(committed, [])

    finishHydration(true)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(batches, [["workspace.log"], ["workspace.created"]])
    assert.deepEqual(committed, ["reset:12"])
    assert.deepEqual(acknowledgements, [{
      eventName: "desktop:event-ack",
      payload: { generation: 4, lastEventId: "reset:12" },
    }])
    connection.disconnect()
  })

  it("marks the transport connected when a batch opens the native stream", async () => {
    let batchHandler: ((event: { payload: any }) => void) | undefined
    let statusHandler: ((event: { payload: any }) => void) | undefined
    let resetHandler: ((event: { payload: any }) => void) | undefined
    const unlistened: string[] = []
    const startLastEventIds: Array<string | undefined> = []
    const acknowledgements: any[] = []
    let stopLeaseId: number | undefined
    const bridge = {
      invoke: async (command: string, args?: any) => {
        if (command === "desktop_events_start") {
          startLastEventIds.push(args?.request?.lastEventId)
          return { started: true, generation: 1, leaseId: 7 }
        }
        if (command === "desktop_events_stop") {
          stopLeaseId = args?.leaseId
          return undefined
        }
        throw new Error(`Unexpected command: ${command}`)
      },
      listen: async (eventName: string, handler: (event: { payload: any }) => void) => {
        if (eventName === "desktop:event-batch") {
          batchHandler = handler
        } else if (eventName === "desktop:event-stream-status") {
          statusHandler = handler
        } else if (eventName === "desktop:event-replay-reset") {
          resetHandler = handler
        }
        return () => {
          unlistened.push(eventName)
        }
      },
      emit: async (eventName: string, payload: any) => {
        acknowledgements.push({ eventName, payload })
      },
    } as any

    const statuses: string[] = []
    const batches: unknown[] = []
    let opens = 0
    let resets = 0
    let errors = 0

    const connection = await connectTauriWorkspaceEvents(
      {
        onBatch: (events) => {
          batches.push(events)
        },
        onOpen: () => {
          opens += 1
        },
        onStatus: (status) => statuses.push(status),
        onReplayReset: () => {
          resets += 1
        },
        onError: () => {
          errors += 1
        },
      },
      { reconnect: {} },
      bridge,
    )

    assert.ok(batchHandler)
    batchHandler({
      payload: {
        generation: 1,
        sequence: 1,
        emittedAt: Date.now(),
        lastEventId: "9",
        events: [{ type: "server.heartbeat" }],
      },
    })

    assert.deepEqual(statuses, ["connected"])
    assert.equal(opens, 1)
    assert.equal(batches.length, 1)
    assert.deepEqual(acknowledgements, [{
      eventName: "desktop:event-ack",
      payload: { generation: 1, lastEventId: "9" },
    }])

    resetHandler!({ payload: { generation: 1, details: {}, lastEventId: "10" } })
    await Promise.resolve()
    assert.equal(resets, 1)
    assert.deepEqual(acknowledgements[1], {
      eventName: "desktop:event-ack",
      payload: { generation: 1, lastEventId: "10" },
    })

    statusHandler!({ payload: { generation: 1, state: "disconnected" } })
    statusHandler!({ payload: { generation: 1, state: "connected" } })
    assert.deepEqual(statuses, ["connected", "disconnected", "connected"])
    assert.equal(opens, 2)

    connection.disconnect()
    assert.deepEqual(unlistened, ["desktop:event-batch", "desktop:event-stream-status", "desktop:event-replay-reset"])
    await Promise.resolve()
    assert.equal(stopLeaseId, 7)

    const replacement = await connectTauriWorkspaceEvents({
      onBatch() {},
      onReplayReset: () => false,
      onError: () => {
        errors += 1
      },
    }, { reconnect: {} }, bridge)
    assert.deepEqual(startLastEventIds, [undefined, "10"])
    resetHandler!({ payload: { generation: 1, details: {}, lastEventId: "11" } })
    await Promise.resolve()
    batchHandler!({
      payload: {
        generation: 1,
        sequence: 2,
        emittedAt: Date.now(),
        lastEventId: "12",
        events: [{ type: "server.heartbeat" }],
      },
    })
    assert.equal(errors, 1)
    replacement.disconnect()
    const afterRejectedBatch = await connectTauriWorkspaceEvents({ onBatch() {} }, { reconnect: {} }, bridge)
    assert.deepEqual(startLastEventIds, [undefined, "10", "10"])
    assert.equal(acknowledgements.length, 2)
    afterRejectedBatch.disconnect()
  })
})
