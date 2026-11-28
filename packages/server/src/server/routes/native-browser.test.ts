import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerNativeBrowserRoutes } from "./native-browser"

test("only local UI requests hold or release a session's browser", async t => {
  const holds: string[] = [], releases: string[] = []
  let local = false
  const app = Fastify()
  registerNativeBrowserRoutes(app, {
    attachments: { hold: (id: string) => holds.push(id), release: (id: string) => releases.push(id) } as never,
    localUiRequest: () => local,
  })
  t.after(() => app.close())
  const id = "1b4e28ba-2fa1-11d2-883f-0016d3cca427"
  const hold = () => app.inject({ method: "PUT", url: `/api/native-browser/holds/${id}`, payload: { workspaceId: "ws", sessionId: "ses" } })
  // A client behind a loopback reverse proxy is not a local UI.
  assert.equal((await hold()).statusCode, 403)
  assert.equal((await app.inject({ method: "DELETE", url: `/api/native-browser/holds/${id}` })).statusCode, 403)
  assert.deepEqual([holds, releases], [[], []])
  local = true
  assert.equal((await hold()).statusCode, 204)
  assert.deepEqual(holds, [id])
})
