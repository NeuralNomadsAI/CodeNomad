// Mode `depth`: subagent-depth on owned subfolders (root, linked checkout, missing, foreign and alias
// junctions) with the documents written, and the worktree-deletion fence.
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import assert from "node:assert/strict"
import path from "node:path"

const NAMES = ["opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc"]

/** A private Global layer and no inline `experimental` block, written before the daemon starts. */
export async function prepare({ configDirectory }) {
  await writeFile(path.join(configDirectory, "opencode.jsonc"), `{\n  // Global layer of the depth bench\n  "experimental": {\n    "media_blob": true,\n    "subagent_depth": 2\n  }\n}\n`)
}

export async function run({ call, fixture, folder, other: otherFolder }) {
  const post = body => ({ method: "POST", signal: AbortSignal.timeout(60000), headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const opened = await call("/api/workspaces", post({ path: folder }))
  assert.equal(opened.status, 201)
  const w = await opened.json()
  const dir = w.location?.directory ?? w.path
  assert(path.resolve(dir).startsWith(path.resolve(fixture.root)), "Bench project inside the private fixture")
  const base = `/api/workspaces/${w.id}/subagent-depth`
  const hide = value => typeof value === "string" ? value.replaceAll(dir, "<project>").replaceAll(fixture.root, "<root>")
    : Array.isArray(value) ? value.map(hide) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hide(v)])) : value
  const read = async (route, init) => {
    const r = await call(route, { signal: AbortSignal.timeout(30000), ...init })
    const text = await r.text()
    return { status: r.status, body: text ? JSON.parse(text) : null }
  }
  const get = directory => read(`${base}?${new URLSearchParams({ directory })}`)
  const put = (directory, depth, expectation) => read(base, { method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ location: { directory }, depth, expectation }) })
  const shown = r => ({ status: r.status, body: hide(r.body?.project ? { ...r.body, project: { ...r.body.project, expectation: "<sha256>" } } : r.body) })
  const files = async at => Object.fromEntries(await Promise.all(NAMES.map(async n => [n, await readFile(path.join(at, n), "utf8").catch(() => null)])))
  const exists = at => readFile(at).then(() => true, e => e.code !== "ENOENT")
  // Both servers bound General's rules read to 5 s; a fresh Location's first agent list can
  // exceed it, so the bench warms each existing Location natively first.
  const warm = async directory => {
    for (let i = 0; i < 40; i++) {
      const agents = await fixture.client.agent.list({ location: { directory } }).catch(() => undefined)
      if (agents?.data?.some?.(a => a.id === "general")) return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  const worktree = async slug => {
    const r = await call(`/api/workspaces/${w.id}/worktrees`, post({ slug, fromSlug: "root" }))
    assert.equal(r.status, 201, await r.clone().text())
    const tree = await r.json()
    await warm(tree.serviceDirectory)
    return tree
  }
  // A full GET/PUT/GET round on one location, with the documents written there.
  const round = async (location, at = location) => {
    if (await exists(at)) await warm(at)
    const before = await get(location)
    const out = { get: shown(before) }
    if (before.status === 200) {
      out.put = shown(await put(location, 3, before.body.project.expectation))
      out.files = await files(at)
      out.after = shown(await get(location))
    } else out.put = shown(await put(location, 3, "a".repeat(64)))
    return out
  }
  const out = {}
  const trees = []
  try {
    const sub = path.join(dir, "packages", "app")
    await mkdir(sub, { recursive: true })
    out.rootSubfolder = await round(sub)

    const missing = path.join(dir, "not-yet", "deeper")
    out.missingSubfolder = await round(missing)
    out.missingCreated = await exists(path.join(missing, ".opencode", "opencode.jsonc"))

    await symlink(otherFolder, path.join(dir, "foreign-link"), "junction")
    out.foreignJunction = await round(path.join(dir, "foreign-link"))
    out.foreignJunctionChild = await round(path.join(dir, "foreign-link", "child"))
    out.foreignUntouched = await files(otherFolder)

    await symlink(sub, path.join(dir, "alias-link"), "junction")
    out.aliasJunction = await round(path.join(dir, "alias-link"), sub)

    const tree = await worktree("depth-sub")
    trees.push(tree)
    const nested = path.join(tree.serviceDirectory, "pkg")
    await mkdir(nested, { recursive: true })
    out.linkedSubfolder = await round(nested)
    await rm(path.join(nested, ".opencode"), { recursive: true, force: true })

    // PUT at the evacuation destination while a worktree deletion runs: the fence refuses it.
    const stale = (await get(dir)).body.project.expectation
    out.rootSet = shown(await put(dir, 1, stale))
    for (let attempt = 1; attempt <= 3; attempt++) {
      const doomed = await worktree(`depth-delete-${attempt}`)
      await fixture.client.session.create({ location: { directory: doomed.serviceDirectory }, title: "Evacuated by the depth bench" })
      const seen = new Set(), reads = new Set()
      let finished = false
      const deletion = call(`/api/workspaces/${w.id}/worktrees/${doomed.slug}`, { method: "DELETE", signal: AbortSignal.timeout(90000) })
        .then(async r => ({ status: r.status, body: await r.text() })).finally(() => { finished = true })
      while (!finished) {
        const [p, g] = await Promise.all([put(dir, 2, stale), get(dir)])
        seen.add(`${p.status} ${p.body?.error}`)
        reads.add(g.status)
      }
      const deleted = await deletion
      // The attempt number depends on timing, so it is logged rather than compared.
      console.log(`depth fence attempt ${attempt}: ${[...seen].join(" | ")}`)
      out.deletion = { delete: deleted.status, puts: [...seen].sort(), gets: [...reads].sort() }
      if (seen.has("409 Worktree deletion is in progress")) break
      trees.push(doomed)
    }
    out.afterDeletion = shown(await put(dir, 2, stale))
  } finally {
    for (const tree of trees) await call(`/api/workspaces/${w.id}/worktrees/${tree.slug}`, { method: "DELETE", signal: AbortSignal.timeout(90000) }).catch(() => {})
    for (const name of ["foreign-link", "alias-link"]) await rm(path.join(dir, name), { force: true }).catch(() => {})
    for (const name of ["packages", "not-yet", ".opencode"]) await rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {})
    await call(`/api/workspaces/${w.id}`, { method: "DELETE" }).catch(() => {})
  }
  return out
}
