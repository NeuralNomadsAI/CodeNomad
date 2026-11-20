// Mode `worktree-gone`: a registered linked worktree whose `.git` or administrative directory is gone,
// as during `git worktree remove` or after an interrupted one.
import assert from "node:assert/strict"
import { readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const post = body => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

export async function run({ call, folder }) {
  const read = async (route, init) => {
    const r = await call(route, { signal: AbortSignal.timeout(60000), ...init })
    const text = await r.text()
    return { status: r.status, body: text ? JSON.parse(text) : null }
  }
  const opened = await read("/api/workspaces", post({ path: folder }))
  assert.equal(opened.status, 201, JSON.stringify(opened.body))
  const base = `/api/workspaces/${opened.body.id}/worktrees`
  const out = {}
  let tree, marker, saved, admin
  try {
    tree = (await read(base, post({ slug: "gone-worktree", fromSlug: "root" }))).body
    const listed = await read(`${base}?fresh=true`)
    out.before = { status: listed.status, trees: listed.body?.worktrees?.length }
    marker = path.join(tree.registeredDirectory ?? tree.directory, ".git")
    saved = await readFile(marker)
    await rm(marker)
    const probe = async label => {
      for (const query of ["?fresh=true", "?fresh=false"]) {
        const r = await read(`${base}${query}`)
        out[`${label}${query}`] = { status: r.status, error: r.body?.error ?? null,
          slugs: r.body?.worktrees?.map(t => t.slug === "root" ? "root" : "linked").sort() ?? null }
      }
    }
    await probe("gitGone")
    await writeFile(marker, saved)
    // The other half of a removal or prune: `.git` still points at an
    // administrative directory that no longer exists.
    admin = /^gitdir: (.+)$/m.exec(saved.toString())[1].trim()
    await rename(admin, `${admin}.moved`)
    await probe("adminGone")
  } finally {
    if (admin) await rename(`${admin}.moved`, admin).catch(() => {})
    if (saved) await writeFile(marker, saved).catch(() => {})
    if (tree) out.cleanup = (await read(`${base}/${tree.slug}`, { method: "DELETE" })).status
    await call(`/api/workspaces/${opened.body.id}`, { method: "DELETE" }).catch(() => {})
  }
  return out
}
