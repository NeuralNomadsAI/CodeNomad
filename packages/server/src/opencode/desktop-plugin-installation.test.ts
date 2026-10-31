import assert from "node:assert/strict"
import { test } from "node:test"
import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { bundleRepairSchedule, installDesktopPluginPresence } from "./desktop-plugin-installation"
import { DesktopPluginLifecycle } from "./desktop-plugin-lifecycle"
import { resolveDesktopPluginPaths } from "./desktop-plugin-paths"

test("a content-addressed Missions bundle holding other bytes is replaced before reuse", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-missions-bundle-"))
  const paths = { config: path.join(root, "config"), data: path.join(root, "data") }
  const bundle = Buffer.from("trusted"), hash = createHash("sha256").update(bundle).digest("hex")
  const stop = await installDesktopPluginPresence("missions", bundle, paths)
  const entry = path.join(paths.config, "plugins", "codenomad-missions.ts")
  const before = await readFile(entry, "utf8")
  const payload = path.join(paths.data, "missions", `${hash}.mjs`)
  await writeFile(payload, "changed")
  const next = await installDesktopPluginPresence("missions", bundle, paths)
  t.after(async () => { await stop(); await next(); await rm(root, { recursive: true, force: true }) })
  assert.deepEqual(await readFile(payload), bundle)
  assert.equal(await readFile(entry, "utf8"), before)
  assert.equal((await readdir(path.join(paths.data, "missions"))).filter((name) => name.endsWith(".tmp")).length, 0)
})

test("a payload cut short by an interrupted first install is repaired on every later connection", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-missions-partial-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = { config: path.join(root, "config"), data: path.join(root, "data") }
  const bundle = Buffer.alloc(256 * 1024, 7), hash = createHash("sha256").update(bundle).digest("hex")
  const directory = path.join(paths.data, "missions")
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, `${hash}.mjs`), bundle.subarray(0, 64 * 1024))
  const stop = await installDesktopPluginPresence("missions", bundle, paths)
  await stop()
  assert.deepEqual(await readFile(path.join(directory, `${hash}.mjs`)), bundle)
})

test("installers sharing one data directory never observe each other's partial payload", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-missions-race-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = path.join(root, "data"), bundle = Buffer.alloc(2 * 1024 * 1024, 3)
  const results = await Promise.allSettled([0, 1, 2, 3].map((index) =>
    installDesktopPluginPresence("missions", bundle, { config: path.join(root, `config-${index}`), data })))
  for (const result of results) if (result.status === "fulfilled") await result.value()
  assert.deepEqual(results.map((result) => result.status === "rejected" ? String(result.reason) : "ok"), ["ok", "ok", "ok", "ok"])
})

test("a damaged payload held open by another reader is repaired by the same installation once the reader lets go", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-missions-locked-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = { config: path.join(root, "config"), data: path.join(root, "data") }
  const bundle = Buffer.from("trusted"), hash = createHash("sha256").update(bundle).digest("hex")
  const directory = path.join(paths.data, "missions"), payload = path.join(directory, `${hash}.mjs`)
  await mkdir(directory, { recursive: true })
  await writeFile(payload, "damaged")
  // On Windows an open reader makes replacing the name fail with EPERM until it closes.
  const reader = await open(payload, "r")
  const released = new Promise<void>((resolve) => setTimeout(() => { void reader.close().then(resolve) }, 500))
  try {
    const stop = await installDesktopPluginPresence("missions", bundle, paths)
    await stop()
  } finally { await released }
  assert.deepEqual(await readFile(payload), bundle)
})

test("a directory link at the payload name is replaced without touching its target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-missions-junction-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = { config: path.join(root, "config"), data: path.join(root, "data") }
  const bundle = Buffer.from("trusted"), hash = createHash("sha256").update(bundle).digest("hex")
  const directory = path.join(paths.data, "missions"), payload = path.join(directory, `${hash}.mjs`)
  await mkdir(directory, { recursive: true })
  const target = path.join(root, "target")
  await mkdir(target)
  await writeFile(path.join(target, "sentinel"), "keep")
  await symlink(target, payload, "junction")
  const stop = await installDesktopPluginPresence("missions", bundle, paths)
  await stop()
  assert.equal((await lstat(payload)).isFile(), true)
  assert.deepEqual(await readFile(payload), bundle)
  assert.equal(await readFile(path.join(target, "sentinel"), "utf8"), "keep")
})

test("an installer that observed a link never deletes the payload another installer published meanwhile", {
  skip: process.platform !== "win32" && "only Windows refuses to rename a file over a directory link",
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-missions-link-race-"))
  t.after(async () => { delete bundleRepairSchedule.beforeLinkRemoval; await rm(root, { recursive: true, force: true }) })
  const data = path.join(root, "data")
  const bundle = Buffer.from("trusted"), hash = createHash("sha256").update(bundle).digest("hex")
  const directory = path.join(data, "missions"), payload = path.join(directory, `${hash}.mjs`)
  await mkdir(directory, { recursive: true })
  const target = path.join(root, "target")
  await mkdir(target)
  await writeFile(path.join(target, "sentinel"), "keep")
  await symlink(target, payload, "junction")
  // A observes the link and pauses right before removing it; B repairs the name meanwhile.
  let paused!: () => void, resume!: () => void
  const pausedA = new Promise<void>((resolve) => { paused = resolve })
  const resumeA = new Promise<void>((resolve) => { resume = resolve })
  let calls = 0
  bundleRepairSchedule.beforeLinkRemoval = async () => {
    if (++calls !== 1) return
    paused()
    await resumeA
  }
  const installA = installDesktopPluginPresence("missions", bundle, { config: path.join(root, "config-a"), data })
  await pausedA
  const stopB = await installDesktopPluginPresence("missions", bundle, { config: path.join(root, "config-b"), data })
  const published = await lstat(payload)
  resume()
  const stopA = await installA
  await stopA()
  await stopB()
  const after = await lstat(payload)
  assert.equal(after.isFile(), true)
  assert.equal(after.ino, published.ino, "the payload B verified was neither deleted nor replaced")
  assert.deepEqual(await readFile(payload), bundle)
  assert.equal(await readFile(path.join(target, "sentinel"), "utf8"), "keep")
})

test("an ordinary directory at the payload name is refused at once and left intact", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-missions-directory-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = { config: path.join(root, "config"), data: path.join(root, "data") }
  const bundle = Buffer.from("trusted"), hash = createHash("sha256").update(bundle).digest("hex")
  const payload = path.join(paths.data, "missions", `${hash}.mjs`)
  await mkdir(payload, { recursive: true })
  await writeFile(path.join(payload, "sentinel"), "keep")
  const started = Date.now()
  await assert.rejects(installDesktopPluginPresence("missions", bundle, paths), /is a directory/)
  assert(Date.now() - started < 1_000, "a permanent problem is not retried")
  assert.equal(await readFile(path.join(payload, "sentinel"), "utf8"), "keep")
  await assert.rejects(readFile(path.join(paths.config, "plugins", "codenomad-missions.ts")), { code: "ENOENT" })
})

test("a digest-named Missions bundle that is a symlink is replaced without touching its target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-missions-link-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const paths = { config: path.join(root, "config"), data: path.join(root, "data") }
  const bundle = Buffer.from("trusted"), hash = createHash("sha256").update(bundle).digest("hex")
  const directory = path.join(paths.data, "missions")
  await mkdir(directory, { recursive: true })
  const target = path.join(root, "target.mjs")
  await writeFile(target, "elsewhere")
  const payload = path.join(directory, `${hash}.mjs`)
  await symlink(target, payload, "file")
  const stop = await installDesktopPluginPresence("missions", bundle, paths)
  await stop()
  assert.equal((await lstat(payload)).isSymbolicLink(), false)
  assert.deepEqual(await readFile(payload), bundle)
  assert.equal(await readFile(target, "utf8"), "elsewhere")
})

test("WSL preserves existing outside-root native storage with a drive-backed config", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-wsl-storage-"))
  const config = path.join(root, "config"), oldData = path.join(root, "old-data"), data = path.join(root, "new-data")
  const disposals: Array<() => Promise<void>> = []
  t.after(async () => { await Promise.all(disposals.map(dispose => dispose())); await rm(root, { recursive: true, force: true }) })
  for (const feature of ["automation", "session-pruning"] as const) {
    disposals.push(await installDesktopPluginPresence(feature, Buffer.from("old"), {
      config, data: oldData, nativeData: "/linux/old-data",
    }))
    const entry = path.join(config, "plugins", `codenomad-${feature}.ts`)
    const resolveNativePath = async (native: string) => {
      assert.equal(native, `/linux/old-data/${feature}`)
      return { native, host: path.join(oldData, feature) }
    }
    const paths = { config, data, nativeData: "/windows/new-data", resolveNativePath }
    const latest = await installDesktopPluginPresence(feature, Buffer.from("new"), paths)
    disposals.push(latest)
    const source = await readFile(entry, "utf8")
    assert.ok(source.includes(`file:///linux/old-data/${feature}/`))
    assert.ok(source.includes(JSON.stringify(`/linux/old-data/${feature}/presence`)))
    assert.equal((await readdir(path.join(oldData, feature, "presence"))).length, 2)
    await assert.rejects(readdir(data), { code: "ENOENT" })
    await latest()
    assert.equal((await readdir(path.join(oldData, feature, "presence"))).length, 1)
  }
})

test("WSL canonical storage inside config migrates without modifying older leases", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-wsl-migration-"))
  const config = path.join(root, "config"), oldData = path.join(config, "watched"), data = path.join(root, "outside")
  const disposals: Array<() => Promise<void>> = []
  t.after(async () => { await Promise.all(disposals.map(dispose => dispose())); await rm(root, { recursive: true, force: true }) })
  for (const feature of ["automation", "session-pruning"] as const) {
    // The old spelling appears outside config, but distro realpath resolves it
    // into the watched directory. Host containment must use that resolved path.
    disposals.push(await installDesktopPluginPresence(feature, Buffer.from("old"), {
      config, data: oldData, nativeData: "/old-alias",
    }))
    const oldLeases = path.join(oldData, feature, "presence")
    const original = await readdir(oldLeases)
    const paths = {
      config, data, nativeData: "/canonical/outside",
      resolveNativePath: async (native: string) => native.startsWith("/old-alias/")
        ? { native: `/canonical/config/watched/${feature}`, host: path.join(oldData, feature) }
        : { native, host: path.join(data, feature) },
    }
    disposals.push(await installDesktopPluginPresence(feature, Buffer.from("new"), paths))
    const entry = path.join(config, "plugins", `codenomad-${feature}.ts`)
    const source = await readFile(entry, "utf8")
    assert.ok(source.includes(JSON.stringify([`/canonical/outside/${feature}/presence`, `/old-alias/${feature}/presence`])))
    assert.deepEqual(await readdir(oldLeases), original)
    assert.equal((await readdir(path.join(data, feature, "presence"))).length, 1)
    disposals.push(await installDesktopPluginPresence(feature, Buffer.from("new"), paths))
    assert.equal(await readFile(entry, "utf8"), source, "Reopening preserves old readers without rewriting config")
    assert.equal((await readdir(path.join(data, feature, "presence"))).length, 2)
    assert.deepEqual(await readdir(oldLeases), original)
  }
})

test("WSL storage translation completing on a stale connection cannot write", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-wsl-storage-fence-"))
  const config = path.join(root, "config"), data = path.join(root, "data")
  const stop = await installDesktopPluginPresence("automation", Buffer.from("old"), { config, data, nativeData: "/native/data" })
  t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }) })
  const entry = path.join(config, "plugins", "codenomad-automation.ts")
  const before = await readFile(entry, "utf8"), leases = await readdir(path.join(data, "automation", "presence"))
  let current = true
  await assert.rejects(installDesktopPluginPresence("automation", Buffer.from("new"), {
    config, data, nativeData: "/native/data",
    resolveNativePath: async native => { current = false; return { native, host: path.join(data, "automation") } },
  }, () => { if (!current) throw new Error("stale connection") }), /stale connection/)
  assert.equal(await readFile(entry, "utf8"), before)
  assert.deepEqual(await readdir(path.join(data, "automation", "presence")), leases)
  assert.equal((await readdir(path.join(data, "automation"))).filter(name => name.endsWith(".mjs")).length, 1)
})

test("WSL file URLs preserve percent escapes and special characters when reopening entries", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-wsl-url-"))
  const config = path.join(root, "config"), data = path.join(root, "data")
  const nativeData = "/linux/literal%20name #日本語"
  const paths = { config, data, nativeData,
    resolveNativePath: async (native: string) => ({ native, host: path.join(data, "automation") }),
  }
  const disposals: Array<() => Promise<void>> = []
  t.after(async () => { await Promise.all(disposals.map(dispose => dispose())); await rm(root, { recursive: true, force: true }) })
  disposals.push(await installDesktopPluginPresence("automation", Buffer.from("fixture"), paths))
  const entry = path.join(config, "plugins", "codenomad-automation.ts")
  const source = await readFile(entry, "utf8")
  const encodedUrl = JSON.parse(/from (".+")\n/.exec(source)![1])
  assert.equal(path.posix.dirname(decodeURIComponent(new URL(encodedUrl).pathname)), `${nativeData}/automation`)
  assert.ok(encodedUrl.includes("literal%2520name"))
  disposals.push(await installDesktopPluginPresence("automation", Buffer.from("fixture"), paths))
  assert.equal(await readFile(entry, "utf8"), source)
})

test("existing WSL storage resolution uses the surviving overlapping lifecycle claim", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-wsl-claims-"))
  const config = path.join(root, "config"), data = path.join(root, "data")
  let currentA = true
  const assertA = () => { if (!currentA) throw new Error("stale A") }
  const executor = async (_distro: string, command: string, args: string[]) => command === "realpath"
    ? args.at(-1)! : `C:\\fixture${args.at(-1)!.replaceAll("/", "\\")}`
  const makePaths = async (assertCurrent: () => void) => {
    const resolved = await resolveDesktopPluginPaths({ assertCurrent,
      client: { config: { get: async () => [{ type: "directory", path: "/native/config" }] } } as never,
    }, { kind: "wsl", distro: "Ubuntu", binary: "/bin/opencode" }, Date.now() + 15_000, executor)
    return { ...resolved, config, data,
      resolveNativePath: async (native: string, fence: () => void) => ({
        ...await resolved.resolveNativePath!(native, fence), host: path.join(data, "automation"),
      }),
    }
  }
  const pathsA = await makePaths(assertA), pathsB = await makePaths(() => {})
  const seedStop = await installDesktopPluginPresence("automation", Buffer.from("old"), pathsA)
  let releaseBundle!: () => void
  const bundle = new Promise<void>(resolve => { releaseBundle = resolve })
  const lifecycle = new DesktopPluginLifecycle("automation", async () => { await bundle; return Buffer.from("new") })
  t.after(async () => { releaseBundle(); await lifecycle.stop(); await seedStop(); await rm(root, { recursive: true, force: true }) })
  const first = lifecycle.prepare(pathsA, assertA)
  const firstRejected = assert.rejects(first, /stale A/)
  const second = lifecycle.prepare(pathsB, () => {})
  currentA = false
  releaseBundle()
  await firstRejected
  const prepared = await second
  prepared.commit()
  await prepared.release()
  assert.equal((await readdir(path.join(data, "automation", "presence"))).length, 2)
})
