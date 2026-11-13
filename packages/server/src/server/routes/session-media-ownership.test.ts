import assert from "node:assert/strict"
import { test } from "node:test"
import fs from "node:fs/promises"
import crypto from "node:crypto"
import { syncBuiltinESMExports } from "node:module"
import path from "node:path"
import os from "node:os"
import { execFileSync } from "node:child_process"
import { setImmediate } from "node:timers/promises"
import { crc32 } from "node:zlib"
import Fastify from "fastify"
import pino from "pino"
import { OpenCode } from "@opencode/client"
import { deferToolMedia, INLINE_MEDIA_LIMIT, mediaDigest } from "../../opencode/session-media"
import { MESSAGE_LIMIT, parseSessionMediaPath } from "../../opencode/session-media-contract"

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test("media ownership retains real manager, physical worktrees and connection custody", async t => {
  // Install the targeted physical hold before importing the manager, as in the
  // existing builtin-I/O mock tests. No ownership implementation is substituted.
  const realpath = fs.realpath
  let physicalError: { directory: string; code: string } | undefined
  let physical: { directory: string; entered: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>> } | undefined
  t.mock.method(fs, "realpath", (async (...args: Parameters<typeof fs.realpath>) => {
    if (physicalError && String(args[0]) === physicalError.directory) {
      throw Object.assign(new Error("indeterminate physical fixture"), { code: physicalError.code })
    }
    const held = physical
    if (held && String(args[0]) === held.directory) {
      physical = undefined; held.entered.resolve(); await held.release.promise
    }
    return realpath(...args)
  }) as typeof fs.realpath)
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const { WorkspaceManager } = await import("../../workspaces/manager")
  const { OpenCodeSharedService } = await import("../../workspaces/opencode-service")
  const { rememberRuntime } = await import("../../opencode/compatibility/runtime")
  const { createSessionMediaFetch } = await import("../../opencode/session-media-fetch")
  const { EventBus } = await import("../../events/bus")
  const { registerSessionMediaRoutes } = await import("./session-media")

  async function fixture(nested = false, wsl = false) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "media-owned-"))
    const repo = path.join(temp, "repo"), linked = path.join(temp, "linked")
    const git = (...args: string[]) => execFileSync("git", args, { stdio: "pipe", windowsHide: true })
    git("init", repo)
    await fs.mkdir(path.join(repo, "nested"))
    await fs.writeFile(path.join(repo, "nested", "tracked"), "fixture")
    git("-C", repo, "add", ".")
    git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture")
    git("-C", repo, "worktree", "add", "-b", "linked", linked)
    const root = await realpath(nested ? path.join(repo, "nested") : repo)
    const target = await realpath(nested ? path.join(linked, "nested") : linked)
    const alias = path.join(temp, "alias")
    await fs.symlink(target, alias, "junction")
    const toService = (directory: string) => wsl ? directory === root ? "/fixture/repo" : directory === target ? "/fixture/linked" : directory : directory
    const toHost = (directory: string) => directory === "/fixture/repo" ? root : directory === "/fixture/linked" ? target : directory
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64")
    const text = Buffer.from(`padding\0${"x".repeat(25_000)}`), chunk = Buffer.alloc(text.length + 12)
    chunk.writeUInt32BE(text.length); chunk.write("tEXt", 4); text.copy(chunk, 8)
    chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
    const bytes = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)])
    const uri = `data:image/png;base64,${bytes.toString("base64")}`
    assert(uri.length > INLINE_MEDIA_LIMIT)
    let directory = toService(target), stage = "", sessionReads = 0, sends = 0, invalidations = 0
    let preparation: (() => Promise<boolean>) | undefined, preparations = 0
    let message: any = { id: "m", type: "assistant", content: [{ type: "tool", state: { content: [{ type: "file", mime: "image/png", uri }] } }] }
    let revert: { messageID: string } | undefined
    const entered = deferred(), release = deferred(), returned = deferred()
    let gate = { entered, release }
    const gates = [gate]
    const events: string[] = [], hosts: ReturnType<typeof Fastify>[] = []
    async function host(label: string) {
      const app = Fastify({ keepAliveTimeout: 1000 }); hosts.push(app)
      app.addHook("onRequest", async request => {
        assert.equal(request.headers.authorization, `Basic ${Buffer.from(`${label}:fixture`).toString("base64")}`)
      })
      async function hold(name: string) {
        events.push(`${label}:${name}`)
        if (name === stage) { const held = gate; stage = ""; held.entered.resolve(); await held.release.promise }
      }
      app.get("/api/location", async request => {
        await hold("location")
        assert.equal((request.query as Record<string, string>)["location[directory]"], toService(root))
        return { directory: toService(root), project: { id: "fixture", directory: toService(await realpath(repo)), canonical: toService(await realpath(repo)) } }
      })
      app.post("/api/worktree/refresh", async (_request, reply) => {
        await hold("refresh")
        if (invalidations > 0) { invalidations--; manager.invalidateWorktrees("blocking") }
        return reply.code(204).send()
      })
      app.get("/api/worktree", async () => {
        await hold("list")
        return [{ directory: toService(await realpath(repo)) }, { directory: toService(await realpath(linked)) }]
      })
      app.get("/api/session/s", async () => {
        await hold(`session${++sessionReads}`)
        return { data: { id: "s", location: { directory }, ...(revert ? { revert } : {}) } }
      })
      app.get("/api/session/s/message/m", async () => {
        await hold("message")
        assert(Buffer.byteLength(JSON.stringify({ data: message })) < MESSAGE_LIMIT)
        return { data: message }
      })
      await app.listen({ host: "127.0.0.1", port: 0 })
      const endpoint = { url: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`,
        auth: { type: "basic" as const, username: label, password: "fixture" } }
      rememberRuntime(endpoint, { version: "2.2.3", pid: label === "A" ? 1 : 2, discovery: "info" })
      return endpoint
    }
    const a = await host("A"), b = await host("B")
    let endpoint = a
    const lifecycle = { discover: async () => endpoint, ensure: async () => endpoint }
    const service = new OpenCodeSharedService()
    const manager = new WorkspaceManager({ rootDir: temp, sharedService: service, eventBus: new EventBus(),
      logger: pino({ level: "silent" }), settings: { getOwner: () => ({ environmentVariables: {} }) } as never,
      binaryResolver: { resolveDefault: () => ({ path: wsl ? String.raw`\\wsl.localhost\Fixture\home\test\opencode` : process.execPath, label: "fixture" }) } as never,
      hostServiceLifecycleFactory: () => lifecycle,
      ...(wsl ? { platform: "win32" as const, wslServiceLifecycleFactory: () => lifecycle,
        wslServiceDirectoryResolver: toService, wslHostDirectoryResolver: toHost } : {}),
      prepareDesktopPlugins: async () => { preparations++; return preparation ? preparation() : false },
    })
    const { workspace } = await manager.create(root)
    const records = (manager as any).workspaces as Map<string, any>
    const record = records.get(workspace.id)
    records.delete(workspace.id); record.id = "lab~same"; records.set(record.id, record)
    const id = record.id as string, connection = service.existingConnection()!
    let sharedClients = 0, mediaNativeReads = 0
    const sharedClient = manager.getSharedServiceClient.bind(manager), nativeFetch = connection.fetch
    manager.getSharedServiceClient = () => { sharedClients++; return sharedClient() }
    connection.fetch = (...args: Parameters<typeof nativeFetch>) => {
      const url = new URL(args[0] instanceof Request ? args[0].url : String(args[0]))
      if (["/api/location", "/api/worktree", "/api/worktree/refresh"].includes(url.pathname)) {
        assert(args[1]?.signal instanceof AbortSignal)
        assert.equal(url.origin, new URL(a.url).origin)
        mediaNativeReads++
      }
      return nativeFetch(...args)
    }
    const ownerships: Promise<boolean>[] = [], owns = manager.ownsLocation.bind(manager)
    manager.ownsLocation = (...args: Parameters<typeof owns>) => {
      const pending = owns(...args); ownerships.push(pending); void pending.catch(() => {}); return pending
    }
    const app = Fastify()
    registerSessionMediaRoutes(app, { workspaceManager: manager })
    app.addHook("onSend", async (_request, _reply, payload) => { sends++; return payload })
    events.length = 0; preparations = 0
    const url = () => `/api/workspaces/${id}/session-media/s/m/0/0/${mediaDigest(uri)}`
    return { app, manager, service, id, root, target, alias, bytes, uri, events, entered, release, returned, connection, record, records,
      url, counts: () => ({ sends, preparations, sharedClients, mediaNativeReads }),
      setDirectory: (value: string) => { directory = value },
      hold: (value: string) => { stage = value; gate = { entered: deferred(), release: deferred() }; gates.push(gate); return gate },
      drained: () => Promise.allSettled(ownerships),
      invalidate: (count: number) => { invalidations = count },
      prepare: (callback: () => Promise<boolean>) => { preparation = callback },
      message: (value: any) => { message = value }, undo: () => { revert = { messageID: "m" } },
      replace: async () => { service.invalidate(); endpoint = b; return service.acquire() },
      close: async () => { for (const gate of gates) gate.release.resolve(); await app.close(); await manager.shutdown(); await Promise.allSettled(ownerships); for (const host of hosts) await host.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5 }) },
    }
  }

  await t.test("root, cold linked worktree, nested projection and dense producer envelope remain real positives", async () => {
    for (const nested of [false, true]) {
      const f = await fixture(nested)
      try {
        f.setDirectory(f.root)
        const root = await f.app.inject(f.url())
        assert.equal(root.statusCode, 200); assert.deepEqual(root.rawPayload, f.bytes)
        assert.deepEqual(f.events, ["A:session1", "A:message", "A:session2"])
        f.events.length = 0; f.setDirectory(f.target)
        const cold = await f.app.inject(f.url())
        assert.equal(cold.statusCode, 200); assert.deepEqual(cold.rawPayload, f.bytes)
        assert.equal(cold.headers["x-content-type-options"], "nosniff")
        assert.equal(cold.headers["content-security-policy"], "default-src 'none'; sandbox")
        assert.equal(cold.headers["cache-control"], "private, max-age=31536000, immutable")
        assert.deepEqual(f.events.filter(value => /location|refresh|list/.test(value)), Array(2).fill(["A:location", "A:refresh", "A:list"]).flat())
        assert.equal(f.counts().mediaNativeReads, 6); assert.equal(f.counts().sharedClients, 0)
        f.setDirectory(f.alias)
        assert.deepEqual((await f.app.inject(f.url())).rawPayload, f.bytes)
        f.setDirectory(f.target)
        const files = Array(100002).fill(null); files[100000] = { type: "file", mime: "image/png", uri: f.uri }
        files[100001] = { type: "file", mime: "image/png", uri: f.uri }
        const original = { id: "m", type: "assistant", content: [{ type: "tool", state: { content: files } }] }
        f.message(original)
        assert(Buffer.byteLength(JSON.stringify({ data: original })) < MESSAGE_LIMIT)
        const deferred = structuredClone(original)
        deferToolMedia([deferred], { workspaceId: f.id, sessionId: "s" })
        assert(parseSessionMediaPath(deferred.content[0].state.content[100000].uri))
        assert.equal(deferred.content[0].state.content[100001].uri, f.uri)
        const served = await f.app.inject(deferred.content[0].state.content[100000].uri)
        assert.equal(served.statusCode, 200); assert.deepEqual(served.rawPayload, f.bytes)
        const reference = deferred.content[0].state.content[100000].uri as string
        assert.equal((await f.app.inject(reference.slice(0, -1) + (reference.endsWith("0") ? "1" : "0"))).statusCode, 404)
        f.undo(); assert.equal((await f.app.inject(deferred.content[0].state.content[100000].uri)).statusCode, 404)
      } finally { await f.close() }
    }
  })

  await t.test("a missing nested project in a registered sibling checkout still serves exact PNG bytes", async () => {
    const f = await fixture(true)
    try {
      await fs.rm(f.target, { recursive: true })
      assert.equal(await f.manager.ownsLocation(f.id, { directory: f.target }), true)
      const response = await f.app.inject(f.url())
      assert.equal(response.statusCode, 200)
      assert.deepEqual(response.rawPayload, f.bytes)
      assert.equal(response.headers["content-type"], "image/png")
    } finally { await f.close() }
  })

  await t.test("WSL adapters preserve service and physical namespaces on the real ownership path", async () => {
    const f = await fixture(false, true)
    try {
      const response = await f.app.inject(f.url())
      assert.equal(response.statusCode, 200); assert.deepEqual(response.rawPayload, f.bytes)
      assert.equal(f.counts().mediaNativeReads, 6); assert.equal(f.counts().sharedClients, 0)
    } finally { await f.close() }
  })

  await t.test("missing-path admission still refuses broken links, invalid checkouts and indeterminate ancestors", async () => {
    for (const mode of ["broken-link", "invalid-checkout", "EACCES", "EIO"]) {
      const f = await fixture(true)
      try {
        await fs.rm(f.target, { recursive: true })
        if (mode === "broken-link") f.setDirectory(path.join(f.alias, "missing"))
        else if (mode === "invalid-checkout") await fs.rm(path.join(path.dirname(f.target), ".git"))
        else physicalError = { directory: path.dirname(f.target), code: mode }
        const response = await f.app.inject(f.url())
        assert([403, 502].includes(response.statusCode), mode)
        assert.equal(response.headers["content-type"], "application/json; charset=utf-8")
        assert(!f.events.includes("A:message"), "refusal precedes the message read")
        assert(!f.events.includes("A:session2"), "refusal precedes the dependent session read")
      } finally { physicalError = undefined; await f.close() }
    }
  })

  await t.test("physical hold rejects retired A and exact-record ABA before any catalogue acquisition", async st => {
    for (const mode of ["connection", "ABA"]) {
      const f = await fixture(), held = { directory: f.target, entered: deferred(), release: deferred() }
      const next = mode === "ABA" ? await f.manager.create(f.root) : undefined
      const successor = next ? f.records.get(next.workspace.id) : undefined
      f.events.length = 0
      const original = f.manager.ownsLocation.bind(f.manager)
      let settled!: Promise<boolean>
      st.mock.method(f.manager, "ownsLocation", (...args: Parameters<typeof original>) => {
        settled = original(...args); void settled.then(() => f.returned.resolve(), () => f.returned.resolve()); return settled
      })
      try {
        physical = held
        const pending = f.app.inject(f.url())
        void pending.catch(() => {})
        await held.entered.promise
        const prefix = [...f.events]
        if (mode === "connection") await f.replace()
        else {
          f.records.delete(f.id); f.records.delete(next!.workspace.id)
          successor.id = f.id; f.records.set(f.id, successor)
        }
        held.release.resolve()
        await pending.catch(() => {}); await f.returned.promise; await assert.rejects(settled)
        assert.deepEqual(f.events, prefix); assert.equal(f.counts().sends, 0)
        assert.equal(f.counts().sharedClients, 0)
      } finally { physical = undefined; held.release.resolve(); await f.close() }
    }
  })

  await t.test("cold location/refresh/list holds never dispatch the next operation or use B", async () => {
    for (const stage of ["location", "refresh", "list"]) {
      const f = await fixture()
      try {
        const gate = f.hold(stage)
        const pending = f.app.inject(f.url())
        void pending.catch(() => {})
        await gate.entered.promise
        const prefix = [...f.events]
        await f.replace(); gate.release.resolve(); await pending.catch(() => {}); await f.drained()
        assert.deepEqual(f.events, prefix); assert.equal(f.counts().sends, 0)
        assert.equal(f.counts().sharedClients, 0)
      } finally { await f.close() }
    }
  })

  await t.test("private invalidation converges cold and repeated invalidation has a bounded budget", async () => {
    for (const count of [1, 100]) {
      const f = await fixture()
      try {
        f.invalidate(count)
        const response = await f.app.inject(f.url())
        assert.equal(response.statusCode, count === 1 ? 200 : 502)
        assert.equal(f.events.filter(value => value === "A:refresh").length, count === 1 ? 3 : 4)
        assert.equal(f.events.some(value => value.startsWith("B:")), false)
      } finally { await f.close() }
    }
  })

  await t.test("a private observer neither joins nor cancels the ordinary pending inventory", async () => {
    const f = await fixture(), abort = new AbortController()
    try {
      await f.manager.getWorktrees(f.id, "fresh")
      const ordinaryGate = f.hold("refresh")
      const ordinary = f.manager.getWorktrees(f.id, "fresh")
      let ordinarySettled = false
      void ordinary.then(() => { ordinarySettled = true }, () => { ordinarySettled = true })
      await ordinaryGate.entered.promise
      const privateGate = f.hold("location")
      const client = OpenCode.make({ baseUrl: f.connection.endpoint.url, fetch: createSessionMediaFetch(f.connection, abort.signal, () => {}) })
      const privateRead = f.manager.ownsLocation(f.id, { directory: f.target }, client, { signal: abort.signal, strict: true,
        media: { current: () => { abort.signal.throwIfAborted(); f.connection.assertCurrent() } } })
      const rejected = assert.rejects(privateRead)
      await privateGate.entered.promise
      abort.abort()
      privateGate.release.resolve(); await rejected
      assert.equal(ordinarySettled, false)
      ordinaryGate.release.resolve()
      assert.equal((await ordinary).worktrees.length, 2)
      f.connection.assertCurrent()
      assert.equal((await f.manager.getWorktrees(f.id)).worktrees.length, 2)
    } finally { f.release.resolve(); await f.close() }
  })

  await t.test("real shared preparation keeps its other waiter on late resolution and rejection", async () => {
    for (const outcome of ["resolve", "reject"]) {
      const f = await fixture(), prepared = deferred<boolean>(), started = deferred()
      const unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error) }
      process.on("unhandledRejection", onUnhandled)
      try {
        f.prepare(() => { started.resolve(); return prepared.promise })
        const pending = f.app.inject(f.url())
        void pending.catch(() => {})
        await started.promise
        const other = f.service.acquire()
        const observed = other.then(value => value, error => error)
        await f.manager.delete(f.id)
        await pending.catch(() => {})
        assert.equal(f.counts().preparations, 1)
        assert.equal(f.events.length, 0)
        f.connection.assertCurrent()
        const failure = new Error("late preparation rejection")
        if (outcome === "resolve") prepared.resolve(true)
        else prepared.reject(failure)
        assert.equal(await observed, outcome === "resolve" ? f.connection : failure)
        await setImmediate(); await setImmediate()
        assert.deepEqual(unhandled, [])
        assert.equal(f.events.length, 0); assert.equal(f.counts().sends, 0)
        f.connection.assertCurrent()
      } finally { prepared.resolve(true); process.removeListener("unhandledRejection", onUnhandled); await f.close() }
    }
  })

  await t.test("last real ownership revalidation fences digest, base64 decoding and send", async st => {
    for (const revoke of [false, true]) {
      const f = await fixture()
      let digests = 0, decodes = 0, ownership = 0
      const createHash = crypto.createHash, from = Buffer.from, owns = f.manager.ownsLocation.bind(f.manager)
      const url = f.url()
      st.mock.method(crypto, "createHash", (...args: Parameters<typeof createHash>) => {
        const hash = createHash(...args), update = hash.update.bind(hash)
        hash.update = ((value: any, ...rest: any[]) => { if (value === f.uri) digests++; return (update as any)(value, ...rest) }) as typeof hash.update
        return hash
      })
      st.mock.method(Buffer, "from", ((...args: any[]) => { if (args[0] === f.uri.slice(f.uri.indexOf(",") + 1) && args[1] === "base64") decodes++; return (from as any)(...args) }) as typeof from)
      st.mock.method(f.manager, "ownsLocation", async (...args: Parameters<typeof owns>) => {
        const result = await owns(...args)
        if (++ownership === 2 && revoke) f.service.invalidate()
        return result
      })
      syncBuiltinESMExports()
      try {
        const pending = f.app.inject(url)
        if (revoke) await pending.catch(() => {})
        else { const response = await pending; assert.equal(response.statusCode, 200); assert.deepEqual(response.rawPayload, f.bytes) }
        assert.equal(ownership, 2)
        assert.deepEqual({ digests, decodes, sends: f.counts().sends }, revoke ? { digests: 0, decodes: 0, sends: 0 } : { digests: 1, decodes: 1, sends: 1 })
      } finally { st.mock.restoreAll(); syncBuiltinESMExports(); await f.close() }
    }
  })
})
