import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const electronBinary = createRequire(import.meta.url)("electron") as string
const headless = process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY

test("only the host's own unavailable-server document reaches the remote recovery actions (real Electron IPC)", { skip: headless ? "no display" : false, timeout: 60_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "codenomad-remote-recovery-"))
  try {
    const resultPath = join(scratch, "result.json")
    const environment: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: "--import tsx" }
    delete environment.ELECTRON_RUN_AS_NODE
    const args = [
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      join(here, "remote-recovery.electron-fixture.ts"),
      scratch, resultPath, join(here, "../preload/index.cjs"),
    ]
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(electronBinary, args, { env: environment, windowsHide: true, stdio: "ignore" })
      // A fixture that cannot start (Electron keeps its error dialog open) must not outlive the test.
      const deadline = setTimeout(() => child.kill(), 45_000)
      child.once("error", (error) => { clearTimeout(deadline); reject(error) })
      child.once("exit", (code) => { clearTimeout(deadline); resolve(code) })
    })
    const result = JSON.parse(readFileSync(resultPath, "utf8"))
    assert.equal(result.error, undefined, result.error)
    assert.equal(exitCode, 0)

    const refused = { openLocalWindow: "refused", retryRemoteWindow: "refused" }
    // A remote document rewriting its URL with the History API stays the remote document.
    assert.deepEqual(result.spoofWithoutToken, refused)
    assert.deepEqual(result.hostWrongToken, refused)
    // A Try again that commits no document (HTTP 204) shows a fresh recovery document with a new
    // token, whose actions still work exactly once each; the previous token is gone.
    assert.deepEqual(result.afterFailedRetry, {
      newDocument: true, newToken: true,
      oldToken: { openLocalWindow: "refused" }, openLocalWindow: { openLocalWindow: "allowed" },
    })
    assert.deepEqual(result.countsAfterRetries, { opened: 1, retried: 2 })
    // Leaving the recovery document revokes its token, and the server's origin never qualifies.
    assert.deepEqual(result.spoofWithRevokedToken, refused)
    // A reload revokes the token and the host shows a fresh document.
    assert.deepEqual(result.afterReload, { oldToken: { openLocalWindow: "refused" }, newToken: { openLocalWindow: "allowed" } })
    // A crash revokes the token for good and reloads nothing by itself; the user's reload afterwards
    // shows a fresh document whose actions work exactly once.
    assert.deepEqual(result.afterCrash, {
      automaticReloads: 0, newToken: true, oldToken: refused, openLocalWindow: { openLocalWindow: "allowed" },
    })
    assert.equal(result.afterCrashRetries, 1)
    assert.deepEqual(result.counts, { opened: 3, retried: 3 })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
