// PRIVATE direct-spawn protocol control. No native ownership assertion or server.
import { randomBytes } from "node:crypto"
import { spawn } from "node:child_process"
import path from "node:path"
import { installBackendChannelGuard, installBackendHostLifetime } from "../../packages/server/src/host-lifetime/backend"
import { BootstrapProofs } from "../../packages/server/src/host-lifetime/bootstrap"
import { AuthManager } from "../../packages/server/src/auth/manager"
import { NativeParent } from "../../packages/server/src/native-parent"
import type { Logger } from "../../packages/server/src/logger"

const deadline = setTimeout(() => process.exit(1), 20_000)
async function main() {
  let guard = installBackendChannelGuard() // Reject missing actual IPC before setup.
  const root = process.argv[2]
  if (!root || !path.isAbsolute(root)) throw new Error("fixture-root")
  // Logging suppressed, not authentication. Auth stays enabled and uses real tokens.
  const logger = { child() { return this }, debug() {}, warn() {} } as unknown as Logger
  const native = new NativeParent()
  let buffer = ""
  let busy = false
  process.stdin.on("data", chunk => {
    buffer += chunk.toString()
    if (Buffer.byteLength(buffer) > 4096) process.exit(1)
    let end: number
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
      if (native.handleLine(line)) continue
      if (line !== "codenomad:shutdown") process.exit(1)
      guard.beginShutdown(); native.close()
      process.stdout.write("CODENOMAD_SHUTDOWN_STATUS:complete\n", () => {
        guard.close(); clearTimeout(deadline); process.exit(0)
      })
    }
  })
  if (process.argv[3] === "runtime") {
    // BEFORE AuthManager construction/readiness. Actual native S facts gate reply.
    await native.request("runtime.fixture.admission", { pid: process.pid }, 4000)
  }
  const auth = new AuthManager({ configPath: path.join(root, "config.yaml"),
    username: "private-fixture", generateToken: true }, logger)
  guard = installBackendHostLifetime(new BootstrapProofs(auth), "http://127.0.0.1:49152")
  process.on("message", async input => {
    const value = input as { fixture?: number; id?: string; action?: string; token?: string; nonce?: string }
    if (value?.fixture !== 1) return // Production host messages handled unchanged.
    if (busy || typeof value.id !== "string" || value.id.length > 64
      || Buffer.byteLength(JSON.stringify(value)) > 4096) process.exit(1)
    busy = true
    try {
      let result: unknown
      if (value.action === "consume" && typeof value.token === "string") {
        // Existing AuthManager API, not another auth store or HTTP route.
        result = auth.consumeBootstrapToken(value.token)
      } else if (value.action === "channel" && /^[a-f0-9]{64}$/.test(value.nonce ?? "")) {
        result = { nonce: value.nonce, send: typeof process.send === "function",
          connected: process.connected, envRemoved: process.env.NODE_CHANNEL_FD === undefined,
          serializationRemoved: process.env.NODE_CHANNEL_SERIALIZATION_MODE === undefined }
      } else if (value.action === "native") {
        const nonce = randomBytes(32).toString("hex")
        const reply = await native.request<{ nonce: string }>("browser.fixture.challenge", { nonce }, 3000)
        result = { correlated: reply.nonce === nonce }
      } else if (value.action === "descendant" && process.argv[3] === "runtime") {
        const child = spawn(process.execPath, ["-e", "setTimeout(()=>process.exit(0),60000);setInterval(()=>{},1000)"],
          { detached: true, stdio: "ignore", shell: false, windowsHide: true })
        child.unref()
        result = { pid: child.pid }
      } else process.exit(1)
      process.send!({ fixture: 1, id: value.id, result })
    } catch { process.exit(1) } finally { busy = false }
  })
}
main().catch(() => process.exit(1)) // No raw stack, token, env or payload logging.
