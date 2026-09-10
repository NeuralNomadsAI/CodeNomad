// Executed by tui-reload.test.ts in a browser-conditioned child process. Only
// the transport is a fixture: publication, pagination, indexing, invalidation,
// coalescing and Solid stores all come from the unmodified installed npm cache.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { createRoot } from "solid-js"
import type { CreateDataInput, Data } from "@opencode/client/solid"
import type { MessageListOutput, OpenCodeEvent, SessionMessageInfo } from "@opencode/client"
import { createPruningReload } from "./tui-reload"
import tui from "./tui"

// Use the exact native client already locked through @opencode/plugin. No npm
// install, daemon discovery, user config, database, or checkout source access.
const clientEntry = new URL(import.meta.resolve("@opencode/client/solid"))
const manifest = JSON.parse(readFileSync(new URL("../../package.json", clientEntry), "utf8"))
assert.equal(manifest.name, "@opencode/client")
console.log(`Testing native Solid cache ${manifest.version}`)
const { createData } = await import(clientEntry.href) as typeof import("@opencode/client/solid")

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function message(id: string, removed = false): SessionMessageInfo {
  return {
    id, type: "assistant", agent: "build", model: { providerID: "fixture", id: "fixture" },
    time: { created: 1, completed: 2 }, finish: "stop",
    content: [
      ...(removed ? [{ type: "reasoning" as const, text: "REMOVED", time: { created: 1, completed: 2 } }] : []),
      { type: "text", text: `KEEP-${id}` },
    ],
  }
}

function page(messages: SessionMessageInfo[], next?: string): MessageListOutput {
  return { data: messages, cursor: { next } }
}

const event = {
  type: "rpc.codenomad.session-pruning.pruned", location: { directory: "/fixture" },
  data: { sessionID: "s", messageID: "older", revision: "a".repeat(64) },
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

function fixture() {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: Array<{ cursor?: string; response: ReturnType<typeof deferred<MessageListOutput>> }> = []
  const api = {
    message: {
      list: (input: { sessionID: string; cursor?: string }) => {
        assert.equal(input.sessionID, "s")
        const response = deferred<MessageListOutput>()
        requests.push({ cursor: input.cursor, response })
        return response.promise
      },
    },
  } as unknown as ReturnType<CreateDataInput["api"]>
  let disposeRoot!: () => void
  const data: Data = createRoot(dispose => {
    disposeRoot = dispose
    return createData({
      api: () => api, directory: "/fixture",
      event: {
        on: () => () => {},
        listen: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    })
  })
  data.session.remember({
    id: "s", projectID: "p", cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 2 }, location: { directory: "/fixture" },
  })
  const reload = createPruningReload(data.session)
  return {
    data, reload, requests,
    emitPrune() {
      // The custom RPC envelope is validated by the companion, not the
      // generated native-event union. This is the simulated transport boundary.
      const details = { ...event, id: "evt_prune", created: 3 } as unknown as OpenCodeEvent
      for (const listener of listeners) listener({ name: details.type, details })
    },
    async seed() {
      const sync = data.session.message.sync("s")
      requests[0].response.resolve(page([message("latest")], "older-page"))
      await sync
    },
    text: () => JSON.stringify(data.session.message.list("s")),
    dispose() { reload.dispose(); disposeRoot() },
  }
}

test("the published plugin entrypoint consumes the host's original native cache", async t => {
  const f = fixture(); t.after(() => f.dispose())
  // Matches the audited host's `data: host.data` assignment; no hidden cache
  // fields or replacement methods are attached by the test or companion.
  // The headless fixture omits unrelated renderer/UI services.
  const cleanup = await tui.setup!({ data: f.data } as unknown as Parameters<NonNullable<typeof tui.setup>>[0])
  t.after(() => { if (typeof cleanup === "function") return cleanup() })
  await f.seed()
  const older = f.data.session.message.loadMore("s")
  f.emitPrune()
  f.requests[1].response.resolve(page([message("older", true)]))
  await older
  await turn()
  assert.equal(f.requests.length, 3)
  f.requests[2].response.resolve(page([message("latest")], "older-page"))
  await turn()
  assert(!f.text().includes("REMOVED"))
})

test("control: invalidate/sync alone leaves REMOVED after late pagination", async t => {
  const f = fixture(); t.after(() => f.dispose())
  await f.seed()
  const older = f.data.session.message.loadMore("s")
  f.data.session.message.invalidate("s")
  const sync = f.data.session.message.sync("s")
  f.requests[2].response.resolve(page([message("latest")], "older-page"))
  await sync
  assert(!f.text().includes("REMOVED"))
  f.requests[1].response.resolve(page([message("older", true)]))
  await older
  await turn()
  assert(f.text().includes("REMOVED"), "The control must reproduce the reviewer's actual native-cache failure")
  assert.equal(f.requests.length, 3, "There is no subsequent native refresh")
})

for (const trigger of [event, { type: "server.connected" }]) {
  test(`companion joins pending publication and authoritatively rereads on ${trigger.type}`, async t => {
    const f = fixture(); t.after(() => f.dispose())
    await f.seed()
    const older = f.data.session.message.loadMore("s")
    assert(f.data.session.message.loading("s"))
    f.reload.event(trigger)
    assert.equal(f.requests.length, 2, "Joining does not request another page or read too early")

    // The TUI itself can sync while the companion waits. Reproduce the exact
    // latest-read -> late old-page ordering, then demand one final reread.
    const intermediate = f.data.session.message.sync("s")
    f.requests[2].response.resolve(page([message("latest")], "older-page"))
    await intermediate
    f.requests[1].response.resolve(page([message("older", true)]))
    await older
    await turn()
    assert.equal(f.requests.length, 4)
    assert.equal(f.requests[3].cursor, undefined, "Final read must replace, not merge, the old window")
    f.requests[3].response.resolve(page([message("latest")], "older-page"))
    await turn()
    assert(!f.text().includes("REMOVED"))
    assert.equal(f.data.session.message.get("s", "older"), undefined)

    // Dropping history permanently is not a fix: it must still paginate back
    // to the pruned message with its remaining content and index intact.
    const cleanOlder = f.data.session.message.loadMore("s")
    f.requests[4].response.resolve(page([message("older")]))
    await cleanOlder
    assert(f.text().includes("KEEP-older"))
    assert(!f.text().includes("REMOVED"))
    assert.equal(f.data.session.message.get("s", "older")?.id, "older")
    await turn()
    assert.equal(f.requests.length, 5, "No next event or polling is required")
  })
}

test("joins all-pages publication, including a prune during a buffered older page", async t => {
  const f = fixture(); t.after(() => f.dispose())
  await f.seed()
  const older = f.data.session.message.loadMore("s", { all: true })
  f.requests[1].response.resolve(page([message("older", true)], "oldest-page"))
  await turn()
  f.reload.event(event)
  f.reload.event(event)
  assert.equal(f.requests.length, 3)
  f.requests[2].response.resolve(page([message("oldest")]))
  await older
  await turn()
  assert.equal(f.requests[3].cursor, undefined)
  f.requests[3].response.resolve(page([message("latest")], "older-page"))
  await turn()
  // A second event while the first refresh was pending receives a fresh pass.
  assert.equal(f.requests.length, 5)
  f.requests[4].response.resolve(page([message("latest")], "older-page"))
  await turn()
  assert(!f.text().includes("REMOVED"))
})

test("failed pagination does not suppress the authoritative refresh", async t => {
  const f = fixture(); t.after(() => f.dispose())
  await f.seed()
  const older = f.data.session.message.loadMore("s")
  const rejected = assert.rejects(older, /offline/)
  f.reload.event(event)
  f.requests[1].response.reject(new Error("offline"))
  await rejected
  await turn()
  assert.equal(f.requests.length, 3)
  assert.equal(f.requests[2].cursor, undefined)
  f.requests[2].response.resolve(page([message("latest")]))
  await turn()
  assert(!f.data.session.message.loading("s"))
  assert(!f.text().includes("REMOVED"))
})

test("a prune during an in-flight sync forces a second authoritative pass", async t => {
  const f = fixture(); t.after(() => f.dispose())
  await f.seed()
  f.reload.event(event)
  f.reload.event(event)
  f.requests[1].response.resolve(page([message("latest", true)]))
  await turn()
  assert.equal(f.requests.length, 3)
  f.requests[2].response.resolve(page([message("latest")]))
  await turn()
  assert(!f.text().includes("REMOVED"))
})

test("joins both an older pagination and a latest-window sync started before pruning", async t => {
  const f = fixture(); t.after(() => f.dispose())
  await f.seed()
  const older = f.data.session.message.loadMore("s")
  f.data.session.message.invalidate("s")
  const oldSync = f.data.session.message.sync("s")
  f.reload.event(event)
  f.requests[1].response.resolve(page([message("older", true)]))
  await older
  await turn()
  assert.equal(f.requests.length, 3, "Native sync serialization must also drain the pre-prune window")
  f.requests[2].response.resolve(page([message("latest", true)], "older-page"))
  await oldSync
  await turn()
  assert.equal(f.requests.length, 4)
  f.requests[3].response.resolve(page([message("latest")], "older-page"))
  await turn()
  assert(!f.text().includes("REMOVED"))
})

test("an aborted TUI page cannot abandon the companion's final reread", async t => {
  const f = fixture(); t.after(() => f.dispose())
  await f.seed()
  const controller = new AbortController()
  const older = f.data.session.message.loadMore("s", { signal: controller.signal })
  f.reload.event(event)
  controller.abort()
  f.requests[1].response.resolve(page([message("older", true)]))
  await older
  await turn()
  // Native loadMore retries when the joined page did not publish. That new
  // request starts after pruning; the final authoritative read still follows.
  assert.equal(f.requests[2].cursor, "older-page")
  f.requests[2].response.resolve(page([message("older")]))
  await turn()
  assert.equal(f.requests[3].cursor, undefined)
  f.requests[3].response.resolve(page([message("latest")], "older-page"))
  await turn()
  assert(!f.text().includes("REMOVED"))
  assert.equal(f.requests.length, 4)
})

test("disposing the companion releases its join without cancelling TUI-owned pagination", async t => {
  const f = fixture(); t.after(() => f.dispose())
  await f.seed()
  const older = f.data.session.message.loadMore("s")
  f.reload.event(event)
  f.reload.dispose()
  await turn()
  assert(f.data.session.message.loading("s"), "The TUI still owns its request")
  f.requests[1].response.resolve(page([message("older")]))
  await older
  await turn()
  assert.equal(f.requests.length, 2, "A disposed companion must not start a refresh")
  assert(f.text().includes("KEEP-older"))
})
