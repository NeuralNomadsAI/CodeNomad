// Opt-in, in-process correctness proof. No listener, service discovery, user database or runtime mutation.
// Run with Bun and absolute paths: <isolated-published-package-directory> <fresh-output-directory>.
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { build } from "esbuild"

const [study, output] = process.argv.slice(2)
assert(study && output && path.isAbsolute(study) && path.isAbsolute(output), "Supply absolute private package and fresh output directories")
assert(globalThis.Bun, "This isolated published Core fixture requires Bun")
await fs.mkdir(output) // Refuse overwriting an earlier receipt or fixture.
const repository = fileURLToPath(new URL("../", import.meta.url))
const packageRoot = path.join(study, "node_modules")
const version = JSON.parse(await fs.readFile(path.join(packageRoot, "@opencode/core/package.json"), "utf8")).version
assert(/^2\.0\.\d+$/.test(version), "Use explicit published V2 packages, not an unrelated runtime")
const packages = {}
for (const name of ["core", "server", "plugin", "client", "schema", "protocol", "util"]) {
  const filename = path.join(packageRoot, "@opencode", name, "package.json")
  const content = await fs.readFile(filename, "utf8")
  const metadata = JSON.parse(content)
  assert.equal(metadata.version, version)
  packages[name] = { version: metadata.version, packageSha256: createHash("sha256").update(content).digest("hex") }
}
assert.equal(JSON.parse(await fs.readFile(path.join(packageRoot, "effect/package.json"), "utf8")).version, "4.0.0-rc.112")
const setupReceipt = JSON.parse(await fs.readFile(path.join(study, "setup-receipt.json"), "utf8"))
const sourceReceipt = JSON.parse(await fs.readFile(path.join(study, "source-receipt.json"), "utf8"))
for (const entry of sourceReceipt.published) {
  const content = await fs.readFile(path.join(packageRoot, "@opencode", entry.package, entry.file))
  assert.equal(createHash("sha256").update(content).digest("hex"), entry.sha256, `Published implementation changed: ${entry.file}`)
}
const bundle = path.join(output, "plugin.mjs")
await build({
  entryPoints: [path.join(repository, "packages/server/src/opencode/session-pruning/desktop-plugin.ts")],
  outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22",
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
    // Use verified isolated native packages; no install or shared service discovery.
  plugins: [{ name: "exact-existing-native-packages", setup(build) {
    build.onResolve({ filter: /^(?:@opencode\/|effect(?:\/|$))/ }, async args => {
      if (args.pluginData?.exactNative) return
      return build.resolve(args.path, { resolveDir: study, kind: args.kind, pluginData: { exactNative: true } })
    })
  } }],
})
const localPlugin = path.join(output, "config", "plugins")
const presence = path.join(output, "backend-presence")
const bootstrap = path.join(output, "bootstrap")
const idle = [1, 2, 3].map(n => path.join(output, `idle-${n}`))
for (const directory of [localPlugin, presence, bootstrap, ...idle]) await fs.mkdir(directory, { recursive: true })
const coldWorktrees = [1, 2, 3].map(n => path.join(output, `cold-worktree-${n}`))
execFileSync("git", ["init", "--quiet", bootstrap])
execFileSync("git", ["-C", bootstrap, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "fixture"])
for (const directory of coldWorktrees) execFileSync("git", ["-C", bootstrap, "worktree", "add", "--quiet", "--detach", directory])
// Match production discovery of a managed .ts entry, not configured-package
// directory resolution (which has different host/subpath semantics).
await fs.writeFile(path.join(localPlugin, "codenomad-session-pruning.ts"), `import {desktopPlugin} from ${JSON.stringify(pathToFileURL(bundle).href)}; export default desktopPlugin(${JSON.stringify(presence)});`)
for (const key of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR"]) process.env[key] = output
process.env.OPENCODE_DISABLE_AUTOUPDATE = "true"
process.env.OPENCODE_DB = ":memory:"
const native = (name, file) => import(pathToFileURL(path.join(packageRoot, "@opencode", name, "dist", `${file}.js`)).href)
const { Context, Effect, Layer, RcMap, Logger } = await import(pathToFileURL(path.join(packageRoot, "effect/dist/index.js")).href)
const { HttpEffect, HttpRouter, HttpServer } = await import(pathToFileURL(path.join(packageRoot, "effect/dist/unstable/http/index.js")).href)
const { Global } = await native("util", "global")
const { Location } = await native("core", "location")
const { LocationServiceMap } = await native("core", "location-service-map")
const { Form } = await native("core", "form")
const { Permission } = await native("core", "permission")
const { Session } = await native("core", "session")
const { Plugin } = await native("core", "plugin")
const { Config } = await native("core", "config")
const { createRoutes } = await native("server", "routes")
const locations = Object.fromEntries(["data", "cache", "config", "state", "tmp", "bin", "log", "repos"].map(name => [name, path.join(output, name)]))
const ref = directory => Location.Ref.make({ directory })
const rpc = "/api/rpc/codenomad.pending-requests/snapshot"
const leaseA = path.join(presence, "abc-123.lease"), leaseB = path.join(presence, "def-456.lease")
const booted = []
const receipt = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
  const configured = Layer.unwrap(Effect.gen(function* () {
    const location = yield* Location.Service
    return Config.layer({ project: false, global: location.directory === bootstrap, content: "{}" })
  }))
  const context = yield* Layer.build(createRoutes({
    password: "isolated-stage1-only", database: { path: ":memory:" }, app: { version: packages.core.version },
    models: { fetch: false }, config: { directory: locations.config, project: false, content: "{}" },
    fs: { filewatcher: false }, events: { persist: false },
  }, () => [], [Global.node.replace(Global.layerWith(locations)), Config.node.replace(Config.node.mapLayer(() => configured))]).pipe(Layer.provide(HttpServer.layerServices)))
  const map = Context.get(context, LocationServiceMap.Service)
  const keys = () => RcMap.keys(map.rcMap).pipe(Effect.map(keys => Array.from(keys).map(ref => ({ directory: ref.directory, workspaceID: ref.workspaceID }))))
  const root = yield* map.contextEffect(ref(bootstrap))
  yield* Context.get(root, Plugin.Service).awaitActivation
  const rootSession = yield* Context.get(context, Session.Service).create({ location: ref(bootstrap), title: "Existing Promise RPC check" })
  const seeded = []
  for (const directory of idle) {
    const location = ref(directory), loaded = yield* map.contextEffect(location)
    yield* Context.get(loaded, Plugin.Service).awaitActivation
    assert(!(yield* Context.get(loaded, Plugin.Service).list()).some(plugin => plugin.id === "codenomad-session-pruning"))
    const session = yield* Context.get(context, Session.Service).create({ location, title: "Idle queue fixture", permissions: [{ action: "*", resource: "*", effect: "ask" }] })
    const forms = Context.get(loaded, Form.Service)
    const global = yield* forms.create({ sessionID: "global", title: "Global", fields: [{ key: "number", type: "number", minimum: -Infinity, maximum: Infinity, default: NaN }] })
    const form = yield* forms.create({ sessionID: session.id, title: "Idle", fields: [{ key: "answer", type: "string" }] })
    const permission = yield* Context.get(loaded, Permission.Service).ask({ sessionID: session.id, action: "stage1_fixture", resources: ["fixture-only"] })
    assert.equal(permission.effect, "ask")
    seeded.push({ directory, formIDs: [global.id, form.id], permissionID: permission.id })
  }
  const handler = Context.get(context, HttpRouter.HttpRouter).asHttpEffect().pipe(HttpEffect.toWebHandlerWith(context))
  const requests = []
  const request = (route = rpc, input = { directories: idle }, authorized = true, directory = bootstrap) => Effect.promise(async () => {
    const url = new URL(route, "http://isolated.invalid")
    url.searchParams.set("location[directory]", directory)
    requests.push({ path: url.pathname, directory })
    const response = await handler(new Request(url, { method: "POST", headers: {
      "content-type": "application/json", ...(authorized ? { authorization: `Basic ${btoa("opencode:isolated-stage1-only")}` } : {}),
    }, body: JSON.stringify({ input }) }))
    const text = await response.text()
    assert(text, `Empty HTTP ${response.status} from ${route}`)
    return { status: response.status, body: JSON.parse(text) }
  })
  const waitStatus = Effect.fn("fixture.waitStatus")(function* (status) {
    let last
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = yield* request()
      last = result
      if (result.status === status) return result
      yield* Effect.sleep("200 millis")
    }
    throw new Error(`Presence did not reconcile to HTTP ${status}: ${JSON.stringify({ last, plugins: (yield* Context.get(root, Plugin.Service).list()).filter(plugin => plugin.id === "codenomad-session-pruning") })}`)
  })
  const absent = yield* request()
  assert.equal(absent.status, 400)
  const absentPromise = yield* request("/api/rpc/codenomad.session-pruning/preview", { sessionID: rootSession.id, messageID: "msg_fixture_missing" })
  assert.equal(absentPromise.status, 400)
  yield* Effect.promise(() => fs.writeFile(leaseA, ""))
  yield* waitStatus(200)
  const promise = yield* request("/api/rpc/codenomad.session-pruning/preview", { sessionID: rootSession.id, messageID: "msg_fixture_missing" })
  assert.equal(promise.status, 200)
  assert.deepEqual(promise.body.output, { status: "blocked", reason: "unavailable" })
  const cold = [...coldWorktrees, ...Array.from({ length: 97 }, (_, n) => path.join(output, `cold-${n}`))]
  const before = yield* keys()
  const startsBefore = booted.length, memoryBefore = process.memoryUsage()
  assert(startsBefore >= before.length, "Fixture must observe real native Location boot logs")
  const unauthorized = yield* request(rpc, { directories: idle }, false, cold[0])
  assert.equal(unauthorized.status, 401)
  const snapshots = []
  for (const batch of [cold.slice(0, 60), cold.slice(60)]) {
    const snapshot = yield* request(rpc, { directories: [bootstrap, ...idle, ...batch] })
    assert.equal(snapshot.status, 200)
    assert.equal(snapshot.body.output.originDirectory, bootstrap)
    for (const item of seeded) {
      const placement = snapshot.body.output.data.find(entry => entry.directory === item.directory)
      assert.equal(placement.status, "complete")
      assert.equal(placement.locations.length, 1)
      assert.deepEqual(placement.locations[0].forms.map(form => form.id), item.formIDs)
      assert.deepEqual(placement.locations[0].permissions.map(permission => permission.id), [item.permissionID])
      const numeric = placement.locations[0].forms.find(form => form.sessionID === "global").fields[0]
      assert.equal(numeric.minimum, "-Infinity")
      assert.equal(numeric.maximum, "Infinity")
      assert.equal(numeric.default, "NaN")
    }
    assert(batch.every(directory => snapshot.body.output.data.some(entry => entry.directory === directory && entry.status === "complete" && entry.locations.length === 0)))
    snapshots.push(snapshot)
  }
  assert.deepEqual(yield* keys(), before)
  assert.equal(booted.length, startsBefore, "Recovery must not boot even a temporarily retained cold Location")
  assert.equal((yield* request(rpc, { directories: Array(65).fill(bootstrap) })).status, 400)
  assert.equal((yield* request(rpc, { directories: [bootstrap], version })).status, 400)
  const nonAuthoritative = yield* request(rpc, { directories: ["relative"] })
  assert.equal(nonAuthoritative.status, 400)
  assert.equal(nonAuthoritative.body.type, "unavailable")
  assert.equal((yield* request(rpc, { directories: idle }, true, idle[0])).status, 400)
  yield* Effect.promise(() => fs.writeFile(leaseB, ""))
  const expired = new Date(Date.now() - 60_000)
  yield* Effect.promise(() => fs.utimes(leaseA, expired, expired))
  yield* Effect.sleep("2500 millis")
  assert.equal((yield* request()).status, 200, "Another live backend must keep registration alive")
  yield* Effect.promise(() => fs.utimes(leaseB, expired, expired))
  yield* waitStatus(400)
  assert.equal((yield* request("/api/rpc/codenomad.session-pruning/preview", { sessionID: rootSession.id, messageID: "msg_fixture_missing" })).status, 400)
  yield* Effect.promise(() => fs.writeFile(leaseA, "returned"))
  yield* waitStatus(200)
  assert.equal((yield* request("/api/rpc/codenomad.session-pruning/preview", { sessionID: rootSession.id, messageID: "msg_fixture_missing" })).status, 200)
  yield* Effect.promise(() => fs.unlink(leaseA))
  yield* waitStatus(400)
  assert.deepEqual(yield* keys(), before)
  return { status: "passed", pid: process.pid, bun: Bun.version, nativePackages: packages, publishedIntegrity: setupReceipt, publishedSources: sourceReceipt.published,
    transport: "authenticated unmodified published production HTTP router, in-process, no listener", database: ":memory:",
    productionEntry: "packages/server/src/opencode/session-pruning/desktop-plugin.ts", bundleSha256: createHash("sha256").update(yield* Effect.promise(() => fs.readFile(bundle))).digest("hex"),
    before, after: yield* keys(), coldCount: 100, coldWorktrees, coldConstructed: 0, startsBefore, startsAfter: booted.length,
    memory: { before: memoryBefore, after: process.memoryUsage(), scope: "short isolated fixture, not a memory profile or deployment soak" },
    seeded, snapshots, promise, nonAuthoritative,
    lifecycle: { absent: true, present: true, multipleBackendsRetained: true, expired: true, returned: true, stoppedAgain: true },
    separateBundledEffectCopy: "4.0.0-rc.112", unauthorizedStatus: unauthorized.status, requests }
})).pipe(Effect.provide(Logger.layer([Logger.make((entry) => {
  if (Array.isArray(entry.message) && entry.message.includes("location services booted")) booted.push(entry.message)
  if (entry.logLevel === "Error" || entry.logLevel === "Warn") console.error(JSON.stringify(entry.message, (_key, value) => value instanceof Error ? { message: value.message, stack: value.stack } : value))
})]))))
await fs.writeFile(path.join(output, "receipt.json"), JSON.stringify(receipt, null, 2))
console.log(JSON.stringify({ status: receipt.status, before: receipt.before.length, after: receipt.after.length, coldConstructed: 0, forms: 6, globalForms: 3, permissions: 3, lifecycle: receipt.lifecycle, output }, null, 2))
// ponytail: all owned scopes and receipts are closed; don't retain native package process handles in a one-shot fixture.
process.exit(0)
