import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { createHexCache } from "./hex-cache.mjs"
import { fileInfo } from "./hex-files.mjs"
import { hexArtifacts, hexVersion } from "./hex-manifest.mjs"
import { createHexService } from "./hex-process.mjs"

const signal = () => new AbortController().signal
const body = { engine: "engine", model: "model contents", vad: "detector" }
const artifacts = Object.fromEntries(Object.entries(body).map(([name, value]) => [name, {
  filename: name, url: `https://example.test/${name}`, bytes: value.length,
  sha256: createHash("sha256").update(value).digest("hex"),
}]))

function harness(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "codenomad-hex-test-"))
  t.after(() => rmSync(root, { force: true, recursive: true }))
  const calls = []
  const cache = createHexCache(root, {
    host: "win32", artifacts, reuse: () => [], probe: async () => {},
    request: async (url, init) => {
      const name = url.pathname.slice(1)
      const offset = Number(/\d+/.exec(init.headers.Range)?.[0] ?? 0)
      calls.push([name, offset])
      if (options.request) return options.request(name, offset, init)
      return new Response(body[name].slice(offset), offset ? {
        status: 206, headers: { "Content-Range": `bytes ${offset}-${body[name].length - 1}/${body[name].length}` },
      } : {})
    },
    ...Object.fromEntries(Object.entries(options).filter(([name]) => name !== "request")),
  })
  const plan = () => cache.capabilities().plan
  return { root, cache, calls, plan, prepare: (s = signal(), progress = () => {}) => cache.prepare(plan().id, s, progress) }
}

test("release eligibility and consented full bytes are pinned", () => {
  assert.equal(hexArtifacts("darwin", "x64", "25.0"), undefined)
  assert.equal(hexArtifacts("darwin", "arm64", "23.9"), undefined)
  assert.equal(hexArtifacts("linux", "x64", "", "2.35"), undefined)
  assert.equal(hexArtifacts("linux", "arm64", "", "2.36").engine.bytes, 81_168_104)
  const windows = hexArtifacts("win32", "x64", "")
  assert.equal(Object.values(windows).reduce((sum, item) => sum + item.bytes, 0), 827_991_280)
})

test("the Tauri helper reads capabilities without creating a cache", t => {
  const { root } = harness(t)
  const absent = join(root, "unused")
  const entry = fileURLToPath(new URL("./hex-worker.mjs", import.meta.url))
  const reply = JSON.parse(execFileSync(process.execPath, [entry, "read", absent], {
    encoding: "utf8", timeout: 4_000, windowsHide: true,
  }))
  assert.ok(["needsPreparation", "unavailable"].includes(reply.value.state))
  assert.equal(existsSync(absent), false)
})

test("read is offline; exact reusable artifacts are verified before the first launch and never fetched", async t => {
  let probes = 0
  const h = harness(t, {
    reuse: (component) => component === "model" ? [{ path: reusable, ...fileInfo(reusable) }] : [],
    probe: async () => { probes++ },
  })
  const reusable = join(h.root, "existing-model")
  writeFileSync(reusable, body.model)
  const before = h.plan()
  assert.deepEqual(before.missing, [
    { component: "engine", downloadBytes: 6 }, { component: "model", downloadBytes: 0 }, { component: "vad", downloadBytes: 8 },
  ])
  assert.equal(h.cache.capabilities().state, "needsPreparation")
  assert.deepEqual(h.calls, [])
  const progress = []
  await h.prepare(signal(), event => progress.push(event))
  assert.equal(h.cache.capabilities().state, "ready")
  assert.deepEqual(h.plan().missing, [])
  assert.deepEqual(h.calls, [["engine", 0], ["vad", 0]])
  assert.equal(progress.filter(event => event.state === "downloading").at(-1).downloadedBytes, 14)
  assert.equal(readFileSync(reusable, "utf8"), body.model)
  assert.equal(probes, 1)
  assert.equal((await h.cache.capabilities()).state, "ready")
  await assert.rejects(h.cache.prepare(before.id, signal(), () => {}), { code: "planChanged" })
  assert.equal(probes, 1)
})

test("Linux reuses the official pinned installation, not its launch symlink or other versions", async t => {
  for (const xdg of ["custom", "", "relative"]) {
    await t.test(xdg || "default", async t => {
      const expected = body.engine
      let probes = 0
      const h = harness(t, {
        host: "linux", artifacts: { engine: { ...artifacts.engine, filename: "hex" } }, reuse: undefined,
        probe: async ({ executable }) => {
          probes++
          assert.equal(executable, join(h.root, `hex-${hexVersion}`, `linux-${process.arch}`, "hex"))
          assert.equal(readFileSync(executable, "utf8"), expected)
        },
      })
      const home = join(h.root, "home")
      const data = xdg === "custom" ? join(h.root, "xdg") : join(home, ".local", "share")
      const env = { HOME: home, USERPROFILE: home, XDG_DATA_HOME: xdg === "custom" ? data : xdg, APPDATA: "", LOCALAPPDATA: "", PATH: "" }
      const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
      Object.assign(process.env, env)
      t.after(() => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key]
          else process.env[key] = value
        }
      })
      const versions = join(data, "hex", "versions")
      const other = join(versions, "9.9.9")
      const versioned = join(versions, hexVersion)
      mkdirSync(other, { recursive: true })
      writeFileSync(join(other, "hex"), expected)
      if (process.platform === "linux") {
        const bin = join(home, ".local", "bin")
        mkdirSync(bin, { recursive: true })
        symlinkSync(join(other, "hex"), join(bin, "hex"))
      }
      assert.equal(h.plan().missing[0].downloadBytes, expected.length)
      mkdirSync(versioned)
      const source = join(versioned, "hex")
      const corrupt = expected.toUpperCase()
      writeFileSync(source, corrupt)
      assert.equal(h.plan().missing[0].downloadBytes, 0)
      await assert.rejects(h.prepare(), { code: "planChanged" })
      assert.equal(probes, 0)
      assert.deepEqual(h.calls, [])
      assert.equal(h.plan().missing[0].downloadBytes, expected.length)
      assert.equal(readFileSync(source, "utf8"), corrupt)
      writeFileSync(source, expected)
      assert.equal(h.plan().missing[0].downloadBytes, 0)
      await h.prepare()
      assert.equal(h.cache.capabilities().state, "ready")
      assert.equal(probes, 1)
      assert.deepEqual(h.calls, [])
      assert.equal(readFileSync(source, "utf8"), expected)
      const fromPath = join(home, "path")
      mkdirSync(fromPath, { recursive: true })
      process.env.PATH = fromPath
      writeFileSync(join(fromPath, "hex"), expected)
      const fallback = harness(t, {
        host: "linux", artifacts: { engine: { ...artifacts.engine, filename: "hex" } }, reuse: undefined,
        probe: async ({ executable }) => assert.equal(readFileSync(executable, "utf8"), expected),
      })
      writeFileSync(source, corrupt)
      await fallback.prepare()
      assert.deepEqual(fallback.calls, [])
      // A same-size but wrong PATH entry must not mask the pinned XDG install.
      writeFileSync(join(fromPath, "hex"), corrupt)
      writeFileSync(source, expected)
      const pinned = harness(t, {
        host: "linux", artifacts: { engine: { ...artifacts.engine, filename: "hex" } }, reuse: undefined,
        probe: async ({ executable }) => assert.equal(readFileSync(executable, "utf8"), expected),
      })
      assert.equal(pinned.plan().missing[0].downloadBytes, 0)
      await pinned.prepare()
      assert.equal(pinned.cache.capabilities().state, "ready")
      assert.deepEqual(pinned.calls, [])
      assert.equal(readFileSync(join(fromPath, "hex"), "utf8"), corrupt)
    })
  }
})

test("cancellation retains partial bytes, old consent is rejected and resumption requests only the tail", async t => {
  const cancel = new AbortController()
  let first = true
  const h = harness(t, { request(name, offset) {
    if (first) {
      first = false
      return new Response(new ReadableStream({ start(stream) { stream.enqueue(Buffer.from(body[name].slice(0, 3))) } }))
    }
    return new Response(body[name].slice(offset), offset
      ? { status: 206, headers: { "Content-Range": `bytes ${offset}-${body[name].length - 1}/${body[name].length}` } } : {})
  } })
  const previous = h.plan()
  await assert.rejects(h.prepare(cancel.signal, event => {
    if (event.downloadedBytes === 3) cancel.abort()
  }), { name: "AbortError" })
  assert.equal(h.plan().missing[0].downloadBytes, 3)
  await assert.rejects(h.cache.prepare(previous.id, signal(), () => {}), { code: "planChanged" })
  await h.prepare()
  assert.deepEqual(h.calls, [["engine", 0], ["engine", 3], ["model", 0], ["vad", 0]])
  assert.equal(h.cache.capabilities().state, "ready")
})

test("refused Range changes the plan without consuming the full response", async t => {
  let cancelled = false
  const h = harness(t, { request() {
    return new Response(new ReadableStream({ cancel() { cancelled = true } }))
  } })
  const dir = join(h.root, "hex-3.4.0")
  mkdirSync(join(dir, "models"), { recursive: true })
  const engineDir = join(dir, `win32-${process.arch}`)
  mkdirSync(engineDir)
  writeFileSync(join(engineDir, "engine.part"), "eng")
  assert.equal(h.plan().missing[0].downloadBytes, 3)
  await assert.rejects(h.prepare(), { code: "planChanged" })
  assert.equal(cancelled, true)
  assert.deepEqual(h.calls, [["engine", 3]])
  assert.equal(h.plan().missing[0].downloadBytes, 6)
})

test("a local candidate with the right size and wrong hash requires new consent before fetching", async t => {
  const h = harness(t, { reuse: (component) => component === "model" ? [{ path: reuse, ...fileInfo(reuse) }] : [] })
  const reuse = join(h.root, "same-size-but-corrupt")
  writeFileSync(reuse, "x".repeat(body.model.length))
  assert.equal(h.plan().missing[1].downloadBytes, 0)
  await assert.rejects(h.prepare(), { code: "planChanged" })
  assert.deepEqual(h.calls, [])
  assert.equal(h.plan().missing[1].downloadBytes, body.model.length)
  assert.equal(readFileSync(reuse, "utf8"), "x".repeat(body.model.length))
  await h.prepare()
  assert.deepEqual(h.calls, [["engine", 0], ["model", 0], ["vad", 0]])
})

test("local model alternatives are all plan-bound and only the first verified candidate is copied", async t => {
  const h = harness(t, {
    artifacts: { engine: artifacts.engine, model: artifacts.model },
    reuse: component => (component === "model" ? [bad, valid, unused] : [engine])
      .map(path => ({ path, ...fileInfo(path) })),
  })
  const engine = join(h.root, "installed-engine")
  const bad = join(h.root, "first")
  const valid = join(h.root, "second")
  const unused = join(h.root, "third")
  writeFileSync(engine, body.engine)
  writeFileSync(bad, body.model.toUpperCase())
  writeFileSync(valid, body.model)
  writeFileSync(unused, body.model)
  const old = h.plan()
  writeFileSync(`${unused}.replacement`, body.model.toUpperCase())
  renameSync(`${unused}.replacement`, unused)
  await assert.rejects(h.cache.prepare(old.id, signal(), () => {}), { code: "planChanged" })
  await h.prepare()
  assert.equal(h.cache.capabilities().state, "ready")
  assert.deepEqual(h.calls, [])
  assert.equal(readFileSync(join(h.root, `hex-${hexVersion}`, "models", "model"), "utf8"), body.model)
})

test("startup check or integrity failure cannot make Hex ready", async t => {
  const h = harness(t, { probe: async () => { throw new Error("missing runtime") } })
  await assert.rejects(h.prepare(), /missing runtime/)
  assert.deepEqual(h.plan().missing, [{ component: "engine", downloadBytes: 0 }])
  assert.equal(h.cache.capabilities().state, "needsPreparation")
  const broken = harness(t, { request: name => new Response("x".repeat(body[name].length)) })
  await assert.rejects(broken.prepare(), { code: "planChanged" })
  assert.equal(broken.cache.capabilities().state, "needsPreparation")
  assert.deepEqual(broken.calls, [["engine", 0]])
})

test("a second preparation cannot take the shared cache lease", async t => {
  let release, started
  const wait = new Promise(resolve => { release = resolve })
  const inFlight = new Promise(resolve => { started = resolve })
  const h = harness(t, { probe: async () => { started(); await wait } })
  const first = h.prepare()
  await inFlight
  try { await assert.rejects(h.prepare(), { code: "busy" }) }
  finally { release(); await first }
  assert.equal(h.cache.capabilities().state, "ready")
})

const fixture = fileURLToPath(new URL("hex-test-service.fixture.mjs", import.meta.url))
function wav() {
  return Buffer.from("524946462800000057415645666d74201000000001000100803e0000007d000002001000646174610400000000000000", "hex")
}

async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await delay(10)
  }
  assert.fail("Hex fixture did not reach the expected state")
}

test("the owned service accepts only checked PCM and an authenticated, matching loopback handshake", async t => {
  const { root } = harness(t)
  const installation = { executable: process.execPath, support: root }
  const service = createHexService({ args: [fixture] })
  try {
    const use = audio => service.use(installation, "key", signal(), transcribe => transcribe(audio))
    assert.equal(await use(wav()), "Bonjour, hello.")
    const oversized = wav()
    oversized.writeInt16LE(44, 44)
    await assert.rejects(use(oversized))
    await assert.rejects(use(Buffer.from("not a WAV")))
  } finally { await service.stop() }
  for (const mode of ["bad-pid", "redirect"]) {
    const invalid = createHexService({ args: [fixture, mode] })
    await assert.rejects(invalid.use(installation, "key", signal(), transcribe => transcribe(wav())))
  }
})

test("capture prewarms once, then reuses Hex until exit, idle or a changed engine", { timeout: 10_000 }, async t => {
  const { root } = harness(t)
  const installation = { executable: process.execPath, support: root }
  let selected = true
  const service = createHexService({ args: [fixture], idleMs: 1_500, isSelected: () => selected })
  const warmed = join(root, "warmed")
  const pids = () => readFileSync(warmed, "utf8").trim().split("\n")
  const logs = pid => join(root, "logs", `embedded-${pid}.ndjson`)
  try {
    await service.use(installation, "key", signal(), async transcribe => {
      await until(() => existsSync(warmed))
      return transcribe(wav())
    })
    const first = pids()[0]
    await service.use(installation, "key", signal(), transcribe => transcribe(wav()))
    assert.deepEqual(pids(), [first])
    const crash = wav()
    crash.writeInt16LE(43, 44)
    await assert.rejects(service.use(installation, "key", signal(), transcribe => transcribe(crash)))
    assert.equal(existsSync(logs(first)), false)
    await service.use(installation, "key", signal(), transcribe => transcribe(wav()))
    assert.equal(pids().length, 2)
    await until(() => !existsSync(logs(pids()[1])))
    await service.use(installation, "key", signal(), transcribe => transcribe(wav()))
    selected = false
    await assert.rejects(service.use(installation, "key", signal(), transcribe => transcribe(wav())))
    await until(() => !existsSync(logs(pids()[2])))
    assert.equal(pids().length, 3)
  } finally { await service.stop() }
})

test("cancel kills the owned inference process before settlement", { timeout: 5_000 }, async t => {
  const { root } = harness(t)
  const abort = new AbortController()
  const installation = { executable: process.execPath, support: root }
  const service = createHexService({ args: [fixture, "blocked"] })
  const started = join(root, "started")
  const transcription = assert.rejects(service.use(installation, "key", abort.signal, transcribe => transcribe(wav())))
  try {
    await until(() => existsSync(started))
    const pid = Number(readFileSync(started, "utf8"))
    abort.abort()
    await transcription
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  } finally {
    abort.abort()
    await transcription
  }
})

test("cancel before uploading audio lets the same synthetic prewarm finish", { timeout: 5_000 }, async t => {
  const { root } = harness(t)
  const installation = { executable: process.execPath, support: root }
  const service = createHexService({ args: [fixture, "warm-blocked"] })
  const abort = new AbortController()
  const started = join(root, "warm-started")
  const cancelled = assert.rejects(service.use(installation, "key", abort.signal, transcribe => transcribe(wav())))
  try {
    await until(() => existsSync(started))
    abort.abort()
    await cancelled
    const pid = readFileSync(started, "utf8")
    assert.equal(existsSync(join(root, "logs", `embedded-${pid}.ndjson`)), true)
    writeFileSync(join(root, "warm-release"), "")
    assert.equal(await service.use(installation, "key", signal(), transcribe => transcribe(wav())), "Bonjour, hello.")
    assert.equal(readFileSync(join(root, "warmed"), "utf8"), `${pid}\n`)
  } finally { await service.stop() }
})

test("closing a healthy Windows lease avoids the process-tree fallback", {
  skip: process.platform !== "win32",
}, async t => {
  const { root } = harness(t)
  const installation = { executable: process.execPath, support: root }
  let treeStops = 0
  const service = createHexService({ args: [fixture], stopTree: () => { treeStops++ } })
  try {
    await service.use(installation, "key", signal(), transcribe => transcribe(wav()))
  } finally { await service.stop() }
  assert.equal(treeStops, 0)
})

test("a Windows shutdown drains only the synthetic warmup before closing the service", {
  skip: process.platform !== "win32",
}, async t => {
  const { root } = harness(t)
  const installation = { executable: process.execPath, support: root }
  const service = createHexService({ args: [fixture, "warm-blocked"], stopTree: () => assert.fail("graceful exit expected") })
  const capture = assert.rejects(service.use(installation, "key", signal(), transcribe => transcribe(wav())))
  await until(() => existsSync(join(root, "warm-started")))
  const stopped = service.stop()
  writeFileSync(join(root, "warm-release"), "")
  await stopped
  await capture
  assert.ok(existsSync(join(root, "warmed")))
  assert.equal(existsSync(join(root, "closing")), false)
})

test("a stalled Windows warmup cannot hold app shutdown open", {
  skip: process.platform !== "win32", timeout: 5_000,
}, async t => {
  const { root } = harness(t)
  const installation = { executable: process.execPath, support: root }
  let forced = 0
  const service = createHexService({ args: [fixture, "warm-blocked"], stopTree: () => { forced++ } })
  const capture = assert.rejects(service.use(installation, "key", signal(), transcribe => transcribe(wav())))
  await until(() => existsSync(join(root, "warm-started")))
  await service.stop()
  await capture
  assert.equal(forced, 1)
})
