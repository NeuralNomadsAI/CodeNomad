import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium } from "playwright"
import type { NativeClientStatePartitionCommit } from "../../src/lib/native/client-state"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

function scalarEntries(value: Record<string, any>, prefix = ""): Array<[string, any]> {
  return Object.entries(value).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return value && typeof value === "object" ? scalarEntries(value, path) : [[path, value]]
  })
}

test("capture defers only busy usage through both real-store effects and keeps fresh checkpoints", { timeout: 60_000 }, async t => {
  const fixture = await borrowFixture({ name: "session-capture", routes: [{ path: "/fixture",
    html: '<html><body><script type="module" src="/tests/browser/fixtures/session-capture.tsx"></script></body></html>',
  }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  try {
    for (const host of ["electron", "tauri"]) {
      const page = await browser.newPage()
      const clockStart = new Date("2025-01-01T00:00:00Z")
      await page.clock.install({ time: clockStart })
      await page.clock.pauseAt(new Date(+clockStart + 1_000))
      const errors: string[] = []
      page.on("pageerror", error => errors.push(error.message))
      await page.addInitScript(({ host }) => {
        const w = window as any
        w.__name = (value: unknown) => value
        w.__CODENOMAD_RUNTIME_HOST__ = host
        w.__CODENOMAD_WINDOW_CONTEXT__ = "local"
        const callbacks = new Map(), listeners = new Map()
        let sequence = 0
        w.receipts = []; w.completedCommits = 0; w.acks = []; w.mode = "accept"
        const load = () => ({ isPrimary: true, restoreEnabled: true, snapshot: null, partitionProtocolVersion: 1 })
        const commit = async (token: string, payload: NativeClientStatePartitionCommit) => {
          w.receipts.push({ token, payload: structuredClone(payload) })
          try {
            if (w.holdNextCommit) {
              w.holdNextCommit = false
              await new Promise<void>(resolve => { w.finishHeldCommit = resolve })
            }
            if (w.mode === "fail") throw Error("synthetic write failure")
            if (w.mode === "refuse") return false
            const partitions = { ...w.persisted?.partitions, ...payload.partitions }
            if (payload.partitionKeys.some(key => !(key in partitions))) throw Error("Missing client state partition")
            w.persisted = { ...payload, partitions: Object.fromEntries(payload.partitionKeys.map(key => [key, partitions[key]])) }
            return true
          } finally {
            w.completedCommits++
            w.dispatchEvent(new Event("fixture-commit-completed"))
          }
        }
        w.electronAPI = { claimClientStateAccess: async () => true, loadClientState: async () => load(),
          loadClientStatePartition: async () => null, commitClientStatePartitions: async (token: string, payload: NativeClientStatePartitionCommit) => commit(token, payload) }
        w.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: "local-fixture" }, currentWebview: { label: "local-fixture" } },
          transformCallback: (fn: Function) => { callbacks.set(++sequence, fn); return sequence },
          unregisterCallback: (id: number) => callbacks.delete(id),
          invoke: async (command: string, args: any) => {
            if (command === "plugin:event|listen") { listeners.set(args.event, args); return args.handler }
            if (command === "plugin:event|unlisten") { listeners.delete(args.event); return }
            if (command === "client_state_load") return load()
            if (command === "client_state_load_partition") return null
            if (command === "client_state_commit_partitions") return commit(args.accessToken, args.payload)
            if (command.endsWith("flushed")) w.acks.push({ command, generation: args.generation })
            return true
          },
        }
        w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
        w.emit = (event: string, generation: number, label = "local-fixture", prepareGeneration?: number) => {
          const listener = listeners.get(event)
          if (listener && (listener.target.kind === "Any" || listener.target.label === label)) {
            callbacks.get(listener.handler)?.({ payload: { generation, prepareGeneration } })
          }
        }
      }, { host })
      const deletes: string[] = []
      // Production imports may subscribe to SSE; keep that boundary local and inert.
      await page.route("**/api/**", route => {
        if (route.request().method() === "DELETE") deletes.push(new URL(route.request().url()).pathname)
        return route.fulfill({ json: {} })
      })
      await page.route("**/api/events", route => route.fulfill({ contentType: "text/event-stream", body: ": ready\n\n" }))
      await page.goto(fixture.url)
      await page.waitForFunction(() => Boolean((window as any).fixture))
      // Capture and persistence have separate quiet periods; advance both before
      // checking that busy usage produced no additional checkpoint.
      const waitForCommit = (expected: number) => page.evaluate(expected => new Promise<void>(resolve => {
        const done = () => {
          if ((window as any).completedCommits < expected) return
          window.removeEventListener("fixture-commit-completed", done)
          resolve()
        }
        window.addEventListener("fixture-commit-completed", done)
        done()
      }), expected)
      const settle = async (expected?: number) => {
        await page.clock.runFor(850)
        if (expected !== undefined) await waitForCommit(expected)
      }
      const count = () => page.evaluate(() => (window as any).receipts.length)
      const checkpointAfter = async (change: () => Promise<unknown>, writes = 1) => {
        const before = await count()
        await change()
        await settle(before + writes)
      }
      const state = () => page.evaluate(() => (window as any).fixture.state())
      const change = (field: string, id = "first", sessionId = "parent") =>
        page.evaluate(([field, id, sessionId]) => (window as any).fixture.change(field, id, sessionId), [field, id, sessionId])
      const usage = (id = "first", sessionId = "parent") =>
        page.evaluate(([id, sessionId]) => (window as any).fixture.usage(id, sessionId), [id, sessionId])
      // A checkpoint is a capture; it writes natively only when persisted content changed.
      const captures = () => page.evaluate(() => (window as any).fixture.captures())
      const mutate = async (path: string, value: unknown, writes = 1) => {
        const [beforeCaptures, beforeWrites] = [await captures(), await count()]
        await page.evaluate(([path, value]) => (window as any).fixture.mutate(path, value), [path, value])
        await settle(writes ? beforeWrites + writes : undefined)
        assert.equal(await captures(), beforeCaptures + 1, `${host}: in-place ${path} checkpoints`)
        assert.equal(await count(), beforeWrites + writes, `${host}: in-place ${path} writes ${writes ? "its change" : "nothing"}`)
      }
      await settle(1)
      assert.equal(await page.evaluate(() => (window as any).fixture.draftValue("first", "missing")), "")
      await checkpointAfter(() => page.evaluate(() => (window as any).fixture.appear()))
      assert.equal(await page.evaluate(() => (window as any).fixture.draftValue("first", "missing")), "preserved",
        `${host}: a newly available working session hydrates its preserved draft into the live store`)
      const initial = await count(), hydrated = await page.evaluate(() => (window as any).fixture.hydrated())
      assert.ok(initial > 0, `${host}: initial checkpoint`)
      assert.ok(hydrated > 0, "preserved-prompt hydration actually ran")
      await usage(); await usage("second", "child"); await settle()
      assert.equal(await count(), initial, `${host}: busy usage must not checkpoint`)
      assert.equal(await page.evaluate(() => (window as any).fixture.hydrated()), hydrated, "busy usage must not rehydrate preserved drafts")
      assert.equal((await state()).tabs[1].generationRecovery.child, "working")

      for (let elapsed = 0; elapsed < 2_600; elapsed += 100) {
        if (elapsed % 200 === 0) await change("title")
        if (elapsed % 300 === 0) await page.evaluate(elapsed => (window as any).fixture.draft(`ongoing ${elapsed}`), elapsed)
        if (elapsed === 1_200) await page.evaluate(() => (window as any).fixture.deleteFirstChild())
        if (elapsed === 1_500) await page.evaluate(() => (window as any).fixture.settleChild())
        await page.clock.runFor(100)
      }
      await waitForCommit(initial + 1)
      const checkpoint = await page.evaluate(async () => {
        const w = window as any
        const [first, second] = (await w.fixture.decode(w.persisted)).session.tabs
        return { draft: first.drafts.parent, title: first.sessionCatalog[0].title, ids: first.sessionCatalog.map((row: any) => row.id),
          idle: second.unseenIdleSince.child, recovery: second.generationRecovery.child }
      })
      assert.equal(checkpoint.draft, "ongoing 1800")
      assert.equal(checkpoint.title, "parent", "the deadline reuses the encoded catalog")
      assert.ok(!checkpoint.ids.includes("child"), "a confirmed deletion fences the reused catalog")
      assert.equal(typeof checkpoint.idle, "number", "the deadline includes a settlement during typing")
      assert.equal(checkpoint.recovery, undefined, "the saved running marker is cleared at the deadline")
      await settle(initial + 2)
      assert.notEqual((await state()).tabs[0].sessionCatalog[0].title, checkpoint.title, "quiet capture catches up the catalog")

      const beforeExpansion = await count()
      await page.evaluate(() => (window as any).fixture.expand())
      for (let elapsed = 0; elapsed < 2_600; elapsed += 200) {
        await change("title")
        await page.clock.runFor(200)
      }
      await waitForCommit(beforeExpansion + 1)
      assert.ok(await page.evaluate(async () => {
        const w = window as any
        return (await w.fixture.decode(w.persisted)).session.tabs[0].expandedSessionIds.includes("parent")
      }), "expansion persists during catalog traffic without a draft edit")

      const beforeExplicit = await count()
      await page.evaluate(() => (window as any).fixture.draft("flush before quiet"))
      assert.equal(await count(), beforeExplicit)
      await page.evaluate(() => (window as any).__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__())
      assert.equal(await count(), beforeExplicit + 1)
      assert.equal((await state()).tabs[0].drafts.parent, "flush before quiet")

      for (const phase of ["close", "navigation"] as const) await t.test(`bridge ${host === "electron" ? 1 : 2}: a held ${phase} write rejects late typing and unlocks on cancellation`, async () => {
        const generation = phase === "close" ? 1 : 101
        const input = page.locator("#close-draft")
        await page.evaluate(({ host, phase, generation }) => {
          const w = window as any
          const input = document.querySelector<HTMLTextAreaElement>("#close-draft")!
          input.value = `typed before ${phase}`
          input.focus()
          input.setSelectionRange(input.value.length, input.value.length)
          input.dispatchEvent(new Event("input"))
          delete w.finishHeldCommit
          w.holdNextCommit = true
          if (host === "tauri") w.emit(phase === "close" ? "client-state:flush-requested" : "client-state:navigation-flush-requested", generation)
          else w.preparing = w.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__(phase === "close" ? "prepare" : "navigation")
        }, { host, phase, generation })
        await page.waitForFunction(() => Boolean((window as any).finishHeldCommit))
        await page.keyboard.type(" typed while saving")
        if (phase === "close") await page.evaluate(() => (window as any).fixture.editWhileClosing())
        await page.evaluate(async host => {
          const w = window as any
          w.finishHeldCommit()
          if (host === "electron") await w.preparing
        }, host)
        if (host === "tauri") await page.waitForFunction(generation => (window as any).acks.some((ack: any) => ack.generation === generation), generation)
        assert.deepEqual(deletes, [], "no records are released before approval")
        const [saved, live] = await page.evaluate(async () => {
          const w = window as any
          const snapshot = await w.fixture.decode(w.persisted)
          return [snapshot.session.tabs[0].drafts.parent, w.fixture.draftValue("first", "parent")]
        })
        await page.evaluate(async ({ host, phase, generation }) => {
          const w = window as any
          if (host === "tauri") w.emit(phase === "close" ? "client-state:flush-cancelled" : "client-state:navigation-flush-cancelled", generation)
          else await w.__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__(phase === "close" ? "cancel" : "navigation-cancel")
        }, { host, phase, generation })
        assert.equal(await page.evaluate(() => document.documentElement.inert), false, "the cancellation reached the renderer")
        // Let the one-off resumed capture finish before testing the subscription.
        await settle()
        await checkpointAfter(() => input.fill("typed after cancellation", { timeout: 5_000 }))
        const persisted = await page.evaluate(async () => {
          const w = window as any
          return (await w.fixture.decode(w.persisted)).session.tabs[0].drafts.parent
        })
        assert.equal(persisted, "typed after cancellation")
        assert.deepEqual([saved, live], [`typed before ${phase}`, `typed before ${phase}`])
      })

      await checkpointAfter(() => page.evaluate(() => (window as any).fixture.draft("edited")))
      let saved = await state()
      assert.equal(saved.tabs[0].drafts.parent, "edited")
      assert.equal(saved.tabs[0].drafts.missing, "preserved")
      assert.equal(saved.tabs[0].sessionCatalog[0].cost, 1)
      assert.equal(saved.tabs[1].sessionCatalog[1].tokens.cache.write, 1)
      // Discover catalogue scalars from the real capture consumer, including optional metadata.
      const catalog = await page.evaluate(() => (window as any).fixture.catalog())
      const scalars = scalarEntries(catalog[0])
      const usageScalars = scalars.filter(([path]) => path === "cost" || path.startsWith("tokens."))
      for (const [path, value] of scalars.filter(([path]) => path !== "id" && path !== "cost" && !path.startsWith("tokens."))) {
        const next = typeof value === "number" ? value + 1 : value === null ? "another-parent" : `${value}-changed`
        await mutate(path, next)
        const captured = scalarEntries((await state()).tabs[0].sessionCatalog[0])
        assert.equal(new Map(captured).get(path), next, `${host}: captured ${path} stays fresh`)
      }
      for (const [from, to] of [["missing", "renamed"], ["renamed", "missing"]]) {
        const before = await count()
        await checkpointAfter(() => page.evaluate(([from, to]) => (window as any).fixture.rename(from, to), [from, to]))
        assert.equal(await count(), before + 1, "same-cardinality session identity changes checkpoint")
        assert.ok((await state()).tabs[0].sessionCatalog.some((row: any) => row.id === to))
      }
      await change("compacting"); await settle()
      let before = await count()
      await usage(); await settle()
      assert.equal(await count(), before, "compacting usage is deferred")
      await change("idle"); await settle()
      assert.equal((await state()).tabs[0].sessionCatalog[0].cost, 2)
      before = await count()
      await checkpointAfter(() => usage())
      assert.equal(await count(), before + 1, "late idle usage checkpoints")
      for (const [path] of usageScalars) {
        const value = new Map(scalarEntries((await state()).tabs[0].sessionCatalog[0])).get(path) + 1
        await mutate(path, value)
        assert.equal(new Map(scalarEntries((await state()).tabs[0].sessionCatalog[0])).get(path), value)
      }
      await mutate("generationRecovery", "pending")
      await mutate("idleSince", 1)
      await checkpointAfter(() => page.evaluate(() => (window as any).fixture.seen()))
      assert.equal((await state()).tabs[0].seenInterruptions.parent, 1)
      await mutate("generationRecovery", null)
      await mutate("runtimeStatusKnown", true, 0)
      await mutate("outcome", "succeeded", 0)
      assert.equal((await state()).tabs[0].seenInterruptions.parent, 1, "the same idle boundary keeps acknowledgement")
      await mutate("time.idle", 2)
      assert.equal((await state()).tabs[0].seenInterruptions?.parent, undefined, "native settlement past the seen boundary drops its saved marker")
      // Runtime-only fields checkpoint but persist nothing, so they write nothing.
      await mutate("time.busy", 2, 0)
      for (const field of ["pendingPermission", "pendingForm"]) {
        await mutate(field, true, 0)
        await mutate(field, false, 0)
      }
      await mutate("retry", { attempt: 1, message: "retry", next: 1 }, 0)
      await mutate("retry.attempt", 2, 0)
      await mutate("retry.message", "changed", 0)
      await mutate("retry.next", 2, 0)
      await mutate("retry", null, 0)
      await mutate("generationRecovery", "interrupted")
      saved = await state()
      assert.equal(saved.tabs[0].generationRecovery.parent, "interrupted")
      assert.equal(saved.tabs[0].unseenIdleSince.parent, 1)
      await change("working"); await settle()
      const costBeforeFlush = (await state()).tabs[0].sessionCatalog[0].cost
      await usage()
      // An explicit native flush always reads live counters, including deferred usage.
      if (host === "electron") await page.evaluate(() => (window as any).__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__())
      else {
        await page.evaluate(() => (window as any).emit("client-state:navigation-flush-requested", 7))
        await page.waitForFunction(() => (window as any).acks.some((ack: any) => ack.generation === 7))
      }
      assert.equal((await state()).tabs[0].sessionCatalog[0].cost, costBeforeFlush + 1)
      await checkpointAfter(() => page.evaluate(() => (window as any).fixture.attach()))
      assert.equal((await state()).tabs[0].attachments.parent[0].filename, "note.txt")
      await checkpointAfter(() => change("parent", "second", "child"))
      assert.equal((await state()).tabs[1].sessionCatalog[1].parentId, null)
      await checkpointAfter(() => page.evaluate(() => (window as any).fixture.remove()))
      assert.equal((await state()).tabs[1].sessionCatalog.length, 1)

      before = await count()
      await checkpointAfter(() => page.evaluate(() => { (window as any).mode = "fail"; (window as any).fixture.draft("failed write") }), 2)
      assert.equal(await count(), before + 2, "a failed delta retries with the complete graph")
      await page.evaluate(() => { (window as any).mode = "accept"; return (window as any).fixture.flushStore() })
      assert.equal(await count(), before + 3, "explicit flush retains dirty work after failure")

      // Decode the full graph published by the mock host, not just the last delta.
      const decoded = await page.evaluate(async () => {
        const w = window as any
        return { state: await w.fixture.decode(w.persisted), tokens: w.receipts.map((r: any) => r.token) }
      })
      assert.deepEqual(decoded.state.session, await state())
      assert.equal(new Set(decoded.tokens).size, 1, "one native owner token")
      if (host === "tauri") {
        await page.evaluate(() => (window as any).emit("client-state:flush-requested", 6, "local-other", 5))
        await settle()
        assert.deepEqual(deletes, [], "approving another Tauri window's close cannot release this window's records")
        assert.equal(await page.evaluate(() => (window as any).acks.some((ack: any) => ack.generation === 6)), false)
        await page.evaluate(() => (window as any).emit("client-state:flush-requested", 8))
        await page.waitForFunction(() => (window as any).acks.some((ack: any) => ack.generation === 8))
        before = await count()
        await change("title"); await settle()
        assert.equal(await count(), before, "shutdown suppresses reactive capture")
        await page.evaluate(() => (window as any).emit("client-state:flush-cancelled", 9)); await settle()
        assert.equal(await count(), before, "another shutdown generation cannot resume capture")
        await checkpointAfter(() => page.evaluate(() => (window as any).emit("client-state:flush-cancelled", 8)))
        assert.equal(await count(), before + 1, "own cancellation resumes capture")
      }
      await checkpointAfter(() => page.evaluate(() => { (window as any).mode = "refuse"; (window as any).fixture.draft("rejected write") }))
      assert.equal(await page.evaluate(() => (window as any).fixture.primary()), false, "refusal revokes native ownership")
      before = await count()
      await change("title"); await settle()
      assert.equal(await count(), before, "secondary renderer cannot write")
      await page.evaluate(() => (window as any).fixture.dispose())
      before = await count()
      await change("title"); await settle()
      assert.equal(await count(), before, "disposed hook releases reactive ownership")
      assert.deepEqual(errors, [])
      await page.close()
    }
  } finally { await browser.close(); await fixture.close() }
})
