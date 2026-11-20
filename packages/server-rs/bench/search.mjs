// Mode `search`: `GET …/files/search` queries (case, spaces, Unicode, separators), `limit`, `type`, `refresh`,
// zod refusals, `directory` spellings, cache scope and 30 s TTL, and busy refusals on a large tree.
import assert from "node:assert/strict"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/

export async function run({ call, fixture, folder }) {
  const post = body => ({ method: "POST", signal: AbortSignal.timeout(60000), headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  const opened = await call("/api/workspaces", post({ path: folder }))
  assert.equal(opened.status, 201)
  const w = await opened.json()
  const dir = w.path
  assert(path.resolve(dir).startsWith(path.resolve(fixture.root)), "Bench project inside the private fixture")
  const outside = path.join(fixture.root, "search-outside")
  const base = `/api/workspaces/${w.id}`
  let tree
  const hide = value => typeof value === "string"
    ? [[tree?.directory, "<tree>"], [dir, "<project>"], [outside, "<outside>"], [fixture.root, "<root>"]]
      .reduce((s, [from, to]) => from ? s.replaceAll(from, to) : s, value).replaceAll("\\", "/")
    : Array.isArray(value) ? value.map(hide) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, hide(v)])) : value
  const raw = async (route, timeout = 120000) => {
    const r = await call(route, { signal: AbortSignal.timeout(timeout) })
    const text = await r.text()
    let body = text; try { body = JSON.parse(text) } catch {}
    return { status: r.status, retryAfter: r.headers.get("retry-after"), type: r.headers.get("content-type"), body }
  }
  const shown = r => r.status === 200
    ? { status: 200, body: r.body.map(({ modifiedAt, ...entry }) => ({ ...hide(entry), modifiedAt: ISO.test(modifiedAt) })) }
    : { status: r.status, body: hide(r.body), ...(r.status === 503 ? { retryAfter: r.retryAfter, type: r.type } : {}) }
  const search = async query => shown(await raw(`${base}/files/search?${query}`))
  const q = data => new URLSearchParams(data).toString()
  const names = r => r.status === 200 ? r.body.map(e => e.path) : r
  const put = async (rel, text = "") => { await mkdir(path.dirname(path.join(dir, rel)), { recursive: true }); await writeFile(path.join(dir, rel), text) }

  const out = {}
  try {
    for (const f of ["srch/alpha/NeedleOne.ts", "srch/alpha/needle-two.md", "srch/beta/Needle_Three.TXT", "srch/beta/deep/deeper/needle.json",
      "srch/gamma.needle/x.txt", "srch/Ünïcödé/ńeedle.txt", "srch/ΣΟΦΟΣ/σοφος-needle.md", "srch/space dir/needle file.txt", "srch/node_modules/needle-hidden.js",
      "srch/Dist/needle-dist.js", "srch/.Git/needle-git", "srch/coverage/needle-cov", "srch/build", "srch/x/y/z/w/needle-deepest.rs", "srch/emoji/😀needle.ts"]) await put(f, f)
    for (let i = 0; i < 250; i++) await put(`srch/many/item-${String(i).padStart(3, "0")}.txt`, "x".repeat(i))

    out.queries = {}
    for (const query of ["needle", "NEEDLE", " needle ", "srch needle", "needle srch", "n/e/d", "ńeedle", "needle.json", "deeper needle", "σοφος", "ΣΟΦΟΣ",
      "😀", "space dir", "needle file", "zzzzqx", "srch/many", "farzher", "NeedleOne.ts", "alpha-needle", "a_b", "build", ".git", "node_modules", "dist"])
      out.queries[query] = await search(q({ q: query }))
    out.types = {}
    for (const type of ["all", "file", "directory"]) out.types[type] = await search(q({ q: "needle", type }))
    out.limits = {}
    for (const limit of ["1", "2", "100", "199", "200", "201", "0", "abc", "-1", "1.5", "", "1e2", "0x10", " 3 ", "Infinity", "9007199254740993"])
      out.limits[JSON.stringify(limit)] = await search(q({ q: "item", limit }))
    out.limits.default = await search(q({ q: "item" }))
    out.refusals = {}
    for (const query of ["", "q=", "q=%20%20", "q=a&q=b", "q=a&type=bogus", "q=a&type=File", "q=a&refresh=1&refresh=2", "directory=&q=a",
      "directory=%20&q=a", "q=%zz", "q=item&limit=0&type=x&directory=", "q=needle&refresh=TRUE", "q=needle&unknown=1"])
      out.refusals[query] = await search(query)

    // Root, foreign, relative, network and differently spelled directories.
    out.directories = {}
    for (const [label, directory] of [["root", dir], ["rootTrailing", dir + path.sep], ["rootUpper", dir.toUpperCase()], ["rootSpaced", ` ${dir} `],
      ["foreign", outside], ["parent", path.dirname(dir)], ["relative", "srch"], ["network", "\\\\127.0.0.1\\c$\\x"], ["device", "\\\\.\\pipe\\x"], ["inside", path.join(dir, "srch")]])
      out.directories[label] = await search(q({ q: "needle-two", directory }))
    const created = await call(`${base}/worktrees`, post({ slug: "search-tree", fromSlug: "root" }))
    assert.equal(created.status, 201, await created.clone().text())
    tree = await created.json()
    out.directories.linked = await search(q({ q: "txt", directory: tree.directory, limit: "200" }))
    out.directories.linkedService = await search(q({ q: "txt", directory: tree.serviceDirectory, limit: "200" }))
    out.unknownWorkspace = {
      valid: shown(await raw(`/api/workspaces/00000000-0000-4000-8000-000000000000/files/search?q=a`)),
      invalid: shown(await raw(`/api/workspaces/00000000-0000-4000-8000-000000000000/files/search?q=`)),
    }

    // Cache: one scope per root, `refresh=true`, reservation of the same folder, TTL.
    const cache = []
    const step = async label => cache.push([label, names(await search(q({ q: "cachefx", type: "file" })))])
    await put("srch/cache/cachefx-1.txt"); await step("first scan")
    await put("srch/cache/cachefx-2.txt"); await step("cached")
    cache.push(["refresh", names(await search(q({ q: "cachefx", type: "file", refresh: "true" })))])
    await put("srch/cache/cachefx-3.txt"); await step("cached after refresh")
    cache.push(["same query, other type", names(await search(q({ q: "cachefx", type: "all" })))])
    await put("srch/cache/cachefx-4.txt"); await step("type scope replaced")
    await search(q({ q: "otherscope" }))
    await put("srch/cache/cachefx-5.txt"); await step("query scope replaced")
    await put("srch/cache/cachefx-6.txt")
    const again = await call("/api/workspaces", post({ path: folder }))
    const second = again.status === 201 ? await again.json() : undefined
    cache.push(["reopened", again.status, second?.id === w.id ? "same" : second ? "new" : null])
    await step("after reservation")
    if (second && second.id !== w.id) await call(`/api/workspaces/${second.id}`, { method: "DELETE" })
    await step("cached before ttl")
    await put("srch/cache/cachefx-7.txt"); await step("cached within ttl")
    await new Promise(resolve => setTimeout(resolve, 31000))
    await step("after ttl")
    out.cache = cache

    // Busy: two scans of a large tree, a duplicate of the first and a third scope.
    await Promise.all(Array.from({ length: 40 }, async (_, d) => {
      await mkdir(path.join(dir, "srch-big", `d${d}`), { recursive: true })
      for (let i = 0; i < 800; i += 100) await Promise.all(Array.from({ length: 100 }, (_, k) => writeFile(path.join(dir, "srch-big", `d${d}`, `f${i + k}.txt`), "")))
    }))
    const busy = []
    for (let attempt = 0; attempt < 3; attempt++) {
      const at = s => `${base}/files/search?${q({ q: `bigzz${s}${attempt}`, refresh: "true" })}`
      const first = raw(at("a")), other = raw(at("b"))
      await new Promise(resolve => setTimeout(resolve, 150))
      const duplicate = raw(at("a")), third = raw(at("c"))
      const settled = (await Promise.all([first, other, duplicate, third])).map(shown)
      busy.push({ first: settled[0], other: settled[1], duplicate: settled[2], third: settled[3], afterwards: await search(q({ q: `bigzzc${attempt}`, refresh: "true" })) })
    }
    out.busy = busy
    return out
  } finally {
    if (tree) await call(`${base}/worktrees/${tree.slug}`, { method: "DELETE", signal: AbortSignal.timeout(90000) }).catch(() => {})
    await rm(path.join(dir, "srch"), { recursive: true, force: true }).catch(() => {})
    await rm(path.join(dir, "srch-big"), { recursive: true, force: true }).catch(() => {})
    await call(base, { method: "DELETE" }).catch(() => {})
  }
}
