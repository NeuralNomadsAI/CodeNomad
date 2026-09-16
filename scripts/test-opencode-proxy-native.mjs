import assert from "node:assert/strict"
import path from "node:path"
import Fastify from "fastify"
import replyFrom from "@fastify/reply-from"
import pino from "pino"
import { OpenCode } from "@opencode/client"
import { tsImport } from "tsx/esm/api"

// Called only by the isolated native fixture; no discovery or user storage.
export async function testNativeProxy({ client, baseUrl, root, authorization, runtimeFetch, connection, exercise }) {
  const { registerInstanceProxyRoutes } = await tsImport("../packages/server/src/server/http-server.ts", import.meta.url)
  const { createInstanceFetch } = await tsImport("../packages/ui/src/lib/sdk-manager.ts", import.meta.url)
  const app = Fastify()
  await app.register(replyFrom)
  const owns = candidate => path.resolve(candidate) === path.resolve(root)
  registerInstanceProxyRoutes(app, {
    workspaceManager: {
      get: () => ({ id: "native", path: root }),
      getSharedServiceEndpoint: async () => ({ url: baseUrl }),
      ...(connection ? { getSharedServiceConnection: async () => connection } : {}),
      getInstanceAuthorizationHeader: () => authorization,
      getServiceDirectory: () => root,
      getSharedServiceClient: async () => client,
      ...(runtimeFetch ? { getSharedServiceFetch: async () => runtimeFetch } : {}),
      getWorktreeIdentityForPath: async (_id, directory) => owns(directory) ? root : undefined,
      ownsDirectory: async (_id, directory) => owns(directory),
      ownsLocation: async (_id, location) => owns(location.directory) && location.workspaceID === undefined,
      ownsPath: async (_id, candidate) => owns(candidate),
    },
    worktreeDeletionFence: { enter: () => () => {} },
    logger: pino({ level: "silent" }),
  })
  await app.listen({ host: "127.0.0.1", port: 0 })
  const proxyBase = `http://127.0.0.1:${app.server.address().port}/workspaces/native/instance/`
  const forward = createInstanceFetch(proxyBase)
  const proxy = OpenCode.make({ baseUrl: proxyBase, fetch: async (input, init) => {
    const response = await forward(input, init)
    if (!response.ok) assert.fail(`${init?.method} ${input}: ${response.status} ${await response.text()}`)
    return response
  } })
  const created = []
  try {
    const location = { directory: root }
    const info = await proxy.location.get({ location })
    assert.ok(info.project.id)
    assert.ok(Array.isArray(await proxy.project.list()))
    for (const resource of [proxy.agent, proxy.provider, proxy.model, proxy.command, proxy.plugin, proxy.mcp]) {
      assert.ok(Array.isArray((await resource.list({ location })).data))
    }
    assert.ok(Array.isArray((await proxy.permission.request.list({ location })).data))
    for (let index = 0; index < 3; index++) created.push(await proxy.session.create({ location }))
    const sessionID = created[0].id
    await proxy.session.update({ sessionID, title: "Stable proxy fixture" })
    assert.equal((await proxy.session.get({ sessionID })).title, "Stable proxy fixture")
    const page = await proxy.session.list({ directory: root, limit: 1 })
    assert.equal(page.data.length, 1)
    assert.ok(page.cursor.next)
    const continuation = await proxy.session.list({ cursor: page.cursor.next, limit: 1 })
    assert.equal(continuation.data.length, 1)
    assert.notEqual(continuation.data[0].id, page.data[0].id)
    assert.equal(typeof await proxy.session.active(), "object")
    await proxy.session.instructions.entry.put({ sessionID, key: "fixture", value: "Fixture instruction" })
    await proxy.session.instructions.entry.remove({ sessionID, key: "fixture" })
    await proxy.session.wait({ sessionID })
    const header = { headers: { "x-opencode-directory": encodeURIComponent(root) } }
    for (const owner of [sessionID, "global"]) {
      for (const action of ["reply", "cancel"]) {
        const form = await client.session.form.create({
          sessionID: owner, title: "Fixture form", fields: [{ key: "answer", type: "string" }],
        }, owner === "global" ? header : undefined)
        const listed = await proxy.form.list({ location })
        assert.ok(listed.data.some(item => item.id === form.id))
        const input = { sessionID: owner, formID: form.id }
        if (action === "reply") await proxy.session.form.reply({ ...input, answer: { answer: "ok" } }, header)
        else await proxy.session.form.cancel(input, header)
        assert.ok(!(await proxy.form.list({ location })).data.some(item => item.id === form.id))
      }
    }
    await exercise?.(proxy, sessionID)
    // Export remains a direct native read; it is deliberately not added to the
    // guarded UI allowlist merely for this fixture.
    const exported = await client.session.export({ sessionID })
    await proxy.session.remove({ sessionID })
    const restored = await proxy.session.import({ ...exported, location })
    assert.equal(restored.id, sessionID)
    assert.equal((await proxy.message.list({ sessionID, limit: 100 })).data.length, exported.messages.length)
    console.log("PASS: generated stable client through real proxy: catalogs, sessions, native cursors, active envelope, instructions, wait and session/global Forms")
  } finally {
    // Import can fail after its source has already been removed. Cleanup must
    // neither replace that failure with a 404 nor leave the HTTP listener open.
    try { await Promise.allSettled(created.map(session => client.session.remove({ sessionID: session.id }))) }
    finally { await app.close() }
  }
}
