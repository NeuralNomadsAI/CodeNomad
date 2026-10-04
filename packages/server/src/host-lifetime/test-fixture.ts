/** PRIVATE process fixture, never a product launcher/backend. */
import { createServer } from "node:http"
import { lstat } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { HostStorage, type StoragePolicy } from "./storage"
import { createHostLifetimeManagerForPrivateFixture } from "./manager"
import { BootstrapProofs } from "./bootstrap"
import { installBackendHostLifetime } from "./backend"
import { NativeParent } from "../native-parent"
import { TokenManager } from "../auth/token-manager"
import { readBody } from "./transport"
import type { Scope } from "./protocol"

// Windows ACL qualification is intentionally NOT claimed by this test adapter.
export const fixtureStoragePolicy: StoragePolicy = {
  async verify(file, directory) {
    const stat = await lstat(file)
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error("fixture-unsafe-type")
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("fixture-unsafe-permissions")
  },
}
const [mode, root, serializedScope] = process.argv.slice(2)
const direct = process.argv[1] === fileURLToPath(import.meta.url)
if (direct && mode === "manager") {
  const scope = JSON.parse(serializedScope) as Scope
  const fixture = fileURLToPath(import.meta.url)
  const manager = createHostLifetimeManagerForPrivateFixture({ storage: new HostStorage(root, scope, fixtureStoragePolicy),
    backend: { file: process.execPath, args: ["--import", "tsx", fixture, "backend"], cwd: process.cwd(), env: process.env },
    startService: async () => ({ fixture: "persistent-service-route", sharedDaemonStopped: false }),
  })
  try { if (!await manager.start()) process.exit(0) } catch { process.exit(2) }
}
if (direct && mode === "backend") {
  const parent = new NativeParent()
  const tokens = new TokenManager(60_000)
  const proofs = new BootstrapProofs({ issueBootstrapToken: () => tokens.generate(), consumeBootstrapToken: token => tokens.consume(token) })
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const body = await readBody(request) as { proof?: string; method?: string; windowId?: string }
        const result = request.url === "/consume" ? { accepted: proofs.consume(body.proof ?? "") }
          : await parent.request(body.method!, { windowId: body.windowId }, 2_000)
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result))
      } catch { response.writeHead(503).end('{"code":"native-unavailable"}') }
    })()
  })
  let buffer = ""
  process.stdin.on("data", chunk => {
    buffer += chunk.toString()
    let end: number
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (line === "codenomad:shutdown") {
        process.stdout.write("CODENOMAD_SHUTDOWN_STATUS:complete\n", () => process.exit(0))
        return
      }
      parent.handleLine(line)
    }
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") process.exit(1)
  installBackendHostLifetime(proofs, `http://127.0.0.1:${address.port}`)
  // Verify private output cannot become host logs/registration secrets.
  process.stdout.write("CODENOMAD_BOOTSTRAP_TOKEN:fixture-secret-never-log\n")
}
