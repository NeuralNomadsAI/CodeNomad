/** Isolated ordinary AuthManager fixture. No native CLI, workspace or host lifetime. */
import path from "node:path"
import Fastify from "fastify"
import pino from "pino"
import { AuthManager } from "../../../server/src/auth/manager"
import { registerAuthRoutes } from "../../../server/src/server/routes/auth"

const [root] = process.argv.slice(2)
if (!root || !path.isAbsolute(root)) throw new Error("Private auth fixture directory required")
setTimeout(() => process.exit(1), 30_000).unref()
const auth = new AuthManager({ configPath: path.join(root, "config.yaml"), username: "fixture", generateToken: true,
  cookieName: "desktop_backend_fixture" }, pino({ level: "silent" }))
const app = Fastify({ logger: false })
registerAuthRoutes(app, { authManager: auth })
const origin = await app.listen({ host: "127.0.0.1", port: 0 })
process.stdout.write(`${JSON.stringify({ origin, proof: auth.issueBootstrapToken(), cookieName: auth.getCookieName() })}\n`)
let input = ""
process.stdin.on("data", chunk => {
  input += chunk.toString()
  if (input.length > 128) throw new Error("Private auth fixture input exceeded limit")
  if (input === "codenomad:shutdown\n") void app.close().then(() => {
    process.stdout.write("CODENOMAD_SHUTDOWN_STATUS:complete\n", () => process.exit(0))
  })
})
