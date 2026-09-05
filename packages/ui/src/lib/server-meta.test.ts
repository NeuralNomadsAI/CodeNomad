import assert from "node:assert/strict"
import { it } from "node:test"

import type { ServerMeta } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { getServerMeta } from "./server-meta"

it("allows a metadata retry after a failed request", async () => {
  const originalFetch = serverApi.fetchServerMeta
  let attempts = 0
  const recoveredMeta: ServerMeta = {
    localUrl: "http://127.0.0.1:9899",
    eventsUrl: "http://127.0.0.1:9899/api/events",
    host: "127.0.0.1",
    listeningMode: "local",
    localPort: 9899,
    hostLabel: "localhost",
    workspaceRoot: "/workspace",
    addresses: [],
  }

  serverApi.fetchServerMeta = async () => {
    attempts += 1
    if (attempts === 1) throw new Error("offline")
    return recoveredMeta
  }

  try {
    await assert.rejects(getServerMeta(true), /offline/)
    assert.equal(await getServerMeta(true), recoveredMeta)
    assert.equal(attempts, 2)
  } finally {
    serverApi.fetchServerMeta = originalFetch
  }
})
