// Private copy of the existing isolation helper: current-version check only.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { OpenCode } from "@opencode/client"
export { ASSIGNED_CLI, privateRoot } from "../../missions-child-environment/runtime.mjs"
export async function launch(cli, root, environment, deadline) {
  let logs = "", failure
  const child = spawn(cli, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--print-logs"], { cwd: root, env: environment, windowsHide: true })
  const closed = new Promise(resolve => child.once("close", resolve))
  child.once("error", error => { failure = error })
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { logs = (logs + data).slice(-2 * 1024 * 1024) })
  const watchdog = setTimeout(() => child.kill(), Math.max(1, deadline - Date.now())); watchdog.unref()
  const stop = async () => { clearTimeout(watchdog); if (child.exitCode === null) child.kill(); await closed }
  try {
    const end = Math.min(deadline, Date.now() + 30_000)
    while (!/http:\/\/127\.0\.0\.1:\d+/.test(logs)) {
      if (failure) throw failure
      if (child.exitCode !== null || Date.now() > end) throw new Error("Assigned private serve failed to start")
      await delay(50)
    }
    const url = logs.match(/http:\/\/127\.0\.0\.1:\d+/)[0]
    const headers = { authorization: `Basic ${Buffer.from(`opencode:${environment.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` }
    const client = OpenCode.make({ baseUrl: url, headers })
    const info = await client.server.info({ signal: AbortSignal.timeout(10_000) })
    assert.equal(info.version, "2.0.22")
    return { child, closed, url, client, info, stop, headers, get logs() { return logs } }
  } catch (error) { await stop(); throw error }
}
