import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import Fastify from "fastify"
import { PanelExtensionStore } from "../../panel-extensions/store"
import { readPanelExtensionArchive } from "../../panel-extensions/archive"
import { fixtureArchive } from "../../panel-extensions/archive-fixture"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerPanelExtensionApi4Routes } from "./panel-extension-api4"
import { brokerIdentities } from "./rpc-broker-test-fixture"

const target = { messageID: "msg_a", part: 1, index: 0, digest: "a".repeat(64) }
const marked = { "codenomad.companion": "images" }
const model = (id: string, input: string[]) => ({ providerID: "p", id, capabilities: { tools: true, input, output: ["text"] } })

async function fixture(t: TestContext, permissions: string[], options: {
  rpc?: (method: string, input: any, signal: AbortSignal) => unknown
  generation?: { effective: unknown; models: unknown[] | null } | null
  session?: Record<string, unknown>
  /** Runs inside every `session.get`, before its answer (`reads` counts calls per session). */
  onSessionGet?: (sessionID: string, reads: number, signal?: AbortSignal) => unknown
  onSettingsRead?: (signal?: AbortSignal) => unknown
  onLocationGet?: (signal?: AbortSignal) => unknown
  /** May return another project ID for this read (a remote that changed). */
  onProjectIdentity?: (directory: string) => unknown
  routeBudgetMs?: number
  fence?: WorktreeDeletionFence
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-route-"))
  const notesChanged: string[] = []
  const store = new PanelExtensionStore(directory, () => {}, id => notesChanged.push(id))
  const pkg = await readPanelExtensionArchive(fixtureArchive("<p>x</p>", { apiVersion: 4, permissions }))
  await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
  const calls: Array<{ method: string; input: any; directory: string }> = [], excluded: string[] = [], checked: string[] = []
  const sessions: Record<string, any> = {
    ses_images: { id: "ses_images", location: { directory: "/repo" }, metadata: marked, agent: "design", time: { updated: 42 } },
    ses_work: { id: "ses_work", title: "Work", location: { directory: "/repo" }, agent: "build", ...options.session },
    ses_other: { id: "ses_other", title: "Other", location: { directory: "/repo" } },
    ses_foreign: { id: "ses_foreign", location: { directory: "/elsewhere" } },
  }
  const connection = { current: true }, owned = new Set(["/repo"]), reads: Record<string, number> = {}
  const client: any = {
    session: { get: async ({ sessionID }: any, request?: { signal?: AbortSignal }) => {
      reads[sessionID] = (reads[sessionID] ?? 0) + 1
      await options.onSessionGet?.(sessionID, reads[sessionID]!, request?.signal)
      return sessions[sessionID] ?? Promise.reject(Object.assign(new Error("Session not found"), { _tag: "SessionNotFoundError" }))
    } },
    location: { get: async ({ location }: any, request?: { signal?: AbortSignal }) => {
      await options.onLocationGet?.(request?.signal)
      return { directory: location.directory, project: { id: "p" } }
    } },
    agent: { list: async () => ({ data: [{ id: "build", model: { providerID: "p", id: "agent-model" } },
      { id: "design", system: "codenomad-design-content: 1\nRules" }] }) },
    model: { list: async () => ({ data: [model("text-only", ["text"]), model("agent-model", ["text", "image"]), model("vision", ["text", "image/png"])] }),
      default: async () => ({ data: model("text-only", ["text"]) }) },
    rpc: { call: async ({ method, input, location }: any, { signal }: { signal: AbortSignal }) => {
      calls.push({ method, input, directory: location.directory })
      return { output: await (options.rpc?.(method, input, signal) ?? defaults(method)) }
    } },
  }
  const defaults = (method: string) => ({
    images: { status: "page", entries: [{ kind: "image", target, series: "s".repeat(22), time: 1, label: "icon", mime: "image/png", origin: "unverifiable" },
      { kind: "image", target: { ...target, index: 1 }, series: "s".repeat(22), time: 1, label: null, mime: "image/png", origin: "unverifiable" }], cursor: null },
    imageRead: { status: "asset", mime: "image/png", uri: "data:image/png;base64,AA==" },
    imageReference: { status: "path", path: ".codenomad/design/icon/icon-a.png" },
    imagesConversation: { status: "found", sessionID: "ses_images", created: false },
  } as Record<string, unknown>)[method]
  const app = Fastify(), identities = brokerIdentities()
  registerPanelExtensionApi4Routes(app, { store, worktreeDeletionFence: options.fence ?? new WorktreeDeletionFence(),
    excludeDesignFolder: async value => { excluded.push(value.directory); return "excluded" },
    checkDesignFolderExclusion: async value => { checked.push(value.directory); return excluded.includes(value.directory) ? "excluded" : "missing" },
    ...(options.routeBudgetMs ? { routeBudgetMs: options.routeBudgetMs } : {}),
    projectIdentity: async ({ directory }) => ({ id: (await options.onProjectIdentity?.(directory) as string | undefined) ?? (["/repo", "/clone", "/linked"].includes(directory) ? "a" : "b").repeat(64), source: "local" }),
    imageSettings: { read: async (_workspace: string, _location: unknown, signal?: AbortSignal) => {
      await options.onSettingsRead?.(signal)
      return { location: { directory: "/repo" }, mediaStorage: null,
        generation: options.generation === undefined ? { global: true, effective: true, models: [{ ref: "p/img", name: "Img" }] } : options.generation as any }
    } },
    workspaceManager: {
      get: (id: string) => id === "i" ? identities.get() : undefined,
      getServiceLocation: identities.getServiceLocation,
      getSharedServiceConnection: async (id: string) => id === "i" ? { client,
        assertCurrent() { if (!connection.current) throw new Error("Superseded connection") } } as any : undefined,
      ownsLocation: async (id: string, location: { directory: string }) => id === "i" && owned.has(location.directory),
      desktopPluginsReady: async () => {},
      getWorktreeIdentityForPath: async (_id: string, value: string) => value,
      getServiceWslDistro: () => undefined,
      // `j`: another open window, on a clone of the same project.
      getServiceDirectoryForPath: async (id: string, value: string) => id === "i" && owned.has(value) || id === "j" && value === "/clone" ? value : undefined,
      list: () => [{ id: "i" }, { id: "j" }] as any,
      getHostPathForServicePath: async (_id: string, value: string) => value,
    } })
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 }) })
  const post = (method: string, body: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/api/panel-extensions/${pkg.manifest.id}/${method}`,
    payload: { instanceId: "i", digest: pkg.digest, ...body } })
  return { app, store, pkg, calls, excluded, checked, post, file: path.join(directory, "installed.json"), connection, owned, sessions, notesChanged }
}

test("each method requires its own declared permission on the enabled exact package", async t => {
  const { post, store, pkg } = await fixture(t, ["session.context", "panel.preferences"])
  for (const [method, body] of [["images", { sessionID: "ses_images" }], ["imageRead", { sessionID: "ses_images", target }],
    ["imagesStatus", { directory: "/repo" }], ["prefillReferences", { sessionID: "ses_images", targets: [target] }],
    ["conversationStatus", { directory: "/repo" }], ["conversationOpen", { directory: "/repo", title: "Images" }],
    ["conversationNew", { directory: "/repo", title: "Images" }], ["notesGet", { sessionID: "ses_work" }],
    ["notesSet", { sessionID: "ses_work", text: "x", revision: 0 }], ["notesList", {}], ["notesDelete", { target: "ses_work", revision: 1 }],
    ["notesOpen", { target: "ses_work" }]] as const) {
    assert.equal((await post(method, body)).statusCode, 403, method)
  }
  assert.equal((await post("preferencesGet")).statusCode, 200)
  await store.activate(pkg.manifest.id, pkg.digest, false)
  assert.deepEqual((await post("preferencesGet")).json(), { status: "unavailable" })
  assert.equal((await post("preferencesGet", { instanceId: "closed" })).statusCode, 404)
})

test("images: prompts only with session.images.prompts, blocked answers pass through, foreign sessions are refused", async t => {
  for (const prompts of [false, true]) {
    const { post, calls } = await fixture(t, ["session.context", "session.images.read", ...(prompts ? ["session.images.prompts"] : [])])
    const page = await post("images", { sessionID: "ses_images", cursor: "c" })
    assert.equal(page.statusCode, 200)
    assert.deepEqual(calls[0], { method: "images", input: { sessionID: "ses_images", cursor: "c", prompts }, directory: "/repo" })
    assert.equal((await post("images", { sessionID: "ses_foreign" })).statusCode, 403)
    assert.equal((await post("images", { sessionID: "ses_images", directory: "/repo" })).statusCode, 400, "the host chooses the Location")
  }
  const { post } = await fixture(t, ["session.context", "session.images.read"], { rpc: method => method === "imageRead"
    ? { status: "blocked", reason: "not-gallery" } : { status: "blocked", reason: "conflict" } })
  assert.deepEqual((await post("images", { sessionID: "ses_images" })).json(), { status: "blocked", reason: "conflict" })
  assert.deepEqual((await post("imageRead", { sessionID: "ses_images", target })).json(), { status: "blocked", reason: "not-gallery" })
})

test("images.status: S2/S2u/S3/S4 and the effective chat model (session, else agent, else native default), no provider names", async t => {
  const status = async (permissions: string[], body: Record<string, unknown>, options = {}) => (await (await fixture(t, permissions, options)).post("imagesStatus", body)).json()
  const read = ["session.context", "session.images.read"]
  assert.deepEqual(await status(read, { directory: "/repo" }),
    { generation: "available", imageModels: true, designAgent: "present", contentVersion: 1, chatModelSeesImages: null })
  // Agent model (build's), then a session model, then the native default.
  assert.equal((await status(read, { sessionID: "ses_work" })).chatModelSeesImages, true)
  assert.equal((await status(read, { sessionID: "ses_work" }, { session: { model: { providerID: "p", id: "text-only" } } })).chatModelSeesImages, false)
  assert.equal((await status(read, { sessionID: "ses_work" }, { session: { model: { providerID: "p", id: "vision" } } })).chatModelSeesImages, true)
  assert.equal((await status(read, { sessionID: "ses_images" })).chatModelSeesImages, false, "design has no model: native default")
  assert.equal((await status(read, { sessionID: "ses_work" }, { session: { model: { providerID: "p", id: "gone" } } })).chatModelSeesImages, null)
  const disabled = await status(read, { directory: "/repo" }, { generation: { effective: false, models: [] } })
  assert.deepEqual([disabled.generation, disabled.imageModels], ["disabled", false])
  assert.equal((await status(read, { directory: "/repo" }, { generation: null })).generation, "unsupported")
  assert.equal((await (await fixture(t, read)).post("imagesStatus", { directory: "/elsewhere" })).statusCode, 403)
  assert.equal(JSON.stringify(await status(read, { sessionID: "ses_work" })).includes("\"p\""), false)
})

test("prefill references: each target revalidated; a refusal is null, an unavailable plugin fails the request", async t => {
  const answers = [{ status: "path", path: "a.png" }, { status: "refused", reason: "changed" }]
  const { post, calls } = await fixture(t, ["session.context", "composer.prefill"], { rpc: () => answers.shift() })
  const result = await post("prefillReferences", { sessionID: "ses_images", targets: [target, { messageID: "m", part: 2, digest: "b".repeat(64) }] })
  assert.deepEqual(result.json(), { paths: ["a.png", null] })
  assert.deepEqual(calls.map(call => call.method), ["imageReference", "imageReference"])
  assert.equal((await post("prefillReferences", { sessionID: "ses_images", targets: new Array(17).fill(target) })).statusCode, 400)
  const blocked = await fixture(t, ["session.context", "composer.prefill"], { rpc: () => ({ status: "blocked", reason: "unavailable" }) })
  assert.equal((await blocked.post("prefillReferences", { sessionID: "ses_images", targets: [target] })).statusCode, 503)
})

test("conversation status composes lookup, image count, last use, the displayed conversation and a read-only Git check", async t => {
  const { post, calls, excluded, checked } = await fixture(t, ["session.context", "images.conversation"])
  assert.deepEqual((await post("conversationStatus", { directory: "/repo", sessionID: "ses_work" })).json(),
    { lookup: "found", imageCount: 2, lastUsed: 42, displayedIsImages: false, gitExclusion: "missing" })
  assert.equal((await post("conversationStatus", { directory: "/repo", sessionID: "ses_images" })).json().displayedIsImages, true)
  assert.deepEqual([checked, excluded], [["/repo", "/repo"], []], "status checks and never appends")
  assert.deepEqual(calls[1], { method: "images", input: { sessionID: "ses_images" }, directory: "/repo" }, "the count never reads prompts")
  assert.equal((await post("conversationStatus", { directory: "/elsewhere" })).statusCode, 403)
  const opened = await post("conversationOpen", { directory: "/repo", title: "Images", agent: "design", model: { providerID: "p", id: "m" } })
  assert.deepEqual(opened.json(), { status: "found", sessionID: "ses_images", created: false, gitExclusion: "excluded" })
  assert.deepEqual(calls.at(-1), { method: "imagesConversation", directory: "/repo",
    input: { mode: "open", title: "Images", agent: "design", model: { providerID: "p", id: "m" } } })
  assert.deepEqual(excluded, ["/repo"], "open appends")
  assert.equal((await post("conversationStatus", { directory: "/repo" })).json().gitExclusion, "excluded")
  await post("conversationNew", { directory: "/repo", title: "Images" })
  assert.equal(calls.at(-1)?.input.mode, "new")
  assert.deepEqual(excluded, ["/repo", "/repo"], "startNew appends")

  // A gallery beyond one page has no total.
  const paged = await fixture(t, ["session.context", "images.conversation"], { rpc: method => method === "images"
    ? { status: "page", entries: [], cursor: "more" } : method === "imagesConversation" ? { status: "found", sessionID: "ses_images", created: false } : undefined })
  assert.equal((await paged.post("conversationStatus", { directory: "/repo" })).json().imageCount, null)
  const blocked = await fixture(t, ["session.context", "images.conversation"], { rpc: method => method === "images"
    ? { status: "blocked", reason: "limit" } : method === "imagesConversation" ? { status: "found", sessionID: "ses_images", created: false } : undefined })
  assert.equal((await blocked.post("conversationStatus", { directory: "/repo" })).json().imageCount, null)
  for (const status of ["absent", "unknown"]) {
    const other = await fixture(t, ["session.context", "images.conversation"], { rpc: () => ({ status }) })
    assert.deepEqual((await other.post("conversationStatus", { directory: "/repo" })).json(),
      { lookup: status, imageCount: null, lastUsed: null, displayedIsImages: false, gitExclusion: null })
    assert.deepEqual([other.excluded, other.checked], [[], []])
  }
})

test("a caller that leaves cancels the plugin call", async t => {
  let aborted: Promise<void> | undefined
  const { app, pkg } = await fixture(t, ["session.context", "session.images.read"], { rpc: (_method, _input, signal) => {
    aborted = new Promise(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
    return new Promise(() => {})
  } })
  const address = await app.listen({ host: "127.0.0.1", port: 0 })
  const caller = new AbortController()
  const response = fetch(`${address}/api/panel-extensions/${pkg.manifest.id}/images`, { method: "POST", signal: caller.signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ instanceId: "i", digest: pkg.digest, sessionID: "ses_images" }) })
  while (!aborted) await new Promise(resolve => setTimeout(resolve, 5))
  caller.abort()
  await assert.rejects(response)
  await aborted
})

type Fixture = Awaited<ReturnType<typeof fixture>>
const never = () => new Promise<never>(() => {})
const within = <T>(work: Promise<T>, ms: number) => Promise.race([work, new Promise<"hung">(resolve => setTimeout(() => resolve("hung"), ms))])

test("the final reads are fenced: a superseded connection, a session moved or a Location disowned during them never answer 200", async t => {
  // The connection is superseded during imageRead's final session read.
  let f: Fixture = await fixture(t, ["session.context", "session.images.read"], { onSessionGet: (_id, reads) => { if (reads === 2) f.connection.current = false } })
  assert.notEqual((await f.post("imageRead", { sessionID: "ses_images", target })).statusCode, 200, "imageRead, superseded connection")
  // The displayed session moves outside the workspace while the status is read.
  let g: Fixture = await fixture(t, ["session.context", "session.images.read"], { onSettingsRead: () => { g.sessions.ses_work.location = { directory: "/elsewhere" } } })
  assert.notEqual((await g.post("imagesStatus", { sessionID: "ses_work" })).statusCode, 200, "imagesStatus, moved session")
  let h: Fixture = await fixture(t, ["session.context", "session.images.read"], { onSettingsRead: () => { h.owned.delete("/repo") } })
  assert.notEqual((await h.post("imagesStatus", { directory: "/repo" })).statusCode, 200, "imagesStatus, disowned Location")
  let i: Fixture = await fixture(t, ["session.context", "session.images.read"], { onSettingsRead: () => { i.connection.current = false } })
  assert.notEqual((await i.post("imagesStatus", { directory: "/repo" })).statusCode, 200, "imagesStatus, superseded connection")
  // The conversation routes, Location disowned during the plugin call.
  for (const [method, body] of [["conversationStatus", { directory: "/repo" }], ["conversationOpen", { directory: "/repo", title: "Images" }],
    ["conversationNew", { directory: "/repo", title: "Images" }]] as const) {
    let c: Fixture = await fixture(t, ["session.context", "images.conversation"], { rpc: method => {
      if (method === "imagesConversation") c.owned.delete("/repo")
      return undefined
    } })
    assert.notEqual((await c.post(method, body)).statusCode, 200, `${method}, disowned Location`)
    let d: Fixture = await fixture(t, ["session.context", "images.conversation"], { rpc: method => {
      if (method === "imagesConversation") d.connection.current = false
      return undefined
    } })
    assert.notEqual((await d.post(method, body)).statusCode, 200, `${method}, superseded connection`)
  }
  // The found Images conversation moves outside the workspace after the lookup, or during the gallery read.
  for (const at of ["imagesConversation", "images"]) {
    let m: Fixture = await fixture(t, ["session.context", "images.conversation"], { rpc: method => {
      if (method === at) m.sessions.ses_images.location = { directory: "/elsewhere" }
      return undefined
    } })
    const moved = await m.post("conversationStatus", { directory: "/repo" })
    assert.notEqual(moved.statusCode, 200, `conversationStatus, found session moved at ${at}`)
    assert.equal(JSON.stringify(moved.json()).includes("lastUsed"), false, "no timestamp of a foreign session")
  }
  // Unchanged authority still answers.
  const ok = await fixture(t, ["session.context", "session.images.read"])
  assert.equal((await ok.post("imagesStatus", { sessionID: "ses_work" })).statusCode, 200)
})

test("routes settle at the deadline and on caller abort, even when a dependency never answers", async t => {
  // A held prerequisite read: the deadline answers, and its signal reaches the read.
  let readSignal: AbortSignal | undefined
  const held = await fixture(t, ["session.context", "session.images.read"], { routeBudgetMs: 30,
    onSessionGet: (_id, _reads, signal) => { readSignal = signal; return never() } })
  for (const [method, body] of [["imagesStatus", { sessionID: "ses_work" }], ["images", { sessionID: "ses_images" }]] as const) {
    const answer = await within(held.post(method, body), 2000)
    assert.notEqual(answer, "hung", `${method} settled at the deadline`)
    assert.equal((answer as Exclude<typeof answer, "hung">).statusCode, 503)
    assert.equal(readSignal?.aborted, true, `${method}: the session read was cancelled`)
  }
  let settingsSignal: AbortSignal | undefined
  const settings = await fixture(t, ["session.context", "session.images.read"], { routeBudgetMs: 30,
    onSettingsRead: signal => { settingsSignal = signal; return never() } })
  assert.notEqual(await within(settings.post("imagesStatus", { directory: "/repo" }), 2000), "hung", "a held image settings read")
  assert.equal(settingsSignal?.aborted, true, "the image settings read was cancelled")

  // Caller abort, with a dependency that ignores signals: the route stops awaiting and settles.
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const abandoned = await fixture(t, ["session.context", "session.images.read"], { onSettingsRead: () => { entered(); return never() } })
  const settled = new Promise<number>(resolve => abandoned.app.addHook("onSend", async (_request, reply, payload) => { resolve(reply.statusCode); return payload }))
  const address = await abandoned.app.listen({ host: "127.0.0.1", port: 0 })
  const caller = new AbortController()
  const response = fetch(`${address}/api/panel-extensions/${abandoned.pkg.manifest.id}/imagesStatus`, { method: "POST", signal: caller.signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ instanceId: "i", digest: abandoned.pkg.digest, directory: "/repo" }) })
  await started
  caller.abort()
  await assert.rejects(response)
  assert.notEqual(await within(settled, 2000), "hung", "the abandoned route settled")
})

test("a conversation route stopped at its deadline releases the worktree-deletion fence; its Location read gets the signal", async t => {
  for (const method of ["conversationStatus", "conversationOpen", "conversationNew"] as const) {
    const fence = new WorktreeDeletionFence(300)
    let readSignal: AbortSignal | undefined, entered = false
    const held = await fixture(t, ["session.context", "images.conversation"], { fence, routeBudgetMs: 200,
      onLocationGet: signal => { entered = true; readSignal = signal; return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })) } })
    const answer = await within(held.post(method, method === "conversationStatus" ? { directory: "/repo" } : { directory: "/repo", title: "Images" }), 2000)
    assert.notEqual(answer, "hung", `${method} answered`)
    assert.equal(entered, true, `${method}: the held Location read was reached inside the fence`)
    assert.equal(await within(fence.run("/repo", ["/repo"], async () => "deleted").catch(error => String(error)), 2000), "deleted",
      `${method}: a following deletion proceeds`)
    assert.equal(readSignal?.aborted, true, `${method}: location.get was cancelled`)
  }
})

test("preferences routes: get/set through the store; a corrupt store answers unavailable without rewriting", async t => {
  const { post, file } = await fixture(t, ["session.context", "panel.preferences"])
  assert.deepEqual((await post("preferencesGet")).json(), { status: "ok", value: {} })
  assert.deepEqual((await post("preferencesSet", { value: { imagesPerTurn: 4 } })).json(), { status: "saved" })
  assert.deepEqual((await post("preferencesGet")).json(), { status: "ok", value: { imagesPerTurn: 4 } })
  assert.deepEqual((await post("preferencesSet", { value: [4] })).json(), { status: "invalid" })
  assert.deepEqual((await post("preferencesSet", { value: { v: "x".repeat(4096) } })).json(), { status: "too-large" })
  await writeFile(file, "corrupt")
  assert.deepEqual((await post("preferencesGet")).json(), { status: "unavailable" })
  assert.deepEqual((await post("preferencesSet", { value: {} })).json(), { status: "unavailable" })
  assert.equal(await readFile(file, "utf8"), "corrupt")
})

test("notes routes: the displayed session's note in its project, a paged project list with orphans, delete and open", async t => {
  const { post, sessions, owned, notesChanged, pkg } = await fixture(t, ["session.context", "panel.notes"])
  assert.deepEqual((await post("notesGet", { sessionID: "ses_work" })).json(), { note: null })
  const saved = (await post("notesSet", { sessionID: "ses_work", text: "plan", revision: 0 })).json()
  assert.equal(saved.status, "saved")
  assert.deepEqual(notesChanged, [pkg.manifest.id])
  assert.deepEqual((await post("notesGet", { sessionID: "ses_work" })).json(), { note: { text: "plan", revision: saved.revision } })
  assert.equal((await post("notesSet", { sessionID: "ses_work", text: "late", revision: 0 })).json().status, "conflict")
  assert.equal((await post("notesSet", { sessionID: "ses_foreign", text: "x", revision: 0 })).statusCode, 403, "a foreign session is refused")
  assert.equal((await post("notesSet", { sessionID: "ses_work", text: "x", revision: 0, directory: "/elsewhere" })).statusCode, 400, "the host chooses the project")
  const other = (await post("notesSet", { sessionID: "ses_other", text: "aside", revision: 0 })).json()

  // Without a displayed session, the list is the instance's project; a deleted session's note is an orphan with its last title.
  delete sessions.ses_work
  const page = (await post("notesList", {})).json()
  assert.deepEqual(page.notes.map((note: any) => [note.sessionID, note.title, note.orphan]), [["ses_other", "Other", false], ["ses_work", "Work", true]])
  assert.equal(page.cursor, null)
  assert.deepEqual((await post("notesOpen", { target: "ses_work" })).json(), { openable: false }, "an orphan cannot be opened")
  assert.deepEqual((await post("notesOpen", { target: "ses_other" })).json(), { openable: true })
  assert.deepEqual((await post("notesOpen", { target: "ses_images" })).json(), { openable: false }, "only a session with a note")
  assert.deepEqual((await post("notesDelete", { target: "ses_work", revision: 1 })).json(), { status: "conflict" })
  assert.deepEqual((await post("notesDelete", { target: "ses_work", revision: saved.revision })).json(), { status: "deleted" })
  assert.deepEqual((await post("notesDelete", { target: "ses_other", revision: other.revision })).json(), { status: "deleted" })
  assert.deepEqual((await post("notesList", { sessionID: "ses_other" })).json(), { notes: [], cursor: null })
  owned.delete("/repo")
  assert.equal((await post("notesList", {})).statusCode, 403, "a disowned Location has no project")
})

test("notes: a session moved while its project resolves is refused before anything is written", async t => {
  let f: Fixture = await fixture(t, ["session.context", "panel.notes"], { onProjectIdentity: () => { f.sessions.ses_work.location = { directory: "/linked" } } })
  f.owned.add("/linked")
  assert.equal((await f.post("notesSet", { sessionID: "ses_work", text: "stale", revision: 0 })).statusCode, 409)
  assert.deepEqual(await f.store.notes(f.pkg.manifest.id, f.pkg.digest, "a".repeat(64)), [], "the old project stays empty")
  assert.deepEqual(f.notesChanged, [])
})
test("notes: a moved session keeps its written title and cannot be opened; late or fenced writes never commit; bytes decide too-large", async t => {
  const f = await fixture(t, ["session.context", "panel.notes"])
  const project = "a".repeat(64)
  await f.post("notesSet", { sessionID: "ses_other", text: "aside", revision: 0 })
  f.owned.add("/nested")
  Object.assign(f.sessions.ses_other, { location: { directory: "/nested" }, title: "Renamed elsewhere" })
  assert.equal((await f.post("notesList", {})).json().notes[0].title, "Other", "no live title from another project")
  assert.deepEqual((await f.post("notesOpen", { target: "ses_other" })).json(), { openable: false })
  // In a clone of the project open in another window: its live title, but this window cannot open it.
  Object.assign(f.sessions.ses_other, { location: { directory: "/clone" }, title: "Renamed in the clone" })
  assert.equal((await f.post("notesList", {})).json().notes[0].title, "Renamed in the clone")
  assert.deepEqual((await f.post("notesOpen", { target: "ses_other" })).json(), { openable: false })

  assert.equal((await f.post("notesSet", { sessionID: "ses_work", text: "x".repeat(32 * 1024 + 1), revision: 0 })).json().status, "too-large")

  // A worktree under deletion refuses the write.
  const fence = new WorktreeDeletionFence()
  const fenced = await fixture(t, ["session.context", "panel.notes"], { fence })
  let release!: () => void
  const deleting = fence.run("/repo", ["/repo"], () => new Promise<void>(resolve => { release = resolve }))
  try {
    assert.equal((await fenced.post("notesSet", { sessionID: "ses_work", text: "late", revision: 0 })).statusCode, 409)
  } finally { release(); await deleting }
  assert.deepEqual(await fenced.store.notes(fenced.pkg.manifest.id, fenced.pkg.digest, project), [])

  // A write still staging when the route gives up is never renamed into place.
  const slow = await fixture(t, ["session.context", "panel.notes"], { routeBudgetMs: 300 })
  const write = fs.writeFile
  let resume!: () => void
  const held = new Promise<void>(resolve => { resume = resolve })
  const mock = t.mock.method(fs, "writeFile", async (file: any, ...rest: any[]) => {
    if (String(file).includes(`${path.sep}notes${path.sep}`)) await held
    return (write as any)(file, ...rest)
  })
  assert.equal((await slow.post("notesSet", { sessionID: "ses_work", text: "late", revision: 0 })).statusCode, 503)
  resume()
  await new Promise(resolve => setTimeout(resolve, 100))
  mock.mock.restore()
  assert.deepEqual(await slow.store.notes(slow.pkg.manifest.id, slow.pkg.digest, project), [])
})
test("notes: a remote change during a write refuses it; a committed write answers saved; live titles are bounded", async t => {
  let reads = 0
  const moved = await fixture(t, ["session.context", "panel.notes"], { onProjectIdentity: () => ++reads > 1 ? "c".repeat(64) : undefined })
  assert.equal((await moved.post("notesSet", { sessionID: "ses_work", text: "late", revision: 0 })).statusCode, 409)
  assert.deepEqual(await moved.store.notes(moved.pkg.manifest.id, moved.pkg.digest, "a".repeat(64)), [])

  const f = await fixture(t, ["session.context", "panel.notes"])
  const setNote = f.store.setNote.bind(f.store)
  const mock = t.mock.method(f.store, "setNote", async (...args: Parameters<typeof setNote>) => {
    const result = await setNote(...args)
    f.sessions.ses_work.location = { directory: "/elsewhere" }
    return result
  })
  assert.equal((await f.post("notesSet", { sessionID: "ses_work", text: "kept", revision: 0 })).json().status, "saved", "never refused after it committed")
  mock.mock.restore()
  f.sessions.ses_work.location = { directory: "/repo" }
  f.sessions.ses_work.title = "x".repeat(255) + "😀"
  assert.equal((await f.post("notesList", {})).json().notes[0].title, "x".repeat(255))
})
test("notes: a remote change while a note is read refuses the answer", async t => {
  let reads = 0
  // The first read resolves the project; the second, after the note is read, finds another one.
  const f = await fixture(t, ["session.context", "panel.notes"], { onProjectIdentity: () => ++reads === 2 ? "c".repeat(64) : undefined })
  assert.equal((await f.post("notesGet", { sessionID: "ses_work" })).statusCode, 409)
  assert.equal((await f.post("notesGet", { sessionID: "ses_work" })).statusCode, 200)
})

test("notes: a stale write from a session that just moved is refused, not answered with the old project's note", async t => {
  let move = false
  let f: Fixture = await fixture(t, ["session.context", "panel.notes"], { onProjectIdentity: () => { if (move) f.sessions.ses_work.location = { directory: "/linked" } } })
  f.owned.add("/linked")
  assert.equal((await f.post("notesSet", { sessionID: "ses_work", text: "old project", revision: 0 })).json().status, "saved")
  move = true
  const stale = await f.post("notesSet", { sessionID: "ses_work", text: "x", revision: 0 })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.body.includes("old project"), false)
})

test("notes: a session moving during the last project check is refused; a started commit settles the route; open skips a worktree being deleted", async t => {
  // The session moves while the write's in-queue Git check runs.
  let reads = 0
  let f: Fixture = await fixture(t, ["session.context", "panel.notes"], { onProjectIdentity: () => { if (++reads === 2) f.sessions.ses_work.location = { directory: "/linked" } } })
  f.owned.add("/linked")
  assert.equal((await f.post("notesSet", { sessionID: "ses_work", text: "late", revision: 0 })).statusCode, 409)
  assert.deepEqual(await f.store.notes(f.pkg.manifest.id, f.pkg.digest, "a".repeat(64)), [])

  // The deadline passes while the rename runs: its outcome, not the deadline, answers.
  const slow = await fixture(t, ["session.context", "panel.notes"], { routeBudgetMs: 400 })
  const rename = fs.rename
  const mock = t.mock.method(fs, "rename", async (from: string, to: string) => {
    if (to.endsWith(`${"a".repeat(64)}.json`)) await new Promise(resolve => setTimeout(resolve, 600))
    return rename(from, to)
  })
  const committed = await slow.post("notesSet", { sessionID: "ses_work", text: "kept", revision: 0 })
  mock.mock.restore()
  assert.equal(committed.json().status, "saved")
  assert.deepEqual((await slow.store.notes(slow.pkg.manifest.id, slow.pkg.digest, "a".repeat(64))).map(note => note.text), ["kept"])

  // A noted session in a linked worktree being deleted is not opened.
  const fence = new WorktreeDeletionFence()
  const g = await fixture(t, ["session.context", "panel.notes"], { fence })
  g.owned.add("/linked")
  await g.post("notesSet", { sessionID: "ses_other", text: "aside", revision: 0 })
  g.sessions.ses_other.location = { directory: "/linked" }
  let release!: () => void
  const deleting = fence.run("/linked", ["/linked"], () => new Promise<void>(resolve => { release = resolve }))
  try { assert.deepEqual((await g.post("notesOpen", { target: "ses_other" })).json(), { openable: false }) }
  finally { release(); await deleting }
})
