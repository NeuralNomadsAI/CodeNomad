import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import type { Logger } from "../../logger"
import { redactSecrets, registerRequestLogging } from "../http-server"

const cookie = "reusable-real-login-cookie"
const proof = { sessionID: "ses_form", formID: "frm_1", projectID: "prj_1", location: { directory: "C:/repo" },
  profileID: "default", executionHost: "local", workspaceID: "ws_1", principal: { kind: "cookie", sessionID: cookie },
  username: "human", answer: { q0: "yes" }, issuedAt: 1000 }

test("trace request logging never records the human-answer login cookie", async () => {
  const logs: unknown[] = []
  const logger = { debug: (...args: unknown[]) => logs.push(args), trace: (...args: unknown[]) => logs.push(args),
    isLevelEnabled: (level: string) => level === "trace" || level === "debug" } as unknown as Logger
  const app = Fastify()
  registerRequestLogging(app, logger)
  app.post("/api/opencode-plugin/automation", async () => ({ result: { admitted: true } }))
  try {
    for (const payload of [{ mode: "human-answer-verify", sessionID: proof.sessionID, command: proof },
      { body: proof, proof: "a".repeat(64) }, { command: { principal: proof.principal } }]) {
      const response = await app.inject({ method: "POST", url: "/api/opencode-plugin/automation", payload })
      assert.equal(response.statusCode, 200)
    }
  } finally { await app.close() }
  assert(logs.some((entry) => JSON.stringify(entry).includes("HTTP request payload")))
  assert(!JSON.stringify(logs).includes(cookie))
})

test("human-answer redaction keeps ordinary native diagnostics", () => {
  assert.deepEqual(redactSecrets({ sessionID: "ses_native", formID: "frm_native" }),
    { sessionID: "ses_native", formID: "frm_native" })
  assert(!JSON.stringify(redactSecrets({ principal: { kind: "remote-device", deviceID: "dev_1" } })).includes("dev_1"))
})
