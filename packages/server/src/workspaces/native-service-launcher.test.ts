import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { EventEmitter, once } from "node:events"
import { PassThrough } from "node:stream"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { createNativeServiceLauncher, prepareServiceStarter, type PreparedServiceStarter, type SpawnOutsideBackendContainment } from "./native-service-launcher"

// All commands are private Node surrogates. This adapter exercises launcher
// mechanics only; ordinary Node spawn is NOT Windows Job attestation.
const fixtureSpawn = (file: string, args: string[], options: import("./native-service-launcher").NativeServiceSpawnOptions) => spawn(file, args, options)
const launcher = createNativeServiceLauncher(fixtureSpawn)
const failure = { message: "OpenCode service start failed" }
function request(script: string) {
  return { file: process.execPath, args: ["-e", script, "--", "service", "start"],
    env: { ...process.env, FIXTURE_SECRET: 'private a b " c' } as Record<string, string>,
    cwd: process.cwd(), windowsVerbatimArguments: false }
}
function fixtureRoot() {
  return mkdtemp(join(process.platform === "win32"
    ? join(process.env.LOCALAPPDATA!, "Temp", "opencode") : tmpdir(), "native-service-launcher-"))
}

test("selected CLI request preserves arguments, environment, cwd and native spawn options", async () => {
  const root = await fixtureRoot()
  try {
    let calls = 0
    const start = createNativeServiceLauncher((file, args, options) => {
      calls++
      assert.equal(file, process.execPath)
      assert.equal(options.shell, false)
      assert.equal(options.windowsHide, true)
      assert.equal(options.windowsVerbatimArguments, calls === 2)
      assert.equal(options.detached, process.platform !== "win32")
      assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"])
      return fixtureSpawn(file, args, options)
    })
    // WSL arguments are transported opaquely, not rebuilt by this module.
    const args = ["--distribution", "private fixture", "--exec", "env", 'TOKEN=a b " c', "/bin/opencode", "service", "start"]
    const result = await start({ ...request("console.log(JSON.stringify([process.argv.slice(1), process.cwd(), process.env.FIXTURE_SECRET])); console.error('notice')"),
      cwd: root, args: ["-e", "console.log(JSON.stringify([process.argv.slice(1), process.cwd(), process.env.FIXTURE_SECRET])); console.error('notice')", "--", ...args] }, Date.now() + 5_000)
    assert.equal(calls, 1)
    assert.deepEqual(JSON.parse(result.stdout), [args, root, 'private a b " c'])
    assert.equal(result.stderr, "notice\n")
    // Preserve verbatim mode as well. Node's own argv[0] is unquoted in this
    // mode on Windows, so an executable under Program Files fails. Do not
    // silently rewrite that caller choice to get a successful fixture result.
    const verbatim = start({ ...request(""), args: ["--version"], windowsVerbatimArguments: true }, Date.now() + 5_000)
    if (process.platform === "win32" && /\s/.test(process.execPath)) await assert.rejects(verbatim, failure)
    else assert.match((await verbatim).stdout, /^v\d+/)
    assert.equal(calls, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("invalid and expired requests never call the spawn capability", async () => {
  const start = createNativeServiceLauncher(() => { assert.fail("invalid request spawned") })
  const valid = request("")
  for (const value of [null, {}, { ...valid, file: "" }, { ...valid, args: [1] },
    { ...valid, env: [] }, { ...valid, env: { KEY: 1 } }, { ...valid, cwd: 1 },
    { ...valid, windowsVerbatimArguments: "true" }]) {
    await assert.rejects(start(value, Date.now() + 5_000), /Invalid or expired/)
  }
  for (const deadline of [Date.now() - 1, NaN]) {
    await assert.rejects(start(valid, deadline), /Invalid or expired/)
  }
})

test("Windows has no implicit detached-spawn escape capability", { skip: process.platform !== "win32" }, async () => {
  await assert.rejects(createNativeServiceLauncher()(request("process.exit(0)"), Date.now() + 5_000), failure)
})

test("POSIX default launches a private surrogate", { skip: process.platform === "win32" }, async () => {
  assert.equal((await createNativeServiceLauncher()(request("console.log('private')"), Date.now() + 5_000)).stdout, "private\n")
})

test("64 KiB bounds apply independently to stdout and stderr", async () => {
  const exact = await launcher(request("process.stdout.write('a'.repeat(65536)); process.stderr.write('b'.repeat(65536))"), Date.now() + 5_000)
  assert.equal(Buffer.byteLength(exact.stdout), 65536)
  assert.equal(Buffer.byteLength(exact.stderr), 65536)
  for (const stream of ["stdout", "stderr"]) {
    await assert.rejects(launcher(request(`process.${stream}.write('private'.repeat(10000))`), Date.now() + 5_000), failure)
  }
})

test("spawn errors, CLI output and environment details are redacted without retry", async () => {
  for (const value of [request("console.error(process.env.FIXTURE_SECRET); process.exit(1)"),
    { ...request(""), file: join(process.cwd(), "not-a-private-executable") },
    { ...request(""), env: { SECRET: "private\0value" } }]) {
    await assert.rejects(launcher(value, Date.now() + 5_000), failure)
  }
  let calls = 0
  await assert.rejects(createNativeServiceLauncher(() => { calls++; throw new Error("private native error") })(request(""), Date.now() + 5_000), failure)
  assert.equal(calls, 1)
})

for (const [producer, callback] of [
  ["synchronous", "setImmediate"], ["synchronous", "stream"],
  ["prepared async", "setImmediate"], ["prepared async", "stream"],
] as const) {
  test(`${producer} ENOENT from a ${callback} callback rejects without crashing or leaking details`, async () => {
    const root = await fixtureRoot()
    try {
      const script = `
        import { spawn } from "node:child_process";
        import { PassThrough } from "node:stream";
        import { createNativeServiceLauncher, prepareServiceStarter } from ${JSON.stringify(new URL("./native-service-launcher.ts", import.meta.url).href)};
        const launch = ${producer === "synchronous" ? "(file, args, options) => spawn(file, args, options)" : `async (file, args, options) => {
          const prepared = prepareServiceStarter(spawn(file, args, options));
          // ENOENT occurs during this delay, before the launcher receives anything.
          await new Promise(resolve => setImmediate(resolve));
          return prepared;
        }`};
        const launcher = createNativeServiceLauncher(launch);
        const run = () => {
          launcher({ file: ${JSON.stringify(join(root, "private-spawn-detail-missing-executable"))}, args: [],
            env: { ...process.env, PRIVATE_VALUE: "must-not-be-logged" }, cwd: ${JSON.stringify(root)},
            windowsVerbatimArguments: false }, Date.now() + 2000).then(
            () => { process.exitCode = 2; },
            error => {
              if (error.message !== "OpenCode service start failed") { process.exitCode = 3; return; }
              process.stdout.write(error.message);
            });
        };
        if (${JSON.stringify(callback)} === "setImmediate") setImmediate(run);
        else { const input = new PassThrough(); input.once("data", run); setImmediate(() => input.end("request")); }
      `
      // A separate Node process makes unhandled nextTick errors observable even
      // when the parent test runner is executing in a Promise/microtask context.
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
        cwd: process.cwd(), shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
      })
      assert.equal(result.error, undefined)
      assert.equal(result.status, 0, "isolated launcher process must not crash")
      assert.equal(result.signal, null)
      assert.equal(result.stderr.length, 0, "spawn detail must never be logged")
      assert.equal(result.stdout, failure.message)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}

test("async producers cannot return an unprepared Node ChildProcess", () => {
  const unsafe = async (file: string, args: string[], options: import("./native-service-launcher").NativeServiceSpawnOptions) => fixtureSpawn(file, args, options)
  // @ts-expect-error Async children require an observation handoff created before any yield.
  const rejectedContract: SpawnOutsideBackendContainment = unsafe
  assert.equal(typeof rejectedContract, "function") // Type-only probe; never execute it.
})

test("deadline kills only the owned starter handle", async () => {
  let child: ChildProcess | undefined
  let exited: Promise<unknown> | undefined
  const start = createNativeServiceLauncher((file, args, options) => {
    const handle = fixtureSpawn(file, args, options)
    child = handle
    exited = once(handle, "exit")
    return handle
  })
  await assert.rejects(start(request("setInterval(()=>{},1000)"), Date.now() + 300), failure)
  await exited
  assert.ok(child?.signalCode || child?.exitCode !== null)
})

test("even distant deadlines are capped at 30 seconds", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] })
  let child: ChildProcess | undefined
  let exited: Promise<unknown> | undefined
  const start = createNativeServiceLauncher((file, args, options) => {
    const handle = fixtureSpawn(file, args, options)
    child = handle
    exited = once(handle, "exit")
    return handle
  })
  try {
    const result = start(request("setInterval(()=>{},1000)"), Date.now() + 120_000)
    const rejected = assert.rejects(result, failure)
    await once(child!, "spawn")
    context.mock.timers.tick(30_000)
    await rejected
    await exited
  } finally {
    context.mock.timers.reset()
    child?.kill("SIGKILL")
  }
})

test("time spent in native spawn is included in the 30-second cap", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  let child: ChildProcess | undefined
  let exited: Promise<unknown> | undefined
  const start = createNativeServiceLauncher((file, args, options) => {
    const handle = fixtureSpawn(file, args, options)
    child = handle
    exited = once(handle, "exit")
    context.mock.timers.tick(10_000)
    return handle
  })
  try {
    const rejected = assert.rejects(start(request("setInterval(()=>{},1000)"), Date.now() + 120_000), failure)
    await once(child!, "spawn")
    context.mock.timers.tick(20_000)
    await rejected
    await exited
  } finally {
    context.mock.timers.reset()
    child?.kill("SIGKILL")
  }
})

// Launcher contract tests only, not native process/Job attestation.
function ownedStarterControl() {
  const events = new EventEmitter(), stdout = new PassThrough(), stderr = new PassThrough()
  let kills = 0
  const starter: import("./native-service-launcher").OwnedServiceStarter = {
    stdout, stderr, exitCode: null, signalCode: null,
    kill: () => { kills++; return true },
    on: (event, listener) => events.on(event, listener),
    once: (event, listener) => events.once(event, listener),
  }
  return { starter, events, kills: () => kills }
}
test("asynchronous owned starter uses real Readables without a ChildProcess handle", async () => {
  const control = ownedStarterControl()
  const handoff = prepareServiceStarter(control.starter)
  let deliver!: (value: PreparedServiceStarter) => void
  const launcher = createNativeServiceLauncher(() => new Promise(resolve => { deliver = resolve }))
  const result = launcher(request("unused"), Date.now() + 1000)
  deliver(handoff)
  await delay(0)
  control.starter.stdout.push("actual stream bytes")
  control.starter.stdout.push(null)
  control.starter.stderr.push("stderr bytes")
  control.starter.stderr.push(null)
  control.starter.exitCode = 0
  control.events.emit("close", 0)
  assert.deepEqual(await result, { stdout: "actual stream bytes", stderr: "stderr bytes" })
  assert.equal(control.kills(), 0)
  assert.equal("_handle" in control.starter, false)
})
test("prepared async handoff retains pre-handoff failures without their private details", async () => {
  for (const source of ["starter", "stdout", "stderr"] as const) {
    const control = ownedStarterControl()
    const handoff = prepareServiceStarter(control.starter)
    let deliver!: (value: PreparedServiceStarter) => void
    const launcher = createNativeServiceLauncher(() => new Promise(resolve => { deliver = resolve }))
    const result = assert.rejects(launcher(request("unused"), Date.now() + 1000), failure)
    const emitter = source === "starter" ? control.events : control.starter[source]
    emitter.emit("error", new Error("private pre-handoff details"))
    emitter.emit("error", new Error("another private pre-handoff error"))
    deliver(handoff)
    await result
    assert.equal(control.kills(), 1)
    assert.equal(control.starter.stdout.destroyed, true)
    assert.equal(control.starter.stderr.destroyed, true)
  }
})
test("prepared async handoff retains close and drains buffered output before success", async () => {
  const control = ownedStarterControl()
  const handoff = prepareServiceStarter(control.starter)
  control.starter.stdout.push("stdout before handoff")
  control.starter.stdout.push(null)
  control.starter.stderr.push("stderr before handoff")
  control.starter.stderr.push(null)
  control.starter.exitCode = 0
  control.events.emit("close", 0)
  const launcher = createNativeServiceLauncher(async () => handoff)
  assert.deepEqual(await launcher(request("unused"), Date.now() + 1000), {
    stdout: "stdout before handoff", stderr: "stderr before handoff",
  })
  assert.equal(control.kills(), 0)
})

function realPreparedChild(waitFor: "close" | "first-data" = "close") {
  let child: ReturnType<typeof fixtureSpawn> | undefined
  let closed: Promise<unknown> | undefined
  let kills = 0, handedOffAfterClose = false
  const launcher = createNativeServiceLauncher(async (file, args, options) => {
    child = fixtureSpawn(file, args, options)
    const kill = child.kill.bind(child)
    child.kill = signal => { kills++; return kill(signal) }
    closed = once(child, "close")
    const token = prepareServiceStarter(child)
    if (waitFor === "close") { await closed; handedOffAfterClose = true }
    else await once(child.stdout, "data")
    return token
  })
  return {
    launcher, kills: () => kills, handedOffAfterClose: () => handedOffAfterClose,
    async cleanup() {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await closed
    },
  }
}
test("real Node stdio is retained when the async producer awaits child close before handoff", async () => {
  const control = realPreparedChild()
  try {
    const result = await control.launcher(request(`
      process.stdout.write('retained-stdout:'); process.stderr.write('retained-stderr:');
      process.stdout.write(Buffer.from([0xe2])); process.stdout.write(Buffer.from([0x82,0xac]));
      process.stderr.write('ordered-first/'); process.stderr.write('ordered-last');
    `), Date.now() + 5000)
    assert.equal(control.handedOffAfterClose(), true)
    assert.deepEqual(result, { stdout: "retained-stdout:€", stderr: "retained-stderr:ordered-first/ordered-last" })
    assert.equal(control.kills(), 0)
  } finally { await control.cleanup() }
})
test("real pre-handoff stdout and stderr each retain 65536 bytes without an aggregate cap", async () => {
  const control = realPreparedChild()
  try {
    const result = await control.launcher(request("process.stdout.write('a'.repeat(65536)); process.stderr.write('b'.repeat(65536))"), Date.now() + 5000)
    assert.equal(control.handedOffAfterClose(), true)
    assert.equal(result.stdout, "a".repeat(65536))
    assert.equal(result.stderr, "b".repeat(65536))
    assert.equal(control.kills(), 0)
  } finally { await control.cleanup() }
})
for (const stream of ["stdout", "stderr"] as const) {
  test(`real ${stream} at 65537 bytes rejects even when the producer awaits normal script completion`, async () => {
    const control = realPreparedChild()
    try {
      await assert.rejects(control.launcher(request(`process.${stream}.write('x'.repeat(65537))`), Date.now() + 5000), failure)
      assert.equal(control.handedOffAfterClose(), true)
      assert.ok(control.kills() <= 1)
    } finally { await control.cleanup() }
  })
  test(`real pre-handoff ${stream} at 65537 bytes rejects and kills the exact live starter once`, async () => {
    const control = realPreparedChild()
    try {
      // Keep this exact private child live so overflow must terminate its handle,
      // rather than merely observing an already-exited process. No descendants.
      await assert.rejects(control.launcher(request(`process.${stream}.write('x'.repeat(65537)); setInterval(()=>{},1000)`), Date.now() + 5000), failure)
      assert.equal(control.handedOffAfterClose(), true)
      assert.equal(control.kills(), 1)
    } finally { await control.cleanup() }
  })
}
test("real chunks spanning async handoff remain ordered and count once at each stream's cap", async () => {
  const control = realPreparedChild("first-data")
  try {
    const result = await control.launcher(request(`
      process.stdout.write('a'.repeat(32768)); process.stderr.write('b'.repeat(32768));
      setTimeout(()=>{process.stdout.write('c'.repeat(32768)); process.stderr.write('d'.repeat(32768))},100);
    `), Date.now() + 5000)
    assert.deepEqual(result, { stdout: "a".repeat(32768) + "c".repeat(32768), stderr: "b".repeat(32768) + "d".repeat(32768) })
    assert.equal(control.kills(), 0)
  } finally { await control.cleanup() }
})
test("prepared observation handoffs are single-use", async () => {
  const control = ownedStarterControl()
  const handoff = prepareServiceStarter(control.starter)
  control.events.emit("error", new Error("private failure"))
  const launcher = createNativeServiceLauncher(async () => handoff)
  await assert.rejects(launcher(request("unused"), Date.now() + 1000), failure)
  await assert.rejects(launcher(request("unused"), Date.now() + 1000), failure)
  assert.equal(control.kills(), 1)
})
test("a copied handoff token is not an observed prepared starter", async () => {
  const control = ownedStarterControl()
  const handoff = prepareServiceStarter(control.starter)
  const launcher = createNativeServiceLauncher(async () => ({ ...handoff }))
  await assert.rejects(launcher(request("unused"), Date.now() + 1000), failure)
  assert.equal(control.kills(), 0) // No ownership is acquired from an unregistered token.
  control.starter.stdout.destroy()
  control.starter.stderr.destroy()
})
test("pending async preparation times out and a late owned starter is killed once", async context => {
  context.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const control = ownedStarterControl()
  const handoff = prepareServiceStarter(control.starter)
  let deliver!: (value: PreparedServiceStarter) => void
  const launcher = createNativeServiceLauncher(() => new Promise(resolve => { deliver = resolve }))
  try {
    const rejected = assert.rejects(launcher(request("unused"), Date.now() + 100), failure)
    context.mock.timers.tick(100)
    await rejected
    deliver(handoff)
    await Promise.resolve()
    assert.equal(control.kills(), 1)
    assert.equal(control.starter.stdout.destroyed, true)
    assert.equal(control.starter.stderr.destroyed, true)
  } finally { context.mock.timers.reset() }
})
test("an async starter rejection is redacted and never retried", async () => {
  let calls = 0
  const launcher = createNativeServiceLauncher(async () => { calls++; throw new Error("private details") })
  await assert.rejects(launcher(request("unused"), Date.now() + 1000), failure)
  assert.equal(calls, 1)
})

test("private starter and daemon survive cleanup of the owned backend handle/group", { timeout: 20_000 }, async () => {
  const root = await fixtureRoot()
  const ready = join(root, "port")
  const backend = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: process.platform !== "win32", stdio: "ignore" })
  const backendExited = once(backend, "exit")
  let starter: ChildProcess | undefined
  let starterExited: Promise<unknown> | undefined
  let port: number | undefined
  async function query(value: string) {
    const socket = createConnection({ host: "127.0.0.1", port: port! })
    socket.setTimeout(1000, () => socket.destroy(new Error("private fixture timeout")))
    try {
      await once(socket, "connect")
      socket.end(value)
      let output = ""
      for await (const chunk of socket) output += chunk
      return output
    } finally { socket.destroy() }
  }
  const start = createNativeServiceLauncher((file, args, options) => {
    const handle = fixtureSpawn(file, args, options)
    starter = handle
    starterExited = once(handle, "exit")
    return handle
  })
  try {
    await once(backend, "spawn")
    const daemon = `const fs=require('fs'), net=require('net');
      const server=net.createServer(s=>s.once('data',d=>{if(d.toString()==='private-stop')process.exit(0);s.end('private-alive')}));
      server.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(ready)},String(server.address().port)));
      setTimeout(()=>process.exit(0),12000);`
    // On POSIX the daemon inherits the starter's group, not the backend's. On
    // Windows this tests only separate ancestry/handle cleanup, NOT Job escape.
    // Keep the starter alive to prove both survive backend-only cleanup.
    // Windows Node otherwise gives its child a libuv-owned kill-on-close Job;
    // mimic the CLI's independent daemon rather than claiming Job attestation.
    const result = start(request(`const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(daemon)}],{detached:process.platform==='win32',stdio:'ignore'});child.unref();setInterval(()=>{},1000)`), Date.now() + 8_000)
    const rejected = assert.rejects(result, failure)
    const until = Date.now() + 4_000
    while (!port && Date.now() < until) {
      port = Number(await readFile(ready, "utf8").catch(() => "")) || undefined
      if (!port) await delay(10)
    }
    assert.ok(port)
    assert.equal(await query("health"), "private-alive")
    // The POSIX negative PID is solely the detached fixture handle's group;
    // no process discovery, shared daemon, or user tree is involved. Windows
    // deliberately makes no assertion about native Job containment here.
    if (process.platform === "win32") backend.kill("SIGKILL")
    else process.kill(-backend.pid!, "SIGKILL")
    await backendExited
    assert.equal(starter?.exitCode, null)
    assert.equal(starter?.signalCode, null)
    assert.equal(await query("health"), "private-alive")
    // Launcher timeout stops only its starter, leaving the daemon untouched.
    await rejected
    await starterExited
    assert.equal(await query("health"), "private-alive")
  } finally {
    if (port) await query("private-stop").catch(() => undefined)
    starter?.kill("SIGKILL")
    backend.kill("SIGKILL")
    await backendExited
    await starterExited
    await rm(root, { recursive: true, force: true })
  }
})
