import assert from "node:assert/strict"
import { it } from "node:test"
import Fastify from "fastify"
import type { AuthManager } from "../../auth/manager"
import { registerAuthRoutes } from "./auth"

it("renders the escaped default username literally as the login field value", async () => {
  const app = Fastify({ logger: false })
  const username = " code$&\"nomad "
  const authManager = {
    getSessionFromRequest: () => null,
    getStatus: () => ({ username }),
  } as unknown as AuthManager
  registerAuthRoutes(app, { authManager })

  const response = await app.inject({ method: "GET", url: "/login" })

  assert.equal(response.statusCode, 200)
  assert.ok(response.body.includes('value=" code$&amp;&quot;nomad "'))
  assert.match(response.body, /const username = \$\("username"\)\.value\s*\n/)
  assert.equal(response.body.match(/autocapitalize="none"/g)?.length, 2)
  assert.equal(response.body.match(/autocorrect="off"/g)?.length, 2)
  assert.equal(response.body.match(/spellcheck="false"/g)?.length, 2)
  await app.close()
})
