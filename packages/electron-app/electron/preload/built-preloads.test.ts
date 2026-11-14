import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

test("built preloads run autonomously in sandboxed guests and preserve application context fences", {
  timeout: 60_000,
}, async t => {
  const scratch = mkdtempSync(join(tmpdir(), "codenomad-built-preloads-"))
  try {
    const resultFile = join(scratch, "result.json")
    const preloads = process.env.CODENOMAD_TEST_BUILT_PRELOADS ?? fileURLToPath(new URL("../../dist/preload", import.meta.url))
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.NODE_OPTIONS
    let output = ""
    const status = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      const child = spawn(createRequire(import.meta.url)("electron"), [
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        fileURLToPath(new URL("./built-preloads.electron-fixture.cjs", import.meta.url)), scratch, resultFile, preloads,
      ], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      const keep = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-8000) }
      child.stdout.on("data", keep)
      child.stderr.on("data", keep)
      const timer = setTimeout(() => child.kill(), 45_000)
      child.once("error", error => { clearTimeout(timer); reject(error) })
      child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    })
    const diagnostic = `Electron exit=${status.code} signal=${status.signal}\n${output}`
    t.diagnostic(diagnostic)
    assert.equal(status.code, 0, diagnostic)
    assert.ok(existsSync(resultFile), `Electron did not write ${resultFile}\n${diagnostic}`)
    const result = JSON.parse(readFileSync(resultFile, "utf8"))
    t.diagnostic(JSON.stringify(result))
    assert.equal(result.error, undefined, output)
    assert.deepEqual(result.errors, [], output)
    assert.equal(result.hidden, true)
    assert.deepEqual(result.security, Array.from({ length: 4 }, () => ({
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    })))
    assert.deepEqual(result.remote, {
      copyAllowed: false, printConfigurable: false, prompt: "function", appBridge: "undefined", node: "undefined", promptResult: "native answer",
    })
    assert.deepEqual(result.local, {
      copyAllowed: true, printConfigurable: true, prompt: "function", appBridge: "undefined", node: "undefined", promptResult: "native answer",
    })
    assert.deepEqual(result.contexts, ["local", "preferences", "remote"].map(context => ({
      context, host: "electron", bridge: "object", node: "undefined",
      localAction: context === "local" ? "function" : "undefined",
      preferencesAction: context === "preferences" ? "function" : "undefined",
      remoteAction: context === "remote" ? "function" : "undefined",
    })))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
