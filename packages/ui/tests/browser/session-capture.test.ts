import assert from "node:assert/strict"
import { test } from "node:test"
import { chromium } from "playwright"
import { borrowFixture } from "./fixture-borrow"
import { armFixtureNavigationBudget } from "./fixture-navigation-budget"

test("capture defers only busy usage through both real-store effects and keeps fresh checkpoints", async () => {
  const fixture = await borrowFixture({ name: "session-capture", routes: [{ path: "/fixture",
    html: '<html><body><script type="module" src="/tests/browser/fixtures/session-capture.tsx"></script></body></html>',
  }] })
  const browser = await chromium.launch({ executablePath: process.env.CODENOMAD_BROWSER_PATH || undefined })
  armFixtureNavigationBudget(browser)
  try {
    for (const host of ["electron", "tauri"]) {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on("pageerror", error => errors.push(error.message))
      await page.addInitScript(({ host }) => {
        const w = window as any
        w.__name = (value: unknown) => value
        w.__CODENOMAD_RUNTIME_HOST__ = host
        w.__CODENOMAD_WINDOW_CONTEXT__ = "local"
        const callbacks = new Map(), listeners = new Map()
        let sequence = 0
        w.receipts = []; w.acks = []; w.mode = "accept"
        const load = () => ({ isPrimary: true, restoreEnabled: true, snapshot: null, partitionProtocolVersion: 1 })
        const commit = (token: string, payload: unknown) => {
          w.receipts.push({ token, payload: structuredClone(payload) })
          if (w.mode === "fail") throw Error("synthetic write failure")
          return w.mode !== "refuse"
        }
        w.electronAPI = { claimClientStateAccess: async () => true, loadClientState: async () => load(),
          loadClientStatePartition: async () => null, commitClientStatePartitions: async (token: string, payload: unknown) => commit(token, payload) }
        w.__TAURI_INTERNALS__ = {
          transformCallback: (fn: Function) => { callbacks.set(++sequence, fn); return sequence },
          unregisterCallback: (id: number) => callbacks.delete(id),
          invoke: async (command: string, args: any) => {
            if (command === "plugin:event|listen") { listeners.set(args.event, args.handler); return args.handler }
            if (command === "plugin:event|unlisten") { listeners.delete(args.event); return }
            if (command === "client_state_load") return load()
            if (command === "client_state_load_partition") return null
            if (command === "client_state_commit_partitions") return commit(args.accessToken, args.payload)
            if (command.endsWith("flushed")) w.acks.push({ command, generation: args.generation })
            return true
          },
        }
        w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
        w.emit = (event: string, generation: number) => callbacks.get(listeners.get(event))?.({ payload: { generation } })
      }, { host })
      // Production imports may subscribe to SSE; keep that boundary local and inert.
      await page.route("**/api/**", route => route.fulfill({ json: {} }))
      await page.route("**/api/events", route => route.fulfill({ contentType: "text/event-stream", body: ": ready\n\n" }))
      await page.goto(fixture.url)
      await page.waitForFunction(() => Boolean((window as any).fixture))
      const settle = () => page.waitForTimeout(500)
      const count = () => page.evaluate(() => (window as any).receipts.length)
      const state = () => page.evaluate(() => (window as any).fixture.state())
      const change = (field: string, id = "first", sessionId = "parent") =>
        page.evaluate(([field, id, sessionId]) => (window as any).fixture.change(field, id, sessionId), [field, id, sessionId])
      const usage = (id = "first", sessionId = "parent") =>
        page.evaluate(([id, sessionId]) => (window as any).fixture.usage(id, sessionId), [id, sessionId])
      await settle()
      const initial = await count(), hydrated = await page.evaluate(() => (window as any).fixture.hydrated())
      assert.ok(initial > 0, `${host}: initial checkpoint`)
      await usage(); await usage("second", "child"); await settle()
      assert.equal(await count(), initial, `${host}: busy usage must not checkpoint`)
      assert.equal(await page.evaluate(() => (window as any).fixture.hydrated()), hydrated, "busy usage must not rehydrate preserved drafts")

      await page.evaluate(() => (window as any).fixture.draft("edited")); await settle()
      let saved = await state()
      assert.equal(saved.tabs[0].drafts.parent, "edited")
      assert.equal(saved.tabs[0].drafts.missing, "preserved")
      assert.equal(saved.tabs[0].sessionCatalog[0].cost, 1)
      assert.equal(saved.tabs[1].sessionCatalog[1].tokens.cache.write, 1)
      for (const field of ["updated", "created", "archived", "location", "model", "provider", "title"]) {
        const before = await count()
        await change(field); await settle()
        assert.equal(await count(), before + 1, `${host}: in-place ${field} checkpoints`)
      }
      saved = await state()
      const row = saved.tabs[0].sessionCatalog[0]
      assert.deepEqual(row.time, { created: 2, updated: 2, archived: 1 })
      assert.equal(row.location.directory, "/synthetic/first/linked")
      assert.deepEqual(row.model, { providerId: "provider-changed", modelId: "model-changed" })
      await change("compacting"); await settle()
      let before = await count()
      await usage(); await settle()
      assert.equal(await count(), before, "compacting usage is deferred")
      await change("idle"); await settle()
      assert.equal((await state()).tabs[0].sessionCatalog[0].cost, 2)
      before = await count()
      await usage(); await settle()
      assert.equal(await count(), before + 1, "late idle usage checkpoints")
      await change("recovery"); await change("idleSince"); await settle()
      saved = await state()
      assert.equal(saved.tabs[0].generationRecovery.parent, "interrupted")
      assert.equal(saved.tabs[0].unseenIdleSince.parent, 1)
      await change("working"); await settle()
      await usage()
      // An explicit native flush always reads live counters, including deferred usage.
      if (host === "electron") await page.evaluate(() => (window as any).__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__())
      else {
        await page.evaluate(() => (window as any).emit("client-state:navigation-flush-requested", 7))
        await page.waitForFunction(() => (window as any).acks.some((ack: any) => ack.generation === 7))
      }
      assert.equal((await state()).tabs[0].sessionCatalog[0].cost, 4)
      await page.evaluate(() => (window as any).fixture.attach()); await settle()
      assert.equal((await state()).tabs[0].attachments.parent[0].filename, "note.txt")
      await change("parent", "second", "child"); await settle()
      assert.equal((await state()).tabs[1].sessionCatalog[1].parentId, null)
      await page.evaluate(() => (window as any).fixture.remove()); await settle()
      assert.equal((await state()).tabs[1].sessionCatalog.length, 1)

      before = await count()
      await page.evaluate(() => { (window as any).mode = "fail"; (window as any).fixture.draft("failed write") }); await settle()
      assert.equal(await count(), before + 1, "a failed checkpoint attempts one write")
      await page.evaluate(() => { (window as any).mode = "accept"; return (window as any).fixture.flushStore() })
      assert.equal(await count(), before + 2, "explicit flush retains dirty work after failure")

      // The payload still contains complete partitions and an atomically decodable root.
      const decoded = await page.evaluate(async () => {
        const w = window as any
        const receipt = w.receipts.at(-1)
        return { state: await w.fixture.decode(receipt.payload), tokens: w.receipts.map((r: any) => r.token) }
      })
      assert.deepEqual(decoded.state.session, await state())
      assert.equal(new Set(decoded.tokens).size, 1, "one native owner token")
      if (host === "tauri") {
        await page.evaluate(() => (window as any).emit("client-state:flush-requested", 8))
        await page.waitForFunction(() => (window as any).acks.some((ack: any) => ack.generation === 8))
        before = await count()
        await change("title"); await settle()
        assert.equal(await count(), before, "shutdown suppresses reactive capture")
        await page.evaluate(() => (window as any).emit("client-state:flush-cancelled", 9)); await settle()
        assert.equal(await count(), before, "another shutdown generation cannot resume capture")
        await page.evaluate(() => (window as any).emit("client-state:flush-cancelled", 8)); await settle()
        assert.equal(await count(), before + 1, "own cancellation resumes capture")
      }
      await page.evaluate(() => { (window as any).mode = "refuse"; (window as any).fixture.draft("rejected write") }); await settle()
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
