// Real fixed brokers, shipped plugin and synthetic private daemon/storage only.
import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import Fastify from "fastify"
import { withProductRuntime } from "./native-product-fixture.mjs"
import { DesktopPluginLifecycle } from "../packages/server/src/opencode/desktop-plugin-lifecycle.ts"
import { registerSessionPruningRoutes } from "../packages/server/src/server/routes/session-pruning.ts"
import { registerImagesConversationRoute } from "../packages/server/src/server/routes/images-conversation.ts"
import { WorktreeDeletionFence } from "../packages/server/src/workspaces/worktree-session-evacuation.ts"

const bundle = await readFile(new URL("../packages/server/dist/plugins/session-pruning/plugin.mjs", import.meta.url))
let lifecycle = new DesktopPluginLifecycle("session-pruning", async () => bundle), paths
try {
  await withProductRuntime(process.argv[2], async ({ root, configDirectory }) => {
    paths = { config: configDirectory, data: path.join(root, "codenomad") }
    await lifecycle.start(paths)
    return { experimental: { media_blob: true, part_rows: process.argv.includes("--part-rows") } }
  }, async ({ root, client, connection, requests }) => {
    const claim = await lifecycle.prepare(paths, connection.assertCurrent, connection)
    claim.commit(); await claim.release()
    const base = { directory: root }, workspace = { id: "fixture", path: root }
    const admitted = new Set([root]), calls = []
    const rpc = client.rpc.call
    client.rpc.call = async (...args) => { calls.push(args[0]); return rpc(...args) }
    const manager = {
      get: id => id === "fixture" ? workspace : undefined,
      getServiceLocation: id => id === "fixture" ? base : undefined,
      getSharedServiceClient: async () => client, getSharedServiceConnection: async () => connection,
      ownsLocation: async (id, location) => id === "fixture" && admitted.has(path.resolve(location.directory)),
      getWorktreeIdentityForPath: async (_id, directory) => admitted.has(path.resolve(directory)) ? path.resolve(directory) : undefined,
      getWorktrees: async () => [], getServiceWslDistro: () => undefined, getHostPathForServicePath: async (_id, file) => file,
      desktopPluginsReady: target => lifecycle.ready(target),
    }
    const app = Fastify(), fence = new WorktreeDeletionFence()
    registerSessionPruningRoutes(app, { workspaceManager: manager, worktreeDeletionFence: fence })
    registerImagesConversationRoute(app, { workspaceManager: manager, worktreeDeletionFence: fence })
    const send = async (suffix, payload) => {
      const response = await app.inject({ method: "POST", url: `/api/workspaces/fixture/${suffix}`, payload })
      assert.equal(response.statusCode, 200, response.body)
      return response.json()
    }
    try {
      const seed = await client.session.create({ location: base })
      await client.session.prompt({ sessionID: seed.id, text: "Return the synthetic fixture answer." })
      await client.session.wait({ sessionID: seed.id }, { signal: AbortSignal.timeout(20000) })
      const exported = await client.session.export({ sessionID: seed.id })
      await client.session.remove({ sessionID: seed.id })
      const template = exported.messages.find(message => message.type === "assistant")
      assert(template)
      const cold = path.join(root, "cold-project")
      await mkdir(cold); admitted.add(cold)
      const session = await client.session.import({ ...exported, location: { directory: cold }, messages: [{
        ...template, id: "msg_cold_pruning_fixture", content: [
          { type: "reasoning", text: "REMOVE_ONLY_THIS", time: { created: 1, completed: 2 } },
          { type: "text", text: "Keep this conclusion" },
        ],
      }] })
      assert.equal(session.location.directory, cold)
      const input = { sessionID: session.id, messageID: "msg_cold_pruning_fixture" }
      const preview = await send("session-pruning/preview", input)
      assert.equal(preview.status, "preview", JSON.stringify(preview))
      assert.equal(calls.filter(call => call.method === "preview").length, 1)
      const result = await send("session-pruning/prune", { ...input, revision: preview.revision, indexes: [0] })
      assert.equal(result.status, "pruned", JSON.stringify(result))
      assert.equal(calls.filter(call => call.method === "prune").length, 1, "A readiness wait never replays the write")
      const stored = await client.session.message.get(input)
      assert.deepEqual(stored.content, [{ type: "text", text: "Keep this conclusion" }])
      const history = await send("session-history/query", { sessionID: session.id, purpose: "search", query: "conclusion", includeTechnical: false })
      assert.equal(history.status, "page", JSON.stringify(history))
      assert.equal(history.hits.length, 1, JSON.stringify(history))
      const imageCold = path.join(root, "cold-images")
      await mkdir(imageCold); admitted.add(imageCold)
      assert.deepEqual(await send("images-conversation", { directory: imageCold, mode: "lookup" }), { status: "absent" })
      // A new backend lease gets a fresh proof even when the native catalogue
      // retains an active plugin entry and a preceding scope's files existed.
      await lifecycle.stop()
      lifecycle = new DesktopPluginLifecycle("session-pruning", async () => bundle)
      const renewed = await lifecycle.prepare(paths, connection.assertCurrent, connection)
      renewed.commit(); await renewed.release()
      const again = await send("session-pruning/preview", input)
      assert.equal(again.status, "preview", JSON.stringify(again))
      assert.equal(calls.filter(call => call.method === "prune").length, 1)
      assert.equal(requests.length > 0, true)
      console.log(`PASS ${(await client.server.info()).version}: fixed cold-Location preview/prune/history/Images, fresh backend lease, one mutation dispatch and retained conclusion`)
    } finally { await app.close(); await lifecycle.stop() }
  })
} finally { await lifecycle.stop() }
