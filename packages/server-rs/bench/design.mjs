// Mode `design`: the Design request each backend writes into its session-pruning lease while an API 4
// `opencode.designAgent` extension is installed, enabled, disabled, enabled again and removed.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fromDist } from "./fixtures.mjs"

const { fixtureArchive } = await fromDist("panel-extensions/archive-fixture.js")

const post = (body, method = "POST") => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

/** Every `.lease` of the session-pruning presence this backend provisioned. Rust
 * retains the storage folder of the fixture's earlier install, as TS would: its
 * own lease is the one its status names, beside the fixture's. */
async function pruningLeases(root) {
  const status = await readFile(path.join(root, "rust.data", "plugin-provision.json"), "utf8").then(JSON.parse, () => undefined)
  const own = status?.features?.find(f => f.feature === "session-pruning")?.lease
  const rust = await readdir(path.join(root, "rust.data")).then(() => true, () => false)
  if (rust && !own) return []
  const found = []
  const walk = async (dir, depth) => {
    if (depth > 9) return
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (own && entry.isFile() && entry.name.endsWith(".lease") && entry.name !== own) continue
      if ([".git", "node_modules", "Rich", "Local Project", "Rust Project", "No Repository"].includes(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, depth + 1)
      else if (entry.name.endsWith(".lease") && /[\\/]session-pruning[\\/]presence[\\/]/.test(full)) found.push(full)
    }
  }
  await walk(root, 0)
  return found.sort()
}
const leaseContents = async root => Promise.all((await pruningLeases(root)).map(file => readFile(file, "utf8")))

export async function run({ call, fixture, folder }) {
  const read = async (route, init = {}) => {
    const r = await call(route, { signal: AbortSignal.timeout(30_000), ...init })
    const text = await r.text()
    let body = null
    try { body = text ? JSON.parse(text) : null } catch { body = { text: text.slice(0, 200) } }
    return { status: r.status, body }
  }
  // A workspace connection provisions the TS server's leases.
  const opened = await read("/api/workspaces", post({ path: folder }))
  assert.equal(opened.status, 201, JSON.stringify(opened.body))
  const design = {}
  try {
    let leases
    for (let i = 0; i < 100 && !(leases = await pruningLeases(fixture.root)).length; i++) await delay(100)
    design.leaseCount = leases.length
    // The TS server writes on each store change; a change shows within 3 s at most.
    const settle = async previous => {
      for (let i = 0; i < 30; i++) {
        const now = await leaseContents(fixture.root)
        if (JSON.stringify(now) !== JSON.stringify(previous)) return now
        await delay(100)
      }
      return leaseContents(fixture.root)
    }
    const steps = []
    let contents = await leaseContents(fixture.root)
    steps.push({ step: "no extension", leases: contents })
    const manifest = { id: "fixture.design", apiVersion: 4, permissions: ["session.context", "opencode.designAgent"] }
    const archiveBase64 = fixtureArchive("<p>Design</p>", manifest).toString("base64")
    const inspected = await read("/api/panel-extensions/inspect", post({ archiveBase64 }))
    steps.push({ step: "inspect", status: inspected.status, manifest: inspected.body?.manifest })
    const digest = inspected.body?.digest
    const installed = await read("/api/panel-extensions", post({ archiveBase64, digest, acknowledged: true }))
    contents = await settle(contents)
    steps.push({ step: "installed disabled", status: installed.status, body: installed.body, leases: contents })
    const inventory = await read("/api/panel-extensions")
    steps.push({ step: "inventory", status: inventory.status, body: inventory.body })
    const ext = `/api/panel-extensions/${manifest.id}`
    for (const [step, enabled] of [["enabled", true], ["disabled", false], ["enabled again", true]]) {
      const changed = await read(ext, post({ digest, enabled }, "PATCH"))
      contents = await settle(contents)
      steps.push({ step, status: changed.status, body: changed.body, leases: contents })
    }
    const removed = await read(ext, post({ digest }, "DELETE"))
    contents = await settle(contents)
    steps.push({ step: "removed", status: removed.status, body: removed.body, leases: contents })
    design.steps = steps
    // Not ported (no host surface): another API 4 permission is refused by Rust only.
    const other = fixtureArchive("<p>Prefill</p>", { id: "fixture.prefill", apiVersion: 4, permissions: ["session.context", "composer.prefill"] }).toString("base64")
    design.unportedPermission = (await read("/api/panel-extensions/inspect", post({ archiveBase64: other }))).status
    return { design }
  } finally {
    await call(`/api/workspaces/${opened.body.id}`, { method: "DELETE" }).catch(() => {})
  }
}

/** The parts both backends must answer identically (the known unported refusal apart). */
export const comparable = ({ design: { unportedPermission, ...design } }) => ({ design })
