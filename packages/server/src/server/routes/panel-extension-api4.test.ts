import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import Fastify from "fastify"
import { PanelExtensionStore } from "../../panel-extensions/store"
import { readPanelExtensionArchive } from "../../panel-extensions/archive"
import { fixtureArchive } from "../../panel-extensions/archive-fixture"
import { WorktreeDeletionFence } from "../../workspaces/worktree-session-evacuation"
import { registerPanelExtensionApi4Routes } from "./panel-extension-api4"

const target = { messageID: "msg_a", part: 1, index: 0, digest: "a".repeat(64) }
const marked = { "codenomad.companion": "images" }
const model = (id: string, input: string[]) => ({ providerID: "p", id, capabilities: { tools: true, input, output: ["text"] } })

async function fixture(t: TestContext, permissions: string[], options: {
  rpc?: (method: string, input: any, signal: AbortSignal) => unknown
  generation?: { effective: unknown; models: unknown[] | null } | null
  session?: Record<string, unknown>
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "codenomad-api4-route-"))
  const store = new PanelExtensionStore(directory)
  const pkg = await readPanelExtensionArchive(fixtureArchive("<p>x</p>", { apiVersion: 4, permissions }))
  await store.install(pkg); await store.activate(pkg.manifest.id, pkg.digest, true)
  const calls: Array<{ method: string; input: any; directory: string }> = [], excluded: string[] = [], checked: string[] = []
  const sessions: Record<string, any> = {
    ses_images: { id: "ses_images", location: { directory: "/repo" }, metadata: marked, agent: "design", time: { updated: 42 } },
    ses_work: { id: "ses_work", location: { directory: "/repo" }, agent: "build", ...options.session },
    ses_foreign: { id: "ses_foreign", location: { directory: "/elsewhere" } },
  }
  const client: any = {
    session: { get: async ({ sessionID }: any) => sessions[sessionID] ?? Promise.reject(new Error("missing")) },
    location: { get: async ({ location }: any) => ({ directory: location.directory, project: { id: "p" } }) },
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
  const app = Fastify()
  registerPanelExtensionApi4Routes(app, { store, worktreeDeletionFence: new WorktreeDeletionFence(),
    excludeDesignFolder: async value => { excluded.push(value.directory); return "excluded" },
    checkDesignFolderExclusion: async value => { checked.push(value.directory); return excluded.includes(value.directory) ? "excluded" : "missing" },
    imageSettings: { read: async () => ({ location: { directory: "/repo" }, mediaStorage: null,
      generation: options.generation === undefined ? { global: true, effective: true, models: [{ ref: "p/img", name: "Img" }] } : options.generation as any }) },
    workspaceManager: {
      get: (id: string) => id === "i" ? { id, path: "/repo" } as any : undefined,
      getSharedServiceConnection: async (id: string) => id === "i" ? { client, assertCurrent() {} } as any : undefined,
      getSharedServiceClient: async () => client,
      ownsLocation: async (id: string, location: { directory: string }) => id === "i" && location.directory === "/repo",
      desktopPluginsReady: async () => {},
      getWorktreeIdentityForPath: async () => "/repo",
      getServiceWslDistro: () => undefined,
      getHostPathForServicePath: async (_id: string, value: string) => value,
    } })
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }) })
  const post = (method: string, body: Record<string, unknown> = {}) => app.inject({ method: "POST", url: `/api/panel-extensions/${pkg.manifest.id}/${method}`,
    payload: { instanceId: "i", digest: pkg.digest, ...body } })
  return { app, store, pkg, calls, excluded, checked, post, file: path.join(directory, "installed.json") }
}

test("each method requires its own declared permission on the enabled exact package", async t => {
  const { post, store, pkg } = await fixture(t, ["session.context", "panel.preferences"])
  for (const [method, body] of [["images", { sessionID: "ses_images" }], ["imageRead", { sessionID: "ses_images", target }],
    ["imagesStatus", { directory: "/repo" }], ["prefillReferences", { sessionID: "ses_images", targets: [target] }],
    ["conversationStatus", { directory: "/repo" }], ["conversationOpen", { directory: "/repo", title: "Images" }],
    ["conversationNew", { directory: "/repo", title: "Images" }]] as const) {
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
