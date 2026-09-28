import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installDesktopPluginPresence } from "./desktop-plugin-installation"
import { DesktopPluginLifecycle } from "./desktop-plugin-lifecycle"
import { resolveDesktopPluginPaths } from "./desktop-plugin-paths"

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
