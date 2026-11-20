// Mode `links`: project files follow links: internal file and folder links, outward links and junction (read,
// list, write, preview, untracked diff, status, search), dangling target, loop and lexical refusals.
import assert from "node:assert/strict"
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"

export async function run({ call, fixture, folder }) {
  const opened = await call("/api/workspaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: folder }) })
  assert.equal(opened.status, 201)
  const w = await opened.json()
  const dir = w.path
  assert(path.resolve(dir).startsWith(path.resolve(fixture.root)), "Bench project inside the private fixture")
  const outside = path.join(fixture.root, "links-outside")
  const base = `/api/workspaces/${w.id}`
  const hide = value => typeof value === "string" ? value.replaceAll(dir, "<project>").replaceAll(outside, "<outside>").replaceAll("\\", "/")
    : Array.isArray(value) ? value.map(hide) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hide(v)])) : value
  const request = async (route, init) => {
    const r = await call(base + route, { signal: AbortSignal.timeout(30000), ...init })
    const text = await r.text()
    let body = text; try { body = JSON.parse(text) } catch {}
    return { status: r.status, body }
  }
  const q = data => new URLSearchParams(data)
  const list = async p => {
    const r = await request(`/files?${q({ path: p })}`)
    return { status: r.status, entries: r.status === 200 ? r.body.map(({ name, path, type, size }) => ({ name, path, type, size })).sort((a, b) => a.name.localeCompare(b.name)) : undefined }
  }
  const content = async p => {
    const r = await request(`/files/content?${q({ path: p })}`)
    return { status: r.status, contents: r.status === 200 ? r.body.contents : undefined }
  }
  const preview = async p => {
    const r = await request(`/files/preview?${q({ path: p })}`)
    return { status: r.status, contents: r.status === 200 ? Buffer.from(r.body.contents, "base64").toString() : undefined }
  }
  const put = async (p, contents) => (await request(`/files/content?${q({ path: p })}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ contents }) })).status
  const diff = async p => {
    const r = await request(`/worktrees/root/git-diff?${q({ path: p, scope: "unstaged" })}`)
    return { status: r.status, body: r.status === 200 ? hide(r.body) : undefined }
  }
  const disk = file => readFile(file, "utf8").catch(e => `<${e.code}>`)

  const links = path.join(dir, "links")
  const made = []
  const out = {}
  try {
    await rm(links, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await mkdir(path.join(links, "real-dir"), { recursive: true })
    await mkdir(path.join(outside, "sub"), { recursive: true })
    await writeFile(path.join(links, "real.txt"), "inside\n")
    await writeFile(path.join(links, "real-dir", "inner.txt"), "inner\n")
    await writeFile(path.join(outside, "out.txt"), "outside\n")
    await writeFile(path.join(outside, "write-target.txt"), "before\n")
    await writeFile(path.join(outside, "sub", "deep.txt"), "deep\n")
    const link = async (target, name, type) => { await symlink(target, path.join(links, name), type); made.push(name) }
    await link("real.txt", "file-link.txt", "file")
    await link("real-dir", "dir-link", "dir")
    await link(path.join(outside, "out.txt"), "out-file.txt", "file")
    await link(path.join(outside, "write-target.txt"), "out-write.txt", "file")
    await link(path.join(outside, "created.txt"), "out-dangling.txt", "file")
    await link(outside, "out-dir", "dir")
    await link(outside, "out-junction", "junction")
    await link(path.join(links, "missing-target.txt"), "dangling.txt", "file")
    await link("loop-b", "loop-a", "file")
    await link("loop-a", "loop-b", "file")

    out.list = await list("links")
    out.internalFile = await content("links/file-link.txt")
    out.internalDirectory = { list: await list("links/dir-link"), read: await content("links/dir-link/inner.txt") }
    out.outwardFile = { read: await content("links/out-file.txt"), preview: await preview("links/out-file.txt") }
    out.outwardDirectory = { list: await list("links/out-dir"), read: await content("links/out-dir/out.txt"), deep: await content("links/out-dir/sub/deep.txt"), preview: await preview("links/out-dir/sub/deep.txt") }
    out.outwardJunction = { list: await list("links/out-junction"), read: await content("links/out-junction/out.txt"), deep: await content("links/out-junction/sub/deep.txt"), preview: await preview("links/out-junction/out.txt") }
    out.writes = {
      throughFileLink: await put("links/out-write.txt", "written through link\n"),
      throughDirectoryLink: await put("links/out-dir/new.txt", "new via dir link\n"),
      throughJunction: await put("links/out-junction/sub/new.txt", "new via junction\n"),
      danglingLink: await put("links/out-dangling.txt", "created through dangling link\n"),
      internalLink: await put("links/file-link.txt", "inside rewritten\n"),
    }
    out.disk = {
      writeTarget: await disk(path.join(outside, "write-target.txt")),
      dirLinkNew: await disk(path.join(outside, "new.txt")),
      junctionNew: await disk(path.join(outside, "sub", "new.txt")),
      danglingCreated: await disk(path.join(outside, "created.txt")),
      internal: await disk(path.join(links, "real.txt")),
      linkStillLink: (await lstat(path.join(links, "out-write.txt"))).isSymbolicLink(),
    }
    out.dangling = { read: (await content("links/dangling.txt")).status, preview: (await preview("links/dangling.txt")).status }
    out.loop = { read: (await content("links/loop-a")).status, list: (await list("links/loop-a")).status, preview: (await preview("links/loop-a")).status, write: await put("links/loop-a", "x") }
    out.lexical = {
      parent: (await content("../outside.txt")).status,
      parentList: (await list("..")).status,
      parentThroughLink: (await content("links/out-dir/../../../escape.txt")).status,
      insideDotDot: await content("links/../links/real.txt"),
      absoluteOutside: (await content(path.join(outside, "out.txt"))).status,
      absoluteInside: await content(path.join(links, "real.txt")),
      foreignDirectory: (await request(`/files?${q({ directory: outside })}`)).status,
    }
    // Untracked: Git sees the links themselves; the diff reads through them.
    const status = await request("/worktrees/root/git-status")
    out.gitStatus = { status: status.status, links: status.status === 200 ? hide(status.body.filter(e => e.path.startsWith("links/")).map(({ path, unstagedStatus, stagedStatus, unstagedAdditions, unstagedDeletions }) => ({ path, unstagedStatus, stagedStatus, unstagedAdditions, unstagedDeletions })).sort((a, b) => a.path.localeCompare(b.path))) : status.body }
    out.gitDiff = {
      outwardFile: await diff("links/out-file.txt"),
      internalFile: await diff("links/file-link.txt"),
      dangling: await diff("links/dangling.txt"),
      loop: await diff("links/loop-a"),
    }
    // Search follows the same links (fs.stat), lists a loop's directory once and skips dangling and looping links.
    const search = async (query, type = "all") => {
      const r = await request(`/files/search?${q({ q: query, type, refresh: "true", limit: "200" })}`)
      return { status: r.status, entries: r.status === 200 ? r.body.filter(e => e.path.startsWith("links/")).map(({ name, path, type, size, absolutePath }) => ({ name, path, type, size, absolutePath: hide(absolutePath) })) : r.body }
    }
    await symlink(links, path.join(links, "real-dir", "back-to-links"), "junction"); made.push("real-dir/back-to-links")
    out.search = {
      deep: await search("deep"), inner: await search("inner"), out: await search("links out", "file"), directories: await search("links", "directory"),
      dangling: await search("dangling"), loop: await search("loop"), cycle: await search("back-to-links"), written: await search("new", "file"),
    }
    return out
  } finally {
    await rm(links, { recursive: true, force: true }).catch(() => {})
    await rm(outside, { recursive: true, force: true }).catch(() => {})
    await call(base, { method: "DELETE" }).catch(() => {})
  }
}
