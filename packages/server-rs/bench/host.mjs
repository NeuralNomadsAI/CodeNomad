// Mode `host`: what the UI calls on its local host with `--unrestricted-root` (HOST_ROUTES.md): the
// `config.yaml` owners it reads at start-up and the feed in `/api/meta`, `state.yaml`'s UI owner, the
// folder browser over the real home and drives, folder creation and a workspace outside the root.
// Paths, identities and times are scrubbed.
import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const send = (body, method = "PATCH", type = "application/json") =>
  ({ method, headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) })

export async function run({ call, fixture, folder, root }) {
  const home = fixture.root
  const scrub = value => {
    if (typeof value === "string") {
      let text = value
      for (const [from, to] of [[root, "<root>"], [home, "<home>"], [folder, "<project>"]])
        for (const variant of [from, from.replaceAll("\\", "/")]) text = text.split(variant).join(to)
      return /^\d+:\d+$/.test(text) ? "<dev:ino>" : text
    }
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !["modifiedAt", "serverId", "id", "createdAt", "updatedAt", "binaryId", "binaryLabel", "binaryVersion", "proxyPath"].includes(key))
      .map(([key, item]) => [key, scrub(item)]))
    return value
  }
  const read = async (route, init = {}) => {
    const response = await call(route, { signal: AbortSignal.timeout(30000), ...init })
    const text = await response.text()
    let body = text
    try { body = text ? JSON.parse(text) : null } catch {}
    return { status: response.status, body: scrub(body) }
  }
  const listing = async route => {
    const result = await read(route)
    result.body?.entries?.sort((a, b) => a.name.localeCompare(b.name))
    return result
  }
  const out = {}

  // config.yaml as both servers were started on it, then edited outside the server.
  out.configServer = await read("/api/storage/config/server")
  out.configUi = await read("/api/storage/config/ui")
  const meta = (await read("/api/meta")).body
  out.meta = Object.fromEntries(["apiContract", "eventsUrl", "listeningMode", "localRequest", "updateFeed", "workspaceRoot"].map(key => [key, meta[key]]))
  const config = path.join(home, existsSync(path.join(home, "ts.yaml")) ? "ts.yaml" : "rust.yaml")
  await appendFile(config, "extra:\n  kept: true\n")
  await writeFile(config, (await readFile(config, "utf8"))
    .replace(/^server:\n/m, "server:\n  logLevel: \" warn \"\n  updateFeed: preview\n  speech:\n    apiKey: secret\n    stt:\n      apiKey: \"\"\n"))
  // The reference re-reads its cached document on the authoritative UI owner read, as the UI does first.
  out.configUiEdited = await read("/api/storage/config/ui")
  out.configServerEdited = await read("/api/storage/config/server")

  // state.yaml's UI owner: recents and models.
  const recent = [{ path: path.join(root, folder), projectName: "Project", lastAccessed: 1767225600000 }]
  out.state = await read("/api/storage/state/ui")
  out.statePatch = await read("/api/storage/state/ui", send({ recentFolders: recent, models: { build: "fixture/fixture" }, nested: { keep: 1, drop: null } }))
  out.stateMerge = await read("/api/storage/state/ui", send({ models: null, nested: { other: 2 } }))
  out.stateArray = await read("/api/storage/state/ui", send([1]))
  out.stateText = await read("/api/storage/state/ui", send("plain", "PATCH", "text/plain"))
  out.stateBadJson = await read("/api/storage/state/ui", send("{"))
  out.stateEmpty = await read("/api/storage/state/ui", { method: "PATCH" })
  out.stateAfter = await read("/api/storage/state/ui")

  // Folder browser over the whole filesystem.
  const outside = path.join(home, "bench-home")
  await mkdir(path.join(outside, "inner"), { recursive: true })
  await writeFile(path.join(outside, "note.txt"), "Outside the root.\n")
  out.browseDefault = await listing("/api/filesystem")
  out.browseFolders = await listing(`/api/filesystem?includeFiles=&path=${encodeURIComponent(root)}`)
  out.browseAbsolute = await listing(`/api/filesystem?path=${encodeURIComponent(outside)}`)
  out.browseRelative = await listing("/api/filesystem?path=bench-home")
  out.browseDots = await listing(`/api/filesystem?path=${encodeURIComponent(path.join(outside, "inner", "..", "."))}`)
  out.browseMissing = await read(`/api/filesystem?path=${encodeURIComponent(path.join(outside, "missing"))}`)
  if (process.platform === "win32") {
    out.browseDrives = await listing("/api/filesystem?path=__drives__")
    out.browseDriveRoot = (await read(`/api/filesystem?path=${encodeURIComponent(path.parse(home).root)}`)).body.metadata
  }
  const create = body => read("/api/filesystem/folders", send(body, "POST"))
  out.folderCreated = await create({ parentPath: outside, name: "  Created  " })
  out.folderExists = await create({ parentPath: outside, name: "Created" })
  out.folderSeparator = await create({ parentPath: outside, name: "a/b" })
  out.folderEmpty = await create({ parentPath: outside, name: " " })
  out.folderTilde = await create({ parentPath: outside, name: "~x" })
  out.folderMissingParent = await create({ parentPath: path.join(outside, "missing"), name: "x" })
  out.folderNotDirectory = await create({ parentPath: path.join(outside, "note.txt"), name: "x" })
  out.folderNoName = (await create({ parentPath: outside })).status
  if (process.platform === "win32") out.folderDrives = await create({ parentPath: "__drives__", name: "x" })

  // A workspace outside the root, then its files.
  const external = await read("/api/workspaces", send({ path: path.join(outside, "inner") }, "POST"))
  out.externalWorkspace = { status: external.status, path: external.body?.path, ready: external.body?.status }
  const opened = await call("/api/workspaces", send({ path: path.join(outside, "inner") }, "POST"))
  const w = await opened.json()
  out.externalFiles = await read(`/api/workspaces/${w.id}/files?path=.&directory=${encodeURIComponent(w.path)}`)
  for (const id of [w.id, (await (await call("/api/workspaces")).json()).map(item => item.id)].flat()) await call(`/api/workspaces/${id}`, { method: "DELETE" })
  return out
}
