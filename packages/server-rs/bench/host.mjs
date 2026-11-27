// Mode `host`: what the UI calls on its local host with `--unrestricted-root` (HOST_ROUTES.md): the
// `config.yaml` owners it reads at start-up and the feed in `/api/meta`, `state.yaml`'s UI owner, the
// folder browser over the real home and drives, folder creation and a workspace outside the root.
// Paths, identities and times are scrubbed.
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const send = (body, method = "PATCH", type = "application/json") =>
  ({ method, headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) })

/** Rust serves no restart, reload or web preview: those flags differ by design (HOST_ROUTES.md). */
export const comparable = ({ updateActions, remoteControlPreviews, ...rest }) => rest

export async function run({ call, exe, fixture, folder, root }) {
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
      .filter(([key, item]) => key === "id" && typeof item === "string" && item.startsWith("opencode-global-config")
        || !["modifiedAt", "serverId", "id", "createdAt", "updatedAt", "binaryId", "binaryLabel", "binaryVersion", "proxyPath"].includes(key))
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

  // Owner merge patches: normalization, speech key pairing, refusals, Missions conditions.
  const owner = (name, body, query = "") => read(`/api/storage/config/${name}${query}`, typeof body === "string" ? send(body, "PATCH", "text/plain") : send(body))
  const statusOnly = async pending => { const { status, body } = await pending; return { status, error: typeof body?.error === "string" } }
  out.serverPatch = await owner("server", { logLevel: "error", updateFeed: "nightly", opencodeBinary: "opencode", extra: { a: 1, b: null } })
  out.speechRebased = await owner("server", { speech: { baseUrl: "http://other.invalid", stt: { baseUrl: "http://stt.invalid" }, tts: { baseUrl: "" } } })
  out.speechKept = await owner("server", { speech: { baseUrl: "http://third.invalid", apiKey: "k2" } })
  out.hostOnlyLocal = await owner("server", { sidecarsOverDirectHttps: true })
  out.ownerArray = await owner("ui", [1])
  out.ownerText = await owner("ui", "plain")
  out.ownerEmpty = await read("/api/storage/config/ui", { method: "PATCH" })
  out.uiPatch = await owner("ui", { settings: { theme: "dark", nested: { keep: 1, drop: null } } })
  const condition = (value, expected) => ({ patch: { settings: { missionModels: value } }, expected })
  out.conditionAbsent = await owner("ui", condition({ a: 1 }, [{ key: "missionModels", present: false }]), "?conditional=missions-v1")
  out.conditionStale = await owner("ui", condition(2, [{ key: "missionModels", present: false }]), "?conditional=missions-v1")
  out.conditionValue = await owner("ui", condition(3, [{ key: "missionModels", present: true, value: { a: 1 } }]), "?conditional=missions-v1")
  out.conditionInvalid = await statusOnly(owner("ui", condition(4, [{ key: "missionDeleteSessions", present: false }]), "?conditional=missions-v1"))
  out.conditionOwner = await statusOnly(owner("server", condition(4, [{ key: "missionModels", present: false }]), "?conditional=missions-v1"))
  out.conditionMode = await owner("ui", {}, "?conditional=other")
  out.configUiPatched = await read("/api/storage/config/ui")
  out.configServerPatched = await read("/api/storage/config/server")

  // OpenCode's global config files, through the editor's inventory only.
  out.configFiles = await read("/api/config-files")
  out.configFileMissing = await read("/api/config-files/opencode-global-config/content")
  out.configFileSaved = await read("/api/config-files/opencode-global-config/content", send({ contents: "{\n  // edited\n}\n", extra: 1 }, "PUT"))
  out.configFileRead = await read("/api/config-files/opencode-global-config/content")
  out.configFileDisk = await readFile(path.join(home, ".config", "opencode", "opencode.json"), "utf8")
  out.configFileInvalid = await read("/api/config-files/opencode-global-config/content", send({ contents: 1 }, "PUT"))
  out.configFileJsoncSaved = await read("/api/config-files/opencode-global-config-jsonc/content", send({ contents: "// JSONC\n{}\n" }, "PUT"))
  out.configFileJsoncRead = await read("/api/config-files/opencode-global-config-jsonc/content")
  out.configFileUnknown = await read("/api/config-files/other/content")
  out.configFileForeign = await read("/api/config-files/other/content", send({ contents: "x" }, "PUT"))

  // The selected OpenCode executable, its update status and Remote Control.
  assert(typeof exe === "string" && path.isAbsolute(exe), "Expected canonical validated OpenCode executable")
  const binary = exe
  out.binaryValid = await read("/api/storage/binaries/validate", send({ path: binary }, "POST"))
  out.binaryMissing = await read("/api/storage/binaries/validate", send({ path: path.join(home, "missing", "opencode.exe") }, "POST"))
  out.binaryDefault = await read("/api/storage/binaries/validate", send({ path: "opencode2" }, "POST"))
  out.binaryInvalid = await statusOnly(read("/api/storage/binaries/validate", send({}, "POST")))
  await owner("server", { opencodeBinary: binary })
  const updateResponse = await read("/api/opencode/update?recheck=1")
  assert.equal(updateResponse.status, 200)
  const update = updateResponse.body
  assert.equal(update.binaryPath, binary)
  out.updateActions = ["canRestart", "canReload"].map(key => [key, update[key]])
  for (const key of ["canRestart", "canReload"]) delete update[key]
  out.update = update
  const remoteResponse = await read("/api/remote-control/status")
  assert.equal(remoteResponse.status, 200)
  const remote = remoteResponse.body
  out.remoteControlPreviews = remote.previews
  delete remote.previews
  out.remoteControl = remote

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
  assert.equal(out.browseDefault.body?.metadata?.homePath, "<home>", "Refusing to navigate a non-fixture home")
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
  // The conversation list and pending requests as the UI reads them on opening: a Git project, a
  // folder without Git in the root and outside it, then right after a worktree is created.
  const count = result => ({ status: result.status, count: Array.isArray(result.body?.data ?? result.body) ? (result.body.data ?? result.body).length : null })
  const lists = async directory => {
    const opened = await call("/api/workspaces", send({ path: directory }, "POST"))
    const ws = await opened.json()
    const at = ws.location?.directory ?? ws.path
    const instance = `${ws.proxyPath}/api`
    const seen = { open: opened.status }
    seen.session = (await read(`${instance}/session`, send({ title: "Host list" }, "POST"))).status
    const projects = await call(`${instance}/project`).then(r => r.json().then(body => ({ status: r.status, body })))
    seen.projects = { status: projects.status, count: Array.isArray(projects.body) ? projects.body.length : null }
    const query = data => new URLSearchParams({ limit: "50", order: "desc", ...data })
    seen.byDirectory = count(await read(`${instance}/session?${query({ directory: at })}`))
    seen.byProject = []
    for (const project of [...(Array.isArray(projects.body) ? projects.body : []).map(p => p.id), "global"])
      seen.byProject.push(count(await read(`${instance}/session?${query({ project })}`)))
    const pending = await read(`/api/workspaces/${ws.id}/pending-requests?${new URLSearchParams({ directories: at })}`)
    seen.pending = { status: pending.status, supported: pending.body?.supported, directories: pending.body?.directories?.map(d => d.status) }
    return { ws, at, seen }
  }
  out.listsGit = (await lists(path.join(root, folder))).seen
  out.listsPlain = (await lists(path.join(root, "No Repository"))).seen
  out.listsOutside = (await lists(path.join(outside, "inner"))).seen
  const { ws: project, at } = await lists(path.join(root, folder))
  const tree = await call(`/api/workspaces/${project.id}/worktrees`, send({ slug: "host-list", fromSlug: "root" }, "POST"))
  const created = await tree.json()
  const both = new URLSearchParams([["directories", at], ["directories", created.serviceDirectory ?? created.directory ?? ""]])
  const fresh = await read(`/api/workspaces/${project.id}/pending-requests?${both}`)
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body))
  assert.deepEqual(fresh.body?.directories?.map(d => d.status), ["ok", "ok"])
  out.pendingAfterWorktree = { created: tree.status, status: fresh.status, directories: fresh.body?.directories?.map(d => d.status), error: fresh.body?.error }
  const pending = async (directories, optional = []) => {
    const query = new URLSearchParams([...directories.map(d => ["directories", d]), ...optional.map(d => ["optionalDirectories", d])])
    const r = await read(`/api/workspaces/${project.id}/pending-requests?${query}`)
    return { status: r.status, error: r.body?.error, directories: r.body?.directories?.map(d => [d.directory, d.status, d.reason]) }
  }
  const gone = path.join(at, ".codenomad", "worktrees", "gone"), absent = path.join(outside, "gone")
  out.pendingCases = {
    subfolder: await pending([path.join(at, "nested")]),
    missingOptional: await pending([at, gone], [gone]),
    missingMandatory: await pending([at, gone]),
    outsideOptional: await pending([at, outside], [outside]),
    absentOutsideOptional: await pending([at, absent], [absent]),
    foreignOnly: await pending([outside]),
    excludedOnly: await pending([absent], [absent]),
    invalidOptional: await pending([at], [outside]),
    duplicates: await pending([at, at]),
  }
  await call(`/api/workspaces/${project.id}/worktrees/${created.slug}`, { method: "DELETE" })
  out.pendingAfterDeletion = await pending([at, created.serviceDirectory ?? created.directory], [created.serviceDirectory ?? created.directory])
  for (const id of [w.id, (await (await call("/api/workspaces")).json()).map(item => item.id)].flat()) await call(`/api/workspaces/${id}`, { method: "DELETE" })
  return out
}
