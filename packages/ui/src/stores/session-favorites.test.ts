import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot } from "solid-js"
import type { SessionFavoritesSnapshot } from "../../../server/src/api-types"
import { serverApi } from "../lib/api-client"
import { useSessionFavorites } from "./session-favorites"

const answer = (revision: number, ...ids: string[]): SessionFavoritesSnapshot =>
  ({ source: "backend", revision, records: Object.fromEntries(ids.map(id => [id, []])) })

test("a confirmed write displays when GET fails; a late PUT cannot undo a newer snapshot", async () => {
  const read = serverApi.readSessionFavoritesInBackground
  const save = serverApi.saveSessionFavorite
  let reads = 0
  serverApi.readSessionFavoritesInBackground = async () => {
    if (++reads === 1) return answer(1)
    throw new Error("refresh unavailable")
  }
  let respond!: (snapshot: SessionFavoritesSnapshot) => void
  const delayed = new Promise<SessionFavoritesSnapshot>(resolve => { respond = resolve })
  serverApi.saveSessionFavorite = async (_instance, id) => id === "first" ? delayed : answer(3, "first", "second")
  const { owner, dispose } = createRoot(dispose => ({ owner: useSessionFavorites(() => "work"), dispose }))
  try {
    await Promise.resolve()
    assert.equal(owner.ready(), true)
    const old = owner.save("first", true)
    await owner.save("second", true)
    assert.deepEqual(Object.keys(owner.records()), ["first", "second"])
    respond(answer(2, "first"))
    await old
    assert.deepEqual(Object.keys(owner.records()), ["first", "second"])
    assert.ok(reads > 1)
  } finally {
    dispose()
    serverApi.readSessionFavoritesInBackground = read
    serverApi.saveSessionFavorite = save
  }
})
