import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"
import { setupMissionsPlugin } from "./missions-plugin"

test("independent plugin bundles preserve project CAS exclusion across dispose/setup", async t => {
  const directory = await mkdtemp(join(tmpdir(), "missions-reload-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const bundles = await Promise.all(["old", "new"].map(async name => {
    const outfile = join(directory, `${name}.mjs`)
    await build({ entryPoints: [fileURLToPath(new URL("./missions-plugin.ts", import.meta.url))],
      outfile, bundle: true, platform: "node", format: "esm" })
    return import(pathToFileURL(outfile).href)
  }))
  const values = new Map<string, unknown>()
  let pauseScan = false
  let paused!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => { paused = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const registration = () => ({ dispose: async () => {} })
  const rpcContext = { error: (type: string, message: string, data: unknown) => {
    throw Object.assign(new Error(message), { type, data })
  } }
  async function setup(bundle: typeof bundles[number], old: boolean) {
    let handlers: any
    const dispose = await bundle.setupMissionsPlugin({
      location: { directory: "/reload-repo", project: { id: "reload-project", canonical: "/reload-repo" } },
      storage: {
        get: async (key: string) => structuredClone(values.get(key)),
        set: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
        scan: async ({ prefix }: { prefix: string }) => {
          const entries = [...values].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) }))
          if (old && pauseScan) { pauseScan = false; paused(); await gate }
          return { entries }
        },
      },
      session: {
        get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, title: "Coordinator",
          projectID: "reload-project", location: { directory: "/reload-repo" } }),
        hook: async () => registration(),
      },
      tool: { transform: async () => registration() },
      rpc: { register: async (_definition: unknown, registered: unknown) => {
        handlers = registered
        return { ...registration(), events: { emit: async () => {} } }
      } },
    })
    t.after(dispose)
    return { handlers, dispose }
  }
  const old = await setup(bundles[0], true)
  const { mission } = await old.handlers.create({ requestID: "create", objective: "Original", template: "custom", coordinatorSessionID: "ses_coordinator" })
  pauseScan = true
  const first = old.handlers.update({ missionID: mission.id, requestID: "old-edit", expectedRevision: 1, objective: "Old edit" }, rpcContext)
  await entered
  let drained = false
  const closing = old.dispose().then(() => { drained = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(drained, false, "old writer disposal waits for its admitted RPC")
  release()
  await closing
  const current = await setup(bundles[1], false)
  const second = current.handlers.update({ missionID: mission.id, requestID: "new-edit", expectedRevision: 1, objective: "New edit" }, rpcContext)
  const outcomes = await Promise.allSettled([first, second])
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1)
  const rejection = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult
  assert.match(rejection.reason.message, /retired|no longer available|Mission changed/)
  const snapshot = await current.handlers.snapshot({})
  assert.equal(snapshot.missions[0].revision, 2)
  assert.equal(snapshot.missions[0].history.length, 1)
})

test("class-backed storage and real RPC/tool callbacks drain an asynchronous journal set before disposal", async t => {
  for (const entry of ["rpc", "tool"] as const) {
    const values = new Map<string, unknown>()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const writing = new Promise<void>(resolve => { entered = resolve })
    t.after(() => release())
    let writes = 0
    class Storage {
      async get(key: string) { return structuredClone(values.get(key)) }
      async scan({ prefix }: { prefix: string }) {
        return { entries: [...values].filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value: structuredClone(value) })) }
      }
      async set(key: string, value: unknown) {
        entered()
        await gate
        writes++
        values.set(key, structuredClone(value))
      }
      async remove(key: string) { values.delete(key) }
    }
    const storage = new Storage()
    assert.equal(Object.prototype.hasOwnProperty.call(storage, "get"), false)
    let handlers: any
    let inspect: any
    const registration = () => ({ dispose: async () => {} })
    const dispose = await setupMissionsPlugin({
      location: { directory: "/retirement-repo", project: { id: "retirement-project", canonical: "/retirement-repo" } },
      storage,
      session: { get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, title: "Coordinator",
        projectID: "retirement-project", location: { directory: "/retirement-repo" } }), hook: async () => registration() },
      tool: { transform: async (transform: any) => {
        transform({ namespace() {}, add(definition: any) { if (definition.name === "inspect") inspect = definition.execute } })
        return registration()
      } },
      rpc: { register: async (_definition: unknown, registered: unknown) => {
        handlers = registered
        return { ...registration(), events: { emit: async () => {} } }
      } },
    } as any)
    t.after(dispose)
    const request = entry === "rpc"
      ? handlers.create({ requestID: "create", objective: "Retire safely", template: "custom", coordinatorSessionID: "ses_coordinator" })
      : inspect({ start: { objective: "Retire safely", template: "custom" } },
        { sessionID: "ses_coordinator", id: "call_create", messageID: "msg_create", progress: async () => {} })
    await writing
    let drained = false
    const closing = dispose().then(() => { drained = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(drained, false, `${entry} disposal cannot outrun storage.set`)
    await assert.rejects(entry === "rpc" ? handlers.create({}) : inspect({}, {}), /no longer available/)
    release()
    await Promise.all([request, closing])
    assert.equal(writes, 1)
    assert.equal(values.size, 1)
  }
})

test("disposal drains the admitted notification outbox callback, not just registrations", async t => {
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const scanning = new Promise<void>(resolve => { entered = resolve })
  t.after(() => release())
  const registration = () => ({ dispose: async () => {} })
  const dispose = await setupMissionsPlugin({
    location: { directory: "/outbox-repo", project: { id: "outbox-project", canonical: "/outbox-repo" } },
    storage: { get: async () => undefined, set: async () => {}, remove: async () => {},
      scan: async () => { entered(); await gate; return { entries: [] } } },
    session: { hook: async () => registration() },
    tool: { transform: async () => registration() },
    rpc: { register: async () => ({ ...registration(), events: { emit: async () => {} } }) },
  } as any)
  t.after(dispose)
  await scanning
  let drained = false
  const closing = dispose().then(() => { drained = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(drained, false, "an outbox run admitted before disposal must finish")
  release()
  await closing
  assert.equal(drained, true)
})
