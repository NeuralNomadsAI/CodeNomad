import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import { installDesktopPluginPresence } from "./desktop-plugin-installation"
import { parseManagedDesktopPluginEntry, readManagedDesktopPlugins } from "./desktop-plugin-managed"
import { resolveDesktopPluginWslPath } from "./desktop-plugin-wsl-paths"

const distro = process.env.CODENOMAD_TEST_WSL_PLUGIN_CONTROLS

test("publishes and recognizes managed Linux WSL artifacts through zero-device UNC identities", { skip: !distro }, async () => {
  const root = `/tmp/codenomad-managed-plugins-${randomBytes(8).toString("hex")}`
  const run = (script: string, ...args: string[]) => execFileSync("wsl.exe", ["--distribution", distro!, "--exec", "sh", "-c", script, "fixture", ...args],
    { encoding: "utf8", windowsHide: true, timeout: 30_000 })
  const resolve = (native: string, assertCurrent = () => {}) => resolveDesktopPluginWslPath(native, distro!, Date.now() + 30_000, assertCurrent)
  let stop: Awaited<ReturnType<typeof installDesktopPluginPresence>> | undefined
  try {
    run('mkdir -m 700 -- "$1"; mkdir -- "$1/config" "$1/data"', root)
    const config = await resolve(`${root}/config`), data = await resolve(`${root}/data`)
    const paths = { config: config.host, data: data.host, nativeData: data.native, resolveNativePath: resolve }
    const bundle = Buffer.from('// CodeNomad plugin IDs: ["fixture.wsl-managed"]\nexport const desktopPlugin = () => {}\n')
    stop = await installDesktopPluginPresence("automation", bundle, paths)
    const entry = path.join(config.host, "plugins", "codenomad-automation.ts")
    const parsed = parseManagedDesktopPluginEntry("automation", await fs.readFile(entry, "utf8"), path.posix)!
    const payload = (await resolve(parsed.plugin)).host
    for (const file of [entry, payload]) {
      const named = await fs.lstat(file, { bigint: true }), handle = await fs.open(file)
      try {
        const held = await handle.stat({ bigint: true })
        assert.equal(named.dev, 0n)
        assert.equal(held.dev, 0n)
        assert.notEqual(named.ino, 0n)
        assert.equal(named.ino, held.ino)
        assert.equal(named.nlink, 1n)
      } finally { await handle.close() }
    }
    const read = () => readManagedDesktopPlugins({ globalDirectory: config.native, paths: path.posix,
      hostPath: async native => (await resolve(native)).host, assertCurrent() {} })
    assert.deepEqual(await read(), [{ entry: `${config.native}/plugins/codenomad-automation.ts`, plugin: parsed.plugin, ids: ["fixture.wsl-managed"] }])
    await stop(); stop = undefined
    await fs.writeFile(payload, "corrupt")
    assert.deepEqual(await read(), [], "digest mismatch withholds ownership")
    stop = await installDesktopPluginPresence("automation", bundle, paths)
    assert.equal((await read()).length, 1, "the shared publisher repairs and verifies the same WSL storage")
    await stop(); stop = undefined
    run('mv -- "$1" "$2"; ln -- "$2" "$1"', parsed.plugin, `${parsed.plugin}.original`)
    assert.deepEqual(await read(), [], "multiple hard links refuse recognition")
    run('rm -- "$1"; ln -s -- "$2" "$1"', parsed.plugin, `${parsed.plugin}.original`)
    assert.deepEqual(await read(), [], "symbolic links refuse recognition")
  } finally {
    await stop?.()
    run('rm -rf -- "$1"', root)
  }
})
