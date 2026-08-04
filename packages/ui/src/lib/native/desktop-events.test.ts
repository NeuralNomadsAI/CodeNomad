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
  it("marks the transport connected when a batch opens the native stream", async () => {
    let batchHandler: ((event: { payload: any }) => void) | undefined
    let statusHandler: ((event: { payload: any }) => void) | undefined
    let resetHandler: ((event: { payload: any }) => void) | undefined
    const unlistened: string[] = []
    const startLastEventIds: Array<string | undefined> = []
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
    } as any

    const statuses: string[] = []
    const batches: unknown[] = []
    let opens = 0
    let resets = 0

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

    resetHandler!({ payload: { generation: 1, details: {} } })
    assert.equal(resets, 1)

    statusHandler!({ payload: { generation: 1, state: "disconnected" } })
    statusHandler!({ payload: { generation: 1, state: "connected" } })
    assert.deepEqual(statuses, ["connected", "disconnected", "connected"])
    assert.equal(opens, 2)

    connection.disconnect()
    assert.deepEqual(unlistened, ["desktop:event-batch", "desktop:event-stream-status", "desktop:event-replay-reset"])
    await Promise.resolve()
    assert.equal(stopLeaseId, 7)

    const replacement = await connectTauriWorkspaceEvents({ onBatch: () => false }, { reconnect: {} }, bridge)
    assert.deepEqual(startLastEventIds, [undefined, "9"])
    batchHandler!({
      payload: {
        generation: 1,
        sequence: 2,
        emittedAt: Date.now(),
        lastEventId: "10",
        events: [{ type: "server.heartbeat" }],
      },
    })
    replacement.disconnect()
    const afterRejectedBatch = await connectTauriWorkspaceEvents({ onBatch() {} }, { reconnect: {} }, bridge)
    assert.deepEqual(startLastEventIds, [undefined, "9", "9"])
    afterRejectedBatch.disconnect()
  })
})
