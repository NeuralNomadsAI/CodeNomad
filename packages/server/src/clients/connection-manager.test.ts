import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { Logger } from "../logger.ts"
import { ClientConnectionManager } from "./connection-manager"

const logger = { debug() {}, warn() {} } as unknown as Logger

describe("ClientConnectionManager", () => {
  it("does not let an old unregister closure remove its replacement", () => {
    const manager = new ClientConnectionManager(logger)
    let replacementCloses = 0
    const oldUnregister = manager.register({ clientId: "client", connectionId: "window", close() {} })
    manager.register({ clientId: "client", connectionId: "window", close() { replacementCloses += 1 } })

    oldUnregister()
    assert.equal(manager.pong({ clientId: "client", connectionId: "window" }), true)
    assert.equal(replacementCloses, 0)
    manager.shutdown()
  })

  it("keeps delimiter-colliding identifier tuples independent", () => {
    const manager = new ClientConnectionManager(logger)
    manager.register({ clientId: "client:window", connectionId: "one", close() {} })
    manager.register({ clientId: "client", connectionId: "window:one", close() {} })

    assert.equal(manager.pong({ clientId: "client:window", connectionId: "one" }), true)
    assert.equal(manager.pong({ clientId: "client", connectionId: "window:one" }), true)
    manager.shutdown()
  })
})
