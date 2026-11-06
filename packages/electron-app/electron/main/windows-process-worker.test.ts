import assert from "node:assert/strict"
import childProcess, { spawn } from "node:child_process"
import { once } from "node:events"
import { registerHooks, syncBuiltinESMExports } from "node:module"
import test from "node:test"
import { captureProcessTree, forceCapturedProcessTree, runCommand } from "./process-stop"
import { windowsCimProcessTreeScript, windowsManagedTerminateScript } from "./windows-process-fallback"
import { windowsNativeProcesses } from "./windows-process-tree"
import { WindowsProcessWorker } from "./windows-process-worker"
import { getProcessStartIdentityAsync } from "./client-state-process-identity"

const windows = { skip: process.platform !== "win32", timeout: 45_000 }

// The review reproduction: await real readiness/baseline or worker exit, rather
// than sleeps/retries. The fixture deliberately requires final enforcement.
for (const constrained of [false, true]) {
  test(`manager confirms shutdown after ${constrained ? "native compilation fails under ConstrainedLanguage" : "its worker exits"}`, windows, async () => {
    const originalSpawn = childProcess.spawn
    const originalExecFile = childProcess.execFile
    const hooks = registerHooks({ resolve(specifier, context, next) {
      return specifier === "electron"
        ? { shortCircuit: true, url: "data:text/javascript,export const app={isPackaged:false,getAppPath(){return ''}}" }
        : next(specifier, context)
    } })
    const constrain = (args: readonly string[]) => [...args.slice(0, -1), "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';\n" + args.at(-1)]
    childProcess.spawn = ((command, args, options) => {
      if (command === "powershell.exe") {
        args = constrained ? constrain(args!) : [...args!.slice(0, -1), "[Console]::ReadLine() | Out-Null;\n" + args!.at(-1)]
      }
      return originalSpawn(command, args!, { ...options, windowsHide: true })
    }) as typeof spawn
    // Enforce CLM in the fallback too, as an actual system policy would.
    childProcess.execFile = ((command: string, args: string[], ...rest: any[]) =>
      (originalExecFile as any)(command, constrained && command === "powershell.exe" ? constrain(args) : args, ...rest)) as typeof originalExecFile
    syncBuiltinESMExports()
    const { CliProcessManager } = await import("./process-manager")
    const manager = new CliProcessManager() as any
    manager.on("error", () => {})
    manager.resolveCliEntry = async () => ({ entry: "worker-failure-fixture", runner: "node", nodeBinaryPath: process.execPath })
    manager.buildDirectSpawn = () => ({ command: process.execPath, args: ["-e", `
      console.log('Local Connection URL : http://127.0.0.1:54321');
      process.stdin.on('data', data => {
        if (!String(data).includes('fixture:spawn')) return;
        const nested = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
          {windowsHide:true,detached:true,stdio:'ignore'});
        console.log('FIXTURE_NESTED:'+nested.pid);
      });
      setInterval(()=>{},1000);
    `] })
    let child: childProcess.ChildProcess | undefined
    let exited: Promise<unknown> | undefined
    let nestedPid: number | undefined
    let nestedIdentity: string | undefined
    try {
      assert.equal((await manager.start({ dev: false })).state, "ready")
      child = manager.child
      assert.ok(child?.pid)
      exited = once(child, "exit")
      if (!constrained) {
        // Startup already returned while the helper is held before compilation.
        manager.processWorker.child.stdin.write("\n")
      }
      const tree = await manager.initialProcessTree
      assert.ok(tree, "startup/background capture must retain a usable baseline")
      const nested = new Promise<number>(resolve => {
        const onLog = ({ message }: { message: string }) => {
          const match = message.match(/^FIXTURE_NESTED:(\d+)$/)
          if (match) { manager.off("log", onLog); resolve(Number(match[1])) }
        }
        manager.on("log", onLog)
      })
      child.stdin!.write("fixture:spawn\n")
      nestedPid = await nested
      nestedIdentity = await getProcessStartIdentityAsync(nestedPid, 10_000)
      assert.ok(nestedIdentity)
      assert.ok(!manager.capturedProcessTree.members.some(({ pid }: { pid: number }) => pid === nestedPid),
        "the detached descendant must postdate the retained snapshot")
      if (!constrained) {
        const workerExited = once(manager.processWorker.child, "exit")
        manager.processWorker.child.kill()
        await workerExited
        // Only the first worker is gated; its replacement must run normally.
        childProcess.spawn = originalSpawn
        syncBuiltinESMExports()
      }
      const started = Date.now()
      await manager.shutdown()
      await exited
      assert.ok(Date.now() - started < 30_000, "confirmation must fit the original absolute deadline")
      for (const { pid } of tree.members) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
      assert.throws(() => process.kill(nestedPid!, 0), { code: "ESRCH" }, "successful shutdown must stop the late detached descendant")
    } finally {
      manager.processWorker?.dispose()
      clearTimeout(manager.processTreeRefresh)
      if (nestedPid && nestedIdentity && await getProcessStartIdentityAsync(nestedPid, 10_000) === nestedIdentity) {
        try { process.kill(nestedPid, "SIGKILL") } catch {}
      }
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      await exited
      childProcess.spawn = originalSpawn
      childProcess.execFile = originalExecFile
      syncBuiltinESMExports()
      hooks.deregister()
    }
  })
}

test("a timed-out worker is replaced on the next request", windows, async (context) => {
  const worker = new WindowsProcessWorker() as any
  try {
    assert.ok(await captureProcessTree(process.pid, "win32", worker.run, 15_000))
    const child = worker.child
    const exited = once(child, "exit")
    context.mock.timers.enable({ apis: ["setTimeout"] })
    const pending = worker.run("powershell.exe", [windowsNativeProcesses + "[Console]::ReadLine()"], { timeout: 1_000, encoding: "utf8" })
    await Promise.resolve()
    context.mock.timers.tick(1_000)
    assert.notEqual((await pending).status, 0)
    context.mock.timers.reset()
    await exited
    assert.ok(await captureProcessTree(process.pid, "win32", worker.run, 15_000))
    assert.notEqual(worker.child.pid, child.pid)
  } finally {
    context.mock.timers.reset()
    worker.dispose()
  }
})

test("native timeout leaves only the remaining absolute budget for fallback", windows, async (context) => {
  const worker = new WindowsProcessWorker() as any
  const originalExecFile = childProcess.execFile
  try {
    assert.ok(await captureProcessTree(process.pid, "win32", worker.run, 15_000))
    const exited = once(worker.child, "exit")
    let fallbackTimeout: number | undefined
    childProcess.execFile = ((_command: string, _args: string[], options: { timeout: number }, done: Function) => {
      fallbackTimeout = options.timeout
      done(null, "confirmed", "")
    }) as any
    syncBuiltinESMExports()
    context.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() })
    const pending = worker.run("powershell.exe", [windowsNativeProcesses + "[Console]::ReadLine()"], {
      timeout: 3_000, encoding: "utf8", windowsNativeReadyOnly: true, windowsFallbackScript: "'confirmed'",
    })
    await Promise.resolve()
    context.mock.timers.tick(1_000)
    assert.equal((await pending).stdout, "confirmed")
    assert.equal(fallbackTimeout, 2_000)
    context.mock.timers.reset()
    await exited
  } finally {
    context.mock.timers.reset()
    childProcess.execFile = originalExecFile
    syncBuiltinESMExports()
    worker.dispose()
  }
})

test("CLM fallback retains exact identities, rejects a one-tick mismatch and confirms nested children", windows, async () => {
  const child = spawn(process.execPath, ["-e", `
    const {spawn}=require('child_process');
    const nested=spawn(process.execPath,['-e',"process.stdout.write('ready');setInterval(()=>{},1000)"],{windowsHide:true,stdio:['ignore','pipe','ignore']});
    nested.stdout.once('data',()=>process.stdout.write(String(nested.pid)));
    setInterval(()=>{},1000);
  `], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] })
  const exited = once(child, "exit")
  const worker = new WindowsProcessWorker()
  let nestedPid: number | undefined
  const clm = (script: string, timeout = 15_000) => runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "$ExecutionContext.SessionState.LanguageMode='ConstrainedLanguage';\n" + script], { encoding: "utf8", windowsHide: true, timeout })
  try {
    nestedPid = Number(String((await once(child.stdout!, "data"))[0]))
    assert.ok(nestedPid)
    const tree = await captureProcessTree(child.pid!, "win32", worker.run, 15_000)
    assert.ok(tree)
    assert.ok(tree.members.some(({ pid }) => pid === nestedPid))
    const captured = await clm(windowsCimProcessTreeScript(child.pid!))
    assert.equal(captured.status, 0, captured.stderr)
    for (const member of tree.members) assert.ok(captured.stdout.includes(`|${member.startIdentity}`), "CIM fallback must retain native precision")
    const root = tree.members.find(({ pid }) => pid === child.pid)!
    const mismatch = await clm(windowsManagedTerminateScript([{ ...root, startIdentity: `win32:${BigInt(root.startIdentity.slice(6)) + 1n}` }]))
    assert.equal(mismatch.stdout.trim(), "confirmed", mismatch.stderr)
    assert.doesNotThrow(() => process.kill(child.pid!, 0))
    assert.doesNotThrow(() => process.kill(nestedPid!, 0), "a reused root cannot authorize fresh descendants")
    const unavailable = await clm("function Get-CimInstance { throw 'inventory unavailable' };\n" + windowsManagedTerminateScript(tree.members))
    assert.notEqual(unavailable.status, 0)
    assert.doesNotMatch(unavailable.stdout, /confirmed/)
    for (const { pid } of tree.members) assert.doesNotThrow(() => process.kill(pid, 0), "a failed refresh must precede any termination")
    // A native capture can be enforced by the fallback inside the same reserve.
    const deadlineAt = Date.now() + 5_000
    assert.equal(await forceCapturedProcessTree(tree, undefined, (_command, _args, options) => {
      assert.ok(options.windowsFallbackScript)
      assert.match(options.windowsFallbackScript, /Get-CimInstance/)
      assert.doesNotMatch(options.windowsFallbackScript, /Add-Type|Stop-Process -Id/)
      return clm(options.windowsFallbackScript, options.timeout)
    }, process.kill, { deadlineAt }), true)
    await exited
    for (const { pid } of tree.members) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  } finally {
    worker.dispose()
    if (nestedPid) { try { process.kill(nestedPid, "SIGKILL") } catch {} }
    child.kill("SIGKILL")
    await exited
  }
})
