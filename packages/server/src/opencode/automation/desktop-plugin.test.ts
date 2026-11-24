import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { desktopPlugin } from "./desktop-plugin"
import { installDesktopPluginPresence } from "../desktop-plugin-installation"
import { PRESENCE_EXPIRY_MS, PRESENCE_INTERVAL_MS } from "../desktop-plugin-presence"
import { followPresence } from "../desktop-plugin-presence"

test("all unified tools follow independent backend leases, expiry, and unload", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-browser-presence-"))
  const paths = { config: path.join(root, "config"), data: path.join(root, "data") }
  const leases = path.join(paths.data, "automation", "presence")
  const bundle = Buffer.from("export const desktopPlugin = () => ({ id: 'fixture' })")
  const tools = new Set<string>()
  const skills = new Set<string>()
  let registrations = 0
  const registry = (values: Set<string>) => {
    const callbacks = new Set<(editor: unknown) => void>()
    const reload = async () => {
      values.clear()
      for (const callback of callbacks) callback({ add: (value: { name: string }) => values.add(value.name) })
    }
    return { reload, transform: async (callback: (editor: unknown) => void) => {
      callbacks.add(callback)
      await reload()
      registrations++
      return { dispose: async () => { callbacks.delete(callback); await reload() } }
    } }
  }
  const ctx = { tool: registry(tools), skill: registry(skills) } as unknown as Plugin.Context
  let first: (() => Promise<void>) | undefined
  let second: (() => Promise<void>) | undefined
  let stop: Plugin.Cleanup | void = undefined
  const until = async (predicate: () => boolean) => {
    for (let i = 0; i < 100 && !predicate(); i++) await delay(100)
    assert(predicate())
  }
  try {
    stop = await desktopPlugin(leases).setup(ctx)
    assert.equal(tools.size, 0)
    first = await installDesktopPluginPresence("automation", bundle, paths)
    await until(() => tools.size === 4 && skills.size === 1)
    assert.deepEqual([...tools].sort(), ["act", "browser", "inspect", "screenshot"])
    assert.deepEqual([...skills], ["CodeNomad Browser"])
    const source = await readFile(path.join(paths.config, "plugins", "codenomad-automation.ts"), "utf8")
    assert(!source.includes("node_modules"))
    second = await installDesktopPluginPresence("automation", bundle, paths)
    await first(); first = undefined
    await delay(PRESENCE_INTERVAL_MS + 100)
    assert.equal(tools.size, 4)
    assert.equal(registrations, 2)
    await second(); second = undefined
    await until(() => tools.size === 0 && skills.size === 0)
    const stale = path.join(leases, "dead.lease")
    await writeFile(stale, "")
    await until(() => tools.size === 4)
    const expired = new Date(Date.now() - PRESENCE_EXPIRY_MS - 100)
    await utimes(stale, expired, expired)
    await until(() => tools.size === 0 && skills.size === 0)
    first = await installDesktopPluginPresence("automation", bundle, paths)
    await until(() => tools.size === 4)
    await stop?.(); stop = undefined
    assert.equal(tools.size, 0)
    assert.equal(skills.size, 0)
    assert.equal((await readdir(path.join(paths.data, "automation"))).filter(name => name.endsWith(".mjs")).length, 1)
  } finally {
    await stop?.(); await first?.(); await second?.()
    await rm(root, { recursive: true, force: true })
  }
})

test("browser installation preserves user-authored and empty entries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-browser-user-"))
  const plugins = path.join(root, "plugins")
  try {
    await mkdir(plugins)
    const entry = path.join(plugins, "codenomad-automation.ts")
    for (const source of ["// User browser integration", ""]) {
      await writeFile(entry, source)
      await assert.rejects(installDesktopPluginPresence("automation", Buffer.from("fixture"), { config: root, data: path.join(root, "data") }), /not managed/)
      assert.equal(await readFile(entry, "utf8"), source)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("WSL discovery entry uses native URLs and lease paths, not host UNC paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-browser-wsl-"))
  let cleanup: (() => Promise<void>) | undefined
  try {
    cleanup = await installDesktopPluginPresence("automation", Buffer.from("fixture"), {
      config: root, data: path.join(root, "data"), nativeData: "/home/fixture/user data/codenomad",
    })
    const source = await readFile(path.join(root, "plugins", "codenomad-automation.ts"), "utf8")
    assert.match(source, /file:\/\/\/home\/fixture\/user%20data\/codenomad\/automation\/[a-f\d]+\.mjs/)
    assert.match(source, /desktopPlugin\("\/home\/fixture\/user data\/codenomad\/automation\/presence"\)/)
    assert(!source.includes(root))
  } finally { await cleanup?.(); await rm(root, { recursive: true, force: true }) }
})

test("installation upgrades only the recognizable generated automation shim in the selected namespace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-automation-upgrade-"))
  let cleanup: (() => Promise<void>) | undefined
  try {
    await mkdir(path.join(root, "plugins"))
    const entry = path.join(root, "plugins", "codenomad-automation.ts")
    await writeFile(entry, 'export { default } from "file:///C:/CodeNomad/resources/server/dist/opencode/automation-plugin.js"\n')
    cleanup = await installDesktopPluginPresence("automation", Buffer.from("fixture"), { config: root, data: path.join(root, "data") })
    assert.match(await readFile(entry, "utf8"), /^\/\/ Managed by CodeNomad: automation lifecycle v1/)
  } finally { await cleanup?.(); await rm(root, { recursive: true, force: true }) }
})

test("a new storage default retains existing managed leases for older backends", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-plugin-storage-upgrade-"))
  const disposals: Array<() => Promise<void>> = []
  try {
    for (const feature of ["automation", "session-pruning"] as const) {
      const config = path.join(root, "config")
      const data = path.join(root, "previous-data-root")
      const old = await installDesktopPluginPresence(feature, Buffer.from("old bundle"), { config, data })
      disposals.push(old)
      const latest = await installDesktopPluginPresence(feature, Buffer.from("new bundle"), {
        config, data: path.join(config, ".codenomad"),
      })
      disposals.push(latest)
      const leases = path.join(data, feature, "presence")
      assert.equal((await readdir(leases)).length, 2)
      const source = await readFile(path.join(config, "plugins", `codenomad-${feature}.ts`), "utf8")
      assert(source.includes(JSON.stringify(leases)))
      await latest()
      assert.equal((await readdir(leases)).length, 1, "Closing the new backend retains the old backend's presence")
      await assert.rejects(readdir(path.join(config, ".codenomad", feature)), { code: "ENOENT" })
    }
  } finally {
    await Promise.all(disposals.map(dispose => dispose()))
    await rm(root, { recursive: true, force: true })
  }
})

test("watched-root storage migrates heartbeats without losing a live older backend", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-watched-presence-"))
  const config = path.join(root, "config")
  const oldData = path.join(config, ".codenomad")
  const data = path.join(root, "unwatched-data")
  const entry = path.join(config, "plugins", "codenomad-automation.ts")
  const oldLeases = path.join(oldData, "automation", "presence")
  const newLeases = path.join(data, "automation", "presence")
  const disposals: Array<() => Promise<void>> = []
  let stop: (() => Promise<void>) | undefined
  try {
    const old = await installDesktopPluginPresence("automation", Buffer.from("old bundle"), { config, data: oldData })
    disposals.push(old)
    const original = await readdir(oldLeases)
    const latest = await installDesktopPluginPresence("automation", Buffer.from("new bundle"), { config, data })
    disposals.push(latest)
    const source = await readFile(entry, "utf8")
    assert(source.includes(JSON.stringify([newLeases, oldLeases])))
    assert.deepEqual(await readdir(oldLeases), original, "The new backend never writes another watched lease")
    assert.equal((await readdir(newLeases)).length, 1)
    const next = await installDesktopPluginPresence("automation", Buffer.from("new bundle"), { config, data })
    disposals.push(next)
    assert.equal(await readFile(entry, "utf8"), source, "Subsequent starts retain migration readers without rewriting the entry")
    await next(); await latest()
    let active = false
    stop = await followPresence([newLeases, oldLeases], async () => { active = true; return () => { active = false } })
    assert(active, "The older backend remains registered after both new backends close")
    await old()
    for (let i = 0; i < 40 && active; i++) await delay(100)
    assert.equal(active, false)
  } finally {
    await stop?.()
    await Promise.all(disposals.map(dispose => dispose()))
    await rm(root, { recursive: true, force: true })
  }
})
