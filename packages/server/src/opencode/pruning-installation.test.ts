import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { installPruningPresence } from "./pruning-installation"
import { followPresence, hasPresence, PRESENCE_EXPIRY_MS, PRESENCE_INTERVAL_MS } from "./session-pruning/presence"
import { setTimeout as delay } from "node:timers/promises"

test("bundled installation supports two backends, clean close, crash expiry and reopening", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-pruning-presence-"))
  const paths = { config: path.join(root, "config"), data: path.join(root, "data") }
  const leases = path.join(paths.data, "session-pruning", "presence")
  let first: (() => Promise<void>) | undefined
  let second: (() => Promise<void>) | undefined
  let stop: (() => Promise<void>) | undefined
  let registrations = 0
  let disposals = 0
  const check = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await delay(100)
    assert(predicate())
  }
  try {
    stop = await followPresence(leases, async () => { registrations++; return () => { disposals++ } })
    assert.equal(registrations, 0)
    const bundle = Buffer.from("export const desktopPlugin = () => ({id: 'fixture'})")
    first = await installPruningPresence(bundle, paths)
    await check(() => registrations === 1)
    const entry = path.join(paths.config, "plugins", "codenomad-session-pruning.ts")
    const source = await readFile(entry, "utf8")
    assert(!source.includes("node_modules"))
    second = await installPruningPresence(bundle, paths)
    assert.equal(await readFile(entry, "utf8"), source)
    await first(); first = undefined
    await delay(PRESENCE_INTERVAL_MS + 100)
    assert.equal(disposals, 0)
    await second(); second = undefined
    await check(() => disposals === 1)
    const stale = path.join(leases, "dead.lease")
    await writeFile(stale, "")
    const beforeCrash = new Date(Date.now() - PRESENCE_EXPIRY_MS - 100)
    await utimes(stale, beforeCrash, beforeCrash)
    assert.equal(await hasPresence(leases), false)
    first = await installPruningPresence(bundle, paths)
    await check(() => registrations === 2)
    await stop(); stop = undefined
    assert.equal(disposals, 2)
    assert.equal((await readdir(path.join(paths.data, "session-pruning"))).filter(name => name.endsWith(".mjs")).length, 1)
  } finally {
    await stop?.(); await first?.(); await second?.()
    await rm(root, { recursive: true, force: true })
  }
})

test("unloading while RPC registration is pending disposes it exactly once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-pruning-unload-"))
  let finish!: () => void
  let stopped = 0
  let started = false
  const pending = new Promise<void>(resolve => { finish = resolve })
  const cleanup = await followPresence(root, async () => {
    started = true
    await pending
    return () => { stopped++ }
  })
  try {
    await writeFile(path.join(root, "abcd.lease"), "")
    for (let i = 0; i < 100 && !started; i++) await delay(50)
    assert(started)
    const closing = cleanup()
    finish()
    await closing
    assert.equal(stopped, 1)
  } finally { finish(); await cleanup(); await rm(root, { recursive: true, force: true }) }
})

test("installation preserves a user-authored plugin entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-pruning-existing-"))
  const plugins = path.join(root, "plugins")
  try {
    await mkdir(plugins)
    const entry = path.join(plugins, "codenomad-session-pruning.ts")
    await writeFile(entry, "// user work")
    await assert.rejects(installPruningPresence(Buffer.from("fixture"), { config: root, data: path.join(root, "data") }), /not managed/)
    assert.equal(await readFile(entry, "utf8"), "// user work")
  } finally { await rm(root, { recursive: true, force: true }) }
})
