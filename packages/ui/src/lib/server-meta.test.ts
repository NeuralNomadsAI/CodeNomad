import assert from "node:assert/strict"
import { it } from "node:test"

import type { ServerMeta } from "../../../server/src/api-types"
import { serverApi } from "./api-client"
import { createServerMetaCache, getServerMeta, localRequest } from "./server-meta"

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
  let value: ServerMeta = { localUrl: "http://127.0.0.1:9899", eventsUrl: "http://127.0.0.1:9899/api/events",
    host: "127.0.0.1", listeningMode: "local", localPort: 9899, hostLabel: "localhost",
    workspaceRoot: "/workspace", addresses: [] }
  let release: (() => void) | undefined
  const cache = createServerMetaCache({ fetchServerMeta: async () => {
    if (release) await new Promise<void>(resolve => { release = resolve })
    return value
  } })
  const first = new AbortController(), second = new AbortController()
  await cache.getServerMeta(false, first.signal)
  assert.equal(cache.meta(first.signal)?.previewsUnavailable, undefined)
  assert.equal(cache.meta(second.signal), null)
  value = { ...value, previewsUnavailable: true }
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

it("remote metadata never grants host authority; local metadata refresh owns it", async () => {
  const original = serverApi.fetchServerMeta
  const meta = await getServerMeta()
  let local = false
  serverApi.fetchServerMeta = async () => ({ ...meta, localRequest: local })
  try {
    await getServerMeta(true)
    assert.equal(localRequest(), false)
    const remote = createServerMetaCache({ fetchServerMeta: async () => ({ ...meta, localRequest: true }) })
    await remote.getServerMeta()
    assert.equal(remote.meta()?.localRequest, true)
    assert.equal(localRequest(), false)
    local = true
    await getServerMeta(true)
    assert.equal(localRequest(), true)
    local = false
    await getServerMeta(true)
    assert.equal(localRequest(), false)
  } finally { serverApi.fetchServerMeta = original }
})
