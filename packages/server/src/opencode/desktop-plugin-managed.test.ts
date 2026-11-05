import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test, type TestContext } from "node:test"
import { pathToFileURL } from "node:url"
import { installDesktopPluginPresence, type DesktopPluginFeature } from "./desktop-plugin-installation"
import { managedDesktopPluginForSource, parseManagedDesktopPluginEntry, readManagedDesktopPlugins } from "./desktop-plugin-managed"

const nativePaths = process.platform === "win32" ? path.win32 : path.posix
const bundleFor = (ids: string[]) => Buffer.from(`// CodeNomad plugin IDs: ${JSON.stringify(ids)}\nthrow new Error("discovery must never execute this bundle")\n`)

for (const [feature, id] of [
  ["automation", "codenomad.automation"], ["session-pruning", "codenomad-session-pruning"], ["missions", "codenomad.missions"],
] as const) test(`recognizes the installed ${feature} shim and verified bundle, without executing either`, async t => {
  const fixture = await createFixture(t)
  const installed = await fixture.install(feature, [id])
  const installations = await fixture.read()
  assert.deepEqual(installations, [{ entry: installed.entry, plugin: installed.plugin, ids: [id] }])
  for (const source of [installed.entry, installed.plugin, pathToFileURL(installed.entry).href, pathToFileURL(installed.plugin).href]) {
    assert.equal(managedDesktopPluginForSource(installations, source, nativePaths), installations[0])
  }
  for (const source of ["@third-party/codenomad", `${installed.entry}.copy`, path.join(fixture.root, `codenomad-${feature}.ts`)]) {
    assert.equal(managedDesktopPluginForSource(installations, source, nativePaths), undefined)
  }
})

test("reads arbitrary exported IDs from the verified first bundle line", async t => {
  const fixture = await createFixture(t)
  await fixture.install("automation", ["future.desktop-plugin", "another-plugin", "future.desktop-plugin"])
  assert.deepEqual((await fixture.read())[0].ids, ["future.desktop-plugin", "another-plugin"])
})

test("recognizes a newly published feature through the same installer without a recognition catalogue", async t => {
  const fixture = await createFixture(t)
  const installed = await fixture.install("future-bridge" as DesktopPluginFeature, ["future.bridge"])
  assert.deepEqual(await fixture.read(), [{ entry: installed.entry, plugin: installed.plugin, ids: ["future.bridge"] }])
})

for (const header of [
  "", "// preceding line\n// CodeNomad plugin IDs: [\"hidden.id\"]\n", "// CodeNomad plugin IDs: nope\n",
  "// CodeNomad plugin IDs: [\"-bad\"]\n", "// CodeNomad plugin IDs: [\"wild.*\"]\n",
]) test(`does not invent exported IDs for an absent or invalid descriptor ${JSON.stringify(header)}`, async t => {
  const fixture = await createFixture(t)
  const stop = await installDesktopPluginPresence("automation", Buffer.from(`${header}export const desktopPlugin = () => {}\n`), fixture.paths)
  await stop()
  assert.deepEqual((await fixture.read())[0].ids, [])
})

test("retains verified storage outside the current default data directory", async t => {
  const fixture = await createFixture(t)
  const first = await fixture.install("automation", ["original.id"])
  const stop = await installDesktopPluginPresence("automation", bundleFor(["future.id"]), { ...fixture.paths, data: path.join(fixture.root, "new-default") })
  await stop()
  const [installation] = await fixture.read()
  assert.equal(path.dirname(installation.plugin), path.dirname(first.plugin))
  assert.deepEqual(installation.ids, ["future.id"])
  await assert.rejects(fs.stat(path.join(fixture.root, "new-default")), { code: "ENOENT" })
})

test("decodes file URLs once, preserving literal percent escapes and special characters", async t => {
  const fixture = await createFixture(t, "literal%20name #日本語")
  const installed = await fixture.install("automation", ["custom.id"])
  const installations = await fixture.read()
  assert.equal(installations.length, 1)
  const url = pathToFileURL(installed.plugin).href
  assert.ok(url.includes("%2520"))
  assert.equal(managedDesktopPluginForSource(installations, url, nativePaths), installations[0])
  assert.equal(managedDesktopPluginForSource(installations, installed.plugin.replace("%20", " "), nativePaths), undefined)
})

test("matches Windows drive paths and file URLs case-insensitively without decoding native paths", () => {
  const installation = {
    entry: "C:\\Config\\plugins\\codenomad-automation.ts",
    plugin: `D:\\Literal%20Name #日本語\\automation\\${"a".repeat(64)}.mjs`, ids: ["custom.id"],
  }
  for (const source of [installation.entry.toUpperCase(), installation.plugin.toUpperCase(), pathToFileURL(installation.plugin, { windows: true }).href]) {
    assert.equal(managedDesktopPluginForSource([installation], source, path.win32), installation)
  }
  assert.equal(managedDesktopPluginForSource([installation], pathToFileURL(installation.plugin, { windows: true }).href.replace(/^file:/, "FILE:"), path.win32), installation)
  assert.equal(managedDesktopPluginForSource([installation], installation.plugin.replace("%20", " "), path.win32), undefined)
  assert.equal(managedDesktopPluginForSource([installation], "file:///D:/Literal%20Name/automation/nope.mjs", path.win32), undefined)
})

test("translates only filesystem IO while retaining WSL native paths and URL dialect", async t => {
  const fixture = await createFixture(t)
  const nativeData = "/linux/literal%20name #日本語", id = "future.wsl-plugin"
  const stop = await installDesktopPluginPresence("automation", bundleFor([id]), { ...fixture.paths, nativeData })
  await stop()
  const translated: string[] = []
  const installations = await readManagedDesktopPlugins({
    globalDirectory: "/daemon/config", paths: path.posix, assertCurrent() {},
    hostPath: async native => {
      translated.push(native)
      if (native === "/daemon/config/plugins") return path.join(fixture.paths.config, "plugins")
      if (native.startsWith(`${nativeData}/`)) return path.join(fixture.paths.data, ...native.slice(nativeData.length + 1).split("/"))
      throw new Error(`Unexpected native path: ${native}`)
    },
  })
  assert.equal(installations.length, 1)
  assert.equal(installations[0].entry, "/daemon/config/plugins/codenomad-automation.ts")
  assert.equal(path.posix.dirname(installations[0].plugin), `${nativeData}/automation`)
  assert.deepEqual(translated, ["/daemon/config/plugins", installations[0].plugin])
  const url = pathToFileURL(installations[0].plugin, { windows: false }).href
  assert.equal(managedDesktopPluginForSource(installations, url, path.posix), installations[0])
  assert.equal(managedDesktopPluginForSource(installations, installations[0].plugin.replace("literal", "Literal"), path.posix), undefined)
})

test("does not recognize the Missions carrier provider as a plugin runtime", async t => {
  const fixture = await createFixture(t)
  const provider = Buffer.from("provider fixture")
  await fixture.install("missions", ["codenomad.missions"], provider)
  const installations = await fixture.read()
  const providerFile = path.join(fixture.paths.data, "missions", `${createHash("sha256").update(provider).digest("hex")}.provider.mjs`)
  assert.equal(managedDesktopPluginForSource(installations, providerFile, nativePaths), undefined)
  assert.equal(managedDesktopPluginForSource(installations, pathToFileURL(providerFile).href, nativePaths), undefined)
})

for (const damage of ["malformed shim", "extra shim code", "digest tamper", "missing payload", "renamed shim"] as const)
test(`leaves an unproven installation ordinary after ${damage}`, async t => {
  const fixture = await createFixture(t)
  const installed = await fixture.install("automation", ["codenomad.automation"])
  if (damage === "malformed shim") await fs.writeFile(installed.entry, installed.source.replace("desktopPlugin(", "desktopPlugin([null], "))
  if (damage === "extra shim code") await fs.appendFile(installed.entry, "throw new Error('extra')\n")
  if (damage === "digest tamper") await fs.appendFile(installed.plugin, "// tampered\n")
  if (damage === "missing payload") await fs.unlink(installed.plugin)
  if (damage === "renamed shim") await fs.rename(installed.entry, path.join(path.dirname(installed.entry), "automation.ts"))
  assert.deepEqual(await fixture.read(), [])
})

for (const role of ["entry", "plugin"] as const) for (const kind of ["hard link", "symbolic link"] as const)
test(`refuses a ${kind} at the installed ${role}`, async t => {
  const fixture = await createFixture(t)
  const installed = await fixture.install("automation", ["codenomad.automation"])
  const file = installed[role], target = `${file}.original`
  await fs.rename(file, target)
  if (kind === "hard link") await fs.link(target, file)
  else await fs.symlink(target, file, "file")
  const before = await fs.readFile(target)
  assert.deepEqual(await fixture.read(), [])
  assert.deepEqual(await fs.readFile(target), before, "recognition never repairs or mutates unproven files")
})

test("fences publication when the connection retires during path translation", async t => {
  const fixture = await createFixture(t)
  const installed = await fixture.install("automation", ["codenomad.automation"])
  let current = true
  await assert.rejects(readManagedDesktopPlugins({
    globalDirectory: fixture.paths.config, paths: nativePaths,
    hostPath: async native => { if (native === installed.plugin) current = false; return native },
    assertCurrent: () => { if (!current) throw new Error("connection retired") },
  }), /connection retired/)
})

async function createFixture(t: TestContext, dataName = "data") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-managed-plugin-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const paths = { config: path.join(root, "config"), data: path.join(root, dataName) }
  return {
    root, paths,
    read: () => readManagedDesktopPlugins({ globalDirectory: paths.config, paths: nativePaths, hostPath: async native => native, assertCurrent() {} }),
    install: async (feature: DesktopPluginFeature, ids: string[], provider?: Buffer) => {
      const stop = await installDesktopPluginPresence(feature, bundleFor(ids), paths, () => {}, undefined, provider)
      await stop()
      const entry = path.join(paths.config, "plugins", `codenomad-${feature}.ts`)
      const source = await fs.readFile(entry, "utf8")
      const parsed = parseManagedDesktopPluginEntry(feature, source, nativePaths)!
      return { entry, source, plugin: parsed.plugin }
    },
  }
}
