import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DesktopPluginLifecycle } from "../desktop-plugin-lifecycle"
import { observeDesignRequest, PRESENCE_EXPIRY_MS } from "../desktop-plugin-presence"
import type { PanelExtensionSummary } from "../../panel-extensions/contract"
import { DESIGN_LEASE_MAX_BYTES, designLeaseContent, leaseRequestsDesign } from "./activation"
import { DESIGN_CONTENT_MARK } from "./content"
import { designRequestRefresher, extensionsRequestDesign } from "./demand"
import { designAgentStatus } from "./status"

const bundle = Buffer.from("export const desktopPlugin = () => ({ id: 'isolated-fixture' })")
const REQUEST = designLeaseContent(true)

// A fresh observer per check: the shared observation is evicted once released.
async function requested(directories: string | readonly string[]) {
  const observer = observeDesignRequest(directories)
  try { return await observer.read() } finally { observer.release() }
}

async function leaseContents(directory: string) {
  const names = (await readdir(directory)).sort()
  assert(names.every(name => /^[\da-f-]+\.lease$/.test(name)), `Only leases remain: ${names.join(", ")}`)
  return Promise.all(names.map(name => readFile(path.join(directory, name), "utf8")))
}

test("only an exact version 1 lease requests Design", () => {
  assert.equal(REQUEST, "{\"version\":1,\"design\":true}")
  assert.equal(designLeaseContent(false), "")
  assert.equal(leaseRequestsDesign(REQUEST), true)
  for (const content of ["", "{", "null", "[]", "true", "{\"version\":2,\"design\":true}", "{\"version\":1,\"design\":\"true\"}",
    "{\"version\":1}", "{\"design\":true}"]) {
    assert.equal(leaseRequestsDesign(content), false, content)
  }
})

test("live leases request Design by union; expired, oversized, unknown and unreadable leases request nothing", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-design-presence-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const current = path.join(root, "current"), older = path.join(root, "older")
  const lease = (directory: string, name: string, content: string) => writeFile(path.join(directory, `${name}.lease`), content)
  await Promise.all([current, older].map(directory => mkdir(directory)))
  await lease(current, "aaa-1", "")
  assert.equal(await requested([current, older]), false)
  await lease(current, "aaa-2", " ".repeat(DESIGN_LEASE_MAX_BYTES) + REQUEST)
  await lease(current, "aaa-3", "{\"version\":2,\"design\":true}")
  await lease(current, "aaa-4", "not json")
  await mkdir(path.join(current, "aaa-5.lease"))
  await writeFile(path.join(current, "aaa-6.lease.tmp"), REQUEST)
  assert.equal(await requested([current, older]), false, "No lease requests Design")
  await lease(older, "bbb-1", REQUEST)
  assert.equal(await requested([current, older]), true, "A request in any presence directory counts")
  assert.equal(await requested(current), false)
  const expired = new Date(Date.now() - PRESENCE_EXPIRY_MS - 1_000)
  await utimes(path.join(older, "bbb-1.lease"), expired, expired)
  assert.equal(await requested([current, older]), false, "An expired lease requests nothing")
})

test("every retained lease of a backend carries its current request, including later installations", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codenomad-design-leases-"))
  const lifecycle = new DesktopPluginLifecycle("session-pruning", async () => bundle)
  const other = new DesktopPluginLifecycle("session-pruning", async () => bundle)
  t.after(async () => {
    await Promise.all([lifecycle.stop(), other.stop()])
    await rm(root, { recursive: true, force: true })
  })
  const paths = (name: string) => ({ config: path.join(root, name), data: path.join(root, name, ".codenomad") })
  const presence = (name: string) => path.join(root, name, ".codenomad", "session-pruning", "presence")
  // Reconnecting from one configuration namespace to another retains both installations.
  await lifecycle.start(paths("first"))
  await lifecycle.start(paths("second"))
  await other.start(paths("first"))
  assert.deepEqual(await leaseContents(presence("first")), ["", ""])
  await lifecycle.setLeaseContent(REQUEST)
  assert.deepEqual((await leaseContents(presence("first"))).sort(), ["", REQUEST])
  assert.deepEqual(await leaseContents(presence("second")), [REQUEST])
  assert.equal(await requested(presence("first")), true)
  await lifecycle.start(paths("third"))
  assert.deepEqual(await leaseContents(presence("third")), [REQUEST], "A new installation starts from the current state")
  await lifecycle.setLeaseContent("")
  for (const name of ["first", "second", "third"]) assert.equal(await requested(presence(name)), false, name)
  await lifecycle.setLeaseContent(REQUEST)
  await lifecycle.stop()
  await lifecycle.setLeaseContent("")
  await lifecycle.setLeaseContent(REQUEST)
  assert.deepEqual(await leaseContents(presence("first")), [""], "Stopping removes its leases; later writes never resurrect them")
  assert.deepEqual(await readdir(presence("second")), [])
})

test("the request follows enabled extensions declaring opencode.designAgent; refreshes coalesce", async () => {
  const entry = (enabled: boolean, permissions: string[]) => ({ enabled, digest: "0".repeat(64),
    manifest: { id: "x", name: "x", version: "1.0.0", author: "x", license: "MIT", repository: "https://example.com", apiVersion: 1, permissions } }) as unknown as PanelExtensionSummary
  assert.equal(extensionsRequestDesign([entry(true, ["session.context", "session.assets.read"])]), false)
  assert.equal(extensionsRequestDesign([entry(false, ["session.context", "opencode.designAgent"])]), false)
  assert.equal(extensionsRequestDesign([entry(true, ["session.context", "opencode.designAgent"])]), true)

  let entries = [entry(true, ["session.context", "opencode.designAgent"])]
  let lists = 0, failing = false
  const writes: string[] = []
  const refresh = designRequestRefresher({ list: async () => {
    lists++
    if (failing) throw new Error("unavailable")
    return entries
  } }, { setLeaseContent: async content => { writes.push(content) } })
  await Promise.all([refresh(), refresh(), refresh()])
  assert.equal(lists, 2, "Calls during a refresh coalesce into one trailing pass")
  assert.deepEqual(writes, [REQUEST, REQUEST])
  entries = []
  await refresh()
  failing = true
  entries = [entry(true, ["session.context", "opencode.designAgent"])]
  await refresh()
  assert.deepEqual(writes.slice(2), ["", ""], "Disabled, removed or unreadable state requests nothing")
})

test("the agent status distinguishes CodeNomad's Design agent from the user's", () => {
  assert.deepEqual(designAgentStatus([{ id: "build", system: DESIGN_CONTENT_MARK }]), { designAgent: "absent", contentVersion: null })
  assert.deepEqual(designAgentStatus([{ id: "design", system: `${DESIGN_CONTENT_MARK}\nYou are Design.` }]), { designAgent: "present", contentVersion: 1 })
  assert.deepEqual(designAgentStatus([{ id: "design", system: "My own design agent" }]), { designAgent: "user", contentVersion: null })
  assert.deepEqual(designAgentStatus([{ id: "design" }]), { designAgent: "user", contentVersion: null })
  assert.deepEqual(designAgentStatus([{ id: "design", system: `Note: ${DESIGN_CONTENT_MARK}` }]), { designAgent: "user", contentVersion: null })
})
