import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { SERVER_SHUTDOWN_COMPLETE, SERVER_SHUTDOWN_INCOMPLETE, STDIN_SHUTDOWN_COMMAND } from "./shutdown"

for (const trigger of ["stdin", "SIGTERM"] as const) {
  for (const closed of [false, true]) {
    test(`shutdown ${trigger}: stdout ${closed ? "closed preserves failure" : "drained succeeds"}`, {
      skip: trigger === "SIGTERM" && process.platform === "win32", timeout: 15_000,
    }, async (context) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/shutdown-output.ts", import.meta.url))], {
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
      })
      context.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL") })
      const exited = once(child, "close")
      const stdout: Buffer[] = [], stderr: Buffer[] = []
      child.stderr.on("data", (data: Buffer) => stderr.push(data))
      let ready!: () => void
      let readySeen = false
      const started = new Promise<void>((resolve) => { ready = resolve })
      child.stdout.on("data", (data: Buffer) => {
        stdout.push(data)
        if (!readySeen && Buffer.concat(stdout).includes("READY\n")) { readySeen = true; ready() }
        // Slow but open consumers still allow successful cleanup.
        if (!closed) { child.stdout.pause(); setImmediate(() => child.stdout.resume()) }
      })
      await Promise.race([started, exited.then(() => { throw new Error("child exited before READY") })])
      if (closed) child.stdout.destroy()
      if (trigger === "SIGTERM") child.kill("SIGTERM")
      else child.stdin.end(`${STDIN_SHUTDOWN_COMMAND}\n`)
      const [code, signal] = await exited
      const out = Buffer.concat(stdout).toString(), err = Buffer.concat(stderr).toString()
      assert.equal(signal, null, err)
      assert.equal(code, closed ? 1 : 0, err)
      if (closed) assert.match(err, /EPIPE|ECONNRESET/)
      else {
        assert.equal(out.split("\n").filter((line) => line === SERVER_SHUTDOWN_COMPLETE).length, 1)
        assert.ok(!out.includes(SERVER_SHUTDOWN_INCOMPLETE))
        assert.ok(!err.includes("Error"))
        assert.match(out, /drain-127/)
        assert.ok(err.length > 512 * 1024)
      }
    })
  }
}
