// Private Windows fixture only. Retain one validated native process handle through exit.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { tsImport } from "tsx/esm/api"

export async function lookupManagedIdentity(pid) {
  const { lookupProcess } = await tsImport(new URL("../../packages/server/src/host-lifetime/process-identity.ts", import.meta.url).href, import.meta.url)
  const state = await lookupProcess(pid)
  assert.equal(state.state, "live", "Managed identity unknown; no stop authorized")
  assert.match(state.startIdentity, /^win32:\d+$/)
  return state.startIdentity
}

export function exitHandleAcknowledged(proof, nonce) {
  return proof?.kind === "managed-exit-handle" && proof.nonce === nonce && proof.readyObserved === true
    && proof.sameHandleExitObserved === true && proof.watcherClosed === true && proof.watcherExitCode === 0
    && Number.isSafeInteger(proof.pid) && proof.pid > 0 && /^win32:\d+$/.test(proof.startIdentity)
    && typeof proof.executable === "string" && path.isAbsolute(proof.executable)
}

export async function captureManagedExit({ pid, startIdentity, executable, nonce, timeoutMs = 30_000 }) {
  assert.equal(process.platform, "win32")
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  assert.match(startIdentity, /^win32:\d+$/)
  assert.match(nonce, /^[a-f0-9-]{36}$/)
  assert.ok(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 290_000)
  executable = await realpath(executable)
  const powershell = await realpath(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"))
  const input = Buffer.from(JSON.stringify({ pid, startIdentity, executable, nonce, timeoutMs })).toString("base64")
  const script = `$ErrorActionPreference='Stop'; $p=$null
function Emit($kind) { [Console]::Out.WriteLine((@{kind=$kind;pid=$a.pid;nonce=$a.nonce;startIdentity=$a.startIdentity;executable=$a.executable}|ConvertTo-Json -Compress)); [Console]::Out.Flush() }
try {
  $a=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${input}'))|ConvertFrom-Json
  $p=[Diagnostics.Process]::GetProcessById([int]$a.pid)
  $handle=$p.Handle
  if ($handle -eq [IntPtr]::Zero -or $p.Id -ne $a.pid -or $p.HasExited) { throw 'identity' }
  if (('win32:'+$p.StartTime.ToUniversalTime().Ticks.ToString()) -cne $a.startIdentity) { throw 'identity' }
  if (-not [String]::Equals($p.MainModule.FileName,$a.executable,[StringComparison]::OrdinalIgnoreCase)) { throw 'identity' }
  Emit 'ready'
  if (-not $p.WaitForExit([int]$a.timeoutMs)) { Emit 'deadline'; exit 3 }
  Emit 'exited'
} catch { if ($null -ne $a) { Emit 'refused' }; exit 2 }
finally { if ($null -ne $p) { $p.Dispose() } }`
  let readyResolve, readyReject, exitResolve, exitReject, readySeen = false, exitSeen = false, bytes = "", closed = false
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const exited = new Promise((resolve, reject) => { exitResolve = resolve; exitReject = reject })
  ready.catch(() => {}); exited.catch(() => {})
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  const proof = { kind: "managed-exit-handle", pid, startIdentity, executable, nonce, watcherPID: child.pid,
    readyObserved: false, sameHandleExitObserved: false, watcherClosed: false }
  const fail = code => { const error = Object.assign(new Error(code), { code }); readyReject(error); exitReject(error) }
  const timer = setTimeout(() => { fail("managed-witness-watchdog"); child.kill() }, timeoutMs + 10_000)
  const done = new Promise(resolve => child.once("close", code => {
    closed = true; clearTimeout(timer)
    proof.watcherClosed = true; proof.watcherExitCode = code; proof.watcherClosedAt = Date.now()
    if (readySeen && exitSeen && code === 0) exitResolve(proof)
    else fail("managed-witness-closed-without-exit-ack")
    resolve()
  }))
  child.once("error", () => fail("managed-witness-launch-refused"))
  child.stderr.on("data", () => {}) // Drain native diagnostics without logging bodies.
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", chunk => {
    try {
      bytes += chunk; assert.ok(bytes.length <= 16_384)
      let end
      while ((end = bytes.indexOf("\n")) !== -1) {
        const event = JSON.parse(bytes.slice(0, end)); bytes = bytes.slice(end + 1)
        assert.equal(event.nonce, nonce); assert.equal(event.pid, pid); assert.equal(event.startIdentity, startIdentity)
        assert.equal(path.resolve(event.executable).toLowerCase(), executable.toLowerCase())
        if (event.kind === "ready") {
          assert.equal(readySeen, false); readySeen = true; proof.readyObserved = true; proof.readyAt = Date.now(); readyResolve(proof)
        } else if (event.kind === "exited") {
          assert.equal(readySeen, true); assert.equal(exitSeen, false); exitSeen = true
          proof.sameHandleExitObserved = true; proof.exitedAt = Date.now()
        } else fail(`managed-witness-${event.kind === "deadline" ? "deadline" : "identity-refused"}`)
      }
    } catch { fail("managed-witness-protocol-refused"); child.kill() }
  })
  return { ready, exited, async close() { if (!closed) child.kill(); await done } }
}
