import assert from "node:assert/strict"
import { it } from "node:test"

import type { ServerMeta } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { createServerMetaCache, getServerMeta } from "./server-meta"

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

it("publishes refreshes only to the same attachment and rejects revoked metadata replies", async () => {
  let value = { previewsUnavailable: false } as ServerMeta
  let release: (() => void) | undefined
  const cache = createServerMetaCache({ fetchServerMeta: async () => {
    if (release) await new Promise<void>(resolve => { release = resolve })
    return value
  } })
  const first = new AbortController(), second = new AbortController()
  await cache.getServerMeta(false, first.signal)
  assert.equal(cache.meta(first.signal)?.previewsUnavailable, false)
  assert.equal(cache.meta(second.signal), null)
  value = { previewsUnavailable: true } as ServerMeta
  await cache.getServerMeta(true, first.signal)
  assert.equal(cache.meta(first.signal)?.previewsUnavailable, true)
  assert.equal(cache.meta(second.signal), null)
  release = () => {}
  const pending = cache.getServerMeta(false, second.signal)
  second.abort(); release()
  await assert.rejects(pending, { name: "AbortError" })
  assert.equal(cache.meta(second.signal), null)
  assert.equal(cache.meta(first.signal)?.previewsUnavailable, true)
})
