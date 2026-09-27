import assert from "node:assert/strict"
import test from "node:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

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
  await old.dispose()
  const current = await setup(bundles[1], false)
  const second = current.handlers.update({ missionID: mission.id, requestID: "new-edit", expectedRevision: 1, objective: "New edit" }, rpcContext)
  // Let the second bundle attempt entry while the first holds its captured snapshot.
  await new Promise<void>(resolve => setImmediate(resolve))
  release()
  const outcomes = await Promise.allSettled([first, second])
  assert.equal(outcomes.filter(result => result.status === "fulfilled").length, 1)
  const rejection = outcomes.find(result => result.status === "rejected") as PromiseRejectedResult
  assert.match(rejection.reason.message, /Mission changed/)
  const snapshot = await current.handlers.snapshot({})
  assert.equal(snapshot.missions[0].revision, 2)
  assert.equal(snapshot.missions[0].history.length, 1)
})
