import assert from "node:assert/strict"
import { test } from "node:test"
import { startNativeService } from "./native-service-start"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConnection } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import { captureProcessTree, forceCapturedProcessTree } from "./process-stop"

function request(script: string) {
  return { file: process.execPath, args: ["-e", script], env: { ...process.env, FIXTURE_VALUE: "a b \" c" },
    cwd: process.cwd(), windowsVerbatimArguments: false }
}

test("native starter preserves environment, arguments and cwd", async () => {
  const result = await startNativeService(request("console.log(JSON.stringify([process.env.FIXTURE_VALUE, process.cwd()])); console.error('notice')"), Date.now() + 5_000)
  assert.deepEqual(JSON.parse(result.stdout), ["a b \" c", process.cwd()])
  assert.match(result.stderr, /notice/)
})

test("native starter bounds expired, failed, excessive and stalled commands", async () => {
  await assert.rejects(startNativeService(request("process.exit(0)"), Date.now() - 1), /expired/)
  await assert.rejects(startNativeService(null, Date.now() + 100), /Invalid/)
  await assert.rejects(startNativeService({ ...request(""), env: { SECRET: "secret\0value" } }, Date.now() + 500), { message: "OpenCode service start failed" })
  for (const script of ["console.error('SECRET'); process.exit(1)", "process.stdout.write('x'.repeat(100000))", "setInterval(()=>{},1000)"]) {
    await assert.rejects(startNativeService(request(script), Date.now() + 500), { message: "OpenCode service start failed" })
  }
})

test("parent-started service survives backend process-tree enforcement", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "codenomad-service-lifetime-"))
  const ready = join(root, "port")
  const backend = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" })
  const exited = once(backend, "exit")
  let port: number | undefined
  async function query(value: string) {
    const socket = createConnection({ host: "127.0.0.1", port: port! })
    socket.setTimeout(1000, () => socket.destroy(new Error("fixture timeout")))
    try {
      await once(socket, "connect")
      socket.end(value)
      let output = ""
      for await (const chunk of socket) output += chunk
      return output
    } finally { socket.destroy() }
  }
  try {
    const daemon = `const fs=require('fs'), net=require('net');
      const server=net.createServer(s=>s.once('data', d=>{if(d.toString()==='stop')process.exit(0);s.end('alive')}));
      server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(ready)}, String(server.address().port)));
      setTimeout(()=>process.exit(0),15000);`
    await startNativeService(request(`const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(daemon)}],{detached:true,stdio:'ignore'});child.unref()`), Date.now() + 5_000)
    const until = Date.now() + 5000
    while (!port && Date.now() < until) {
      port = Number(await readFile(ready, "utf8").catch(() => "")) || undefined
      if (!port) await delay(10)
    }
    assert.ok(port)
    assert.equal(await query("health"), "alive")
    const tree = await captureProcessTree(backend.pid!)
    assert.ok(tree)
    assert.equal(await forceCapturedProcessTree(tree), true)
    await exited
    assert.equal(await query("health"), "alive")
  } finally {
    if (port) await query("stop").catch(() => undefined)
    backend.kill("SIGKILL")
    await exited
    await rm(root, { recursive: true, force: true })
  }
})
