import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { installDesktopPluginArtifact } from "./desktop-plugin-artifact"
import { installDesktopPluginPresence } from "./desktop-plugin-installation"

test("native filesystem identities allow intact runtime and provider payloads to install and reopen", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-artifact-native-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const paths = { config: path.join(root, "config"), data: path.join(root, "data") }
  for (const feature of ["session-pruning", "automation", "missions"] as const) {
    const bundle = Buffer.from(`trusted ${feature}`)
    for (let attempt = 0; attempt < 2; attempt++) {
      const stop = await installDesktopPluginPresence(feature, bundle, paths, undefined, undefined,
        feature === "missions" ? Buffer.from("trusted provider") : undefined)
      await stop()
    }
    const hash = createHash("sha256").update(bundle).digest("hex")
    assert.deepEqual(await fs.readFile(path.join(paths.data, feature, `${hash}.mjs`)), bundle)
  }
})

test("Windows missing pathname device is resolved through independent handles, with exact negative identity controls", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-artifact-missing-device-"))
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!
  t.after(async () => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    Object.defineProperty(process, "platform", platform)
    await fs.rm(root, { recursive: true, force: true })
  })
  const bundle = Buffer.from("trusted"), hash = createHash("sha256").update(bundle).digest("hex")
  const payload = path.join(root, `${hash}.mjs`)
  await fs.writeFile(payload, bundle)
  // The reported inode exceeds Number.MAX_SAFE_INTEGER: adjacent IDs can round together.
  const inode = 13792273859649052n
  assert.equal(Number(inode), Number(inode + 1n))
  let mode = "valid", stats = 0, names = 0
  const originalLstat = fs.lstat, originalOpen = fs.open
  // Exercise the Windows-only policy in every CI host's isolated test process.
  Object.defineProperty(process, "platform", { value: "win32" })
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof fs.lstat>) => {
    const info = await originalLstat(...args)
    if (args[0] === payload) {
      names++
      // Reproduce the real missing device with either numeric or BigInt callers.
      if (typeof info.dev === "bigint") {
        info.dev = mode === "different device" ? 999999999n : 0n
        info.ino = mode === "different inode" ? inode + 1n : mode === "missing inode" ? 0n : inode
        if (mode === "hard link") info.nlink = 2n
      } else Object.assign(info, { dev: 0 })
      if (mode === "symlink" || mode === "link during probe" && names === 4) info.isSymbolicLink = () => true
    }
    return info
  })
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args)
    if (args[0] === payload) {
      const originalStat = handle.stat.bind(handle)
      t.mock.method(handle, "stat", async (options?: { bigint?: boolean }) => {
        const info = await originalStat(options as { bigint: true })
        if (typeof info.ino === "bigint") {
          info.ino = mode === "missing inode" ? 0n : inode
          stats++
          if (mode === "missing handle device") info.dev = 0n
          if (mode === "different probe device" && stats % 2 === 0) info.dev += 1n
        }
        return info
      })
    }
    return handle
  })
  syncBuiltinESMExports()
  const check = await installDesktopPluginArtifact(payload, bundle, hash)
  await check()
  const posixCheck = await installDesktopPluginArtifact(payload, bundle, hash)
  Object.defineProperty(process, "platform", { value: "linux" })
  await assert.rejects(posixCheck(), /device or inode/, "a missing device never bypasses the POSIX comparison")
  Object.defineProperty(process, "platform", { value: "win32" })
  for (const [control, reason] of [
    ["different device", /device or inode/],
    ["different inode", /device or inode/],
    ["missing inode", /device or inode/],
    ["hard link", /single regular file/],
    ["symlink", /single regular file/],
    ["missing handle device", /device or inode/],
    ["different probe device", /device or inode/],
    ["link during probe", /device or inode/],
  ] as const) {
    mode = "valid"
    const recheck = await installDesktopPluginArtifact(payload, bundle, hash)
    mode = control; stats = 0; names = 0
    await assert.rejects(recheck(), reason, control)
  }
  mode = "valid"
  const recheck = await installDesktopPluginArtifact(payload, bundle, hash)
  await fs.writeFile(payload, "changed") // Same length and inode; hashing still rejects other bytes.
  await assert.rejects(recheck(), /SHA-256 differs/)
  await fs.writeFile(payload, bundle)
  await check()
})

test("a hard-linked payload is replaced without modifying its other name", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codenomad-artifact-hardlink-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bundle = Buffer.from("trusted"), hash = createHash("sha256").update(bundle).digest("hex")
  const other = path.join(root, "other.mjs"), payload = path.join(root, `${hash}.mjs`)
  await fs.writeFile(other, "untrusted")
  await fs.link(other, payload)
  const check = await installDesktopPluginArtifact(payload, bundle, hash)
  await check()
  assert.deepEqual(await fs.readFile(payload), bundle)
  assert.equal(await fs.readFile(other, "utf8"), "untrusted")
  assert.equal((await fs.lstat(payload)).nlink, 1)
})
