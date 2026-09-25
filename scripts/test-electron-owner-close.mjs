import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

// Real native destruction order, isolated from the desktop profile and backend.
const root = fileURLToPath(new URL("../", import.meta.url))
const require = createRequire(new URL("../packages/electron-app/package.json", import.meta.url))
const directory = await mkdtemp(join(tmpdir(), "codenomad-owner-close-"))
try {
  const entry = join(directory, "fixture.mjs")
  await build({
    stdin: { resolveDir: root, sourcefile: "owner-close-fixture.ts", loader: "ts", contents: `
      import assert from "node:assert/strict"
      import { app, BrowserWindow } from "electron"
      import { BrowserController } from "./packages/electron-app/electron/main/browser-controller"
      import { MultiwindowLifecycle } from "./packages/electron-app/electron/main/multiwindow-lifecycle"
      process.on("uncaughtException", error => { console.error(error); app.exit(1) })
      process.on("unhandledRejection", error => { console.error(error); app.exit(1) })
      void app.whenReady().then(async () => {
      const controller = new BrowserController(() => {})
      let closed = 0
      const makeWindow = () => {
        const window = new BrowserWindow({ show: false })
        controller.observeOwner(window)
        window.on("closed", () => {
          assert.equal(window.isDestroyed(), true)
          // Demonstrates why reading this getter inside the old callback failed.
          assert.throws(() => window.webContents, /Object has been destroyed/)
          closed++
        })
        return window
      }
      const last = makeWindow()
      const destroyed = makeWindow()
      destroyed.destroy()
      const ordinary = makeWindow()
      const ordinaryClosed = new Promise(resolve => ordinary.once("closed", resolve))
      ordinary.close()
      await ordinaryClosed
      assert.equal(closed, 2)
      const lifecycle = new MultiwindowLifecycle({
        app, getLocalWindows: () => [], getAllWindows: () => BrowserWindow.getAllWindows(),
        clientStateManager: { isPrimary: false, flush: async () => {}, drainAndReleasePrimary: async () => {} },
        cliManager: { shutdown: async () => {} }, removeWindowState: async () => true,
        getAllowedRendererOrigins: () => [], isTrustedRendererOrigin: () => false,
      })
      lifecycle.attachRemote(last)
      lifecycle.registerAppEvents()
      app.on("quit", () => {
        assert.equal(closed, 3)
        console.log("PASS: destroy, ordinary close and final lifecycle exit")
      })
      last.close()
      })
    ` },
    outfile: entry, bundle: true, platform: "node", format: "esm", external: ["electron"], logLevel: "silent",
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require("electron"), [entry, `--user-data-dir=${join(directory, "profile")}`], { env, stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", data => { output += data })
  child.stderr.on("data", data => { output += data })
  const timeout = setTimeout(() => child.kill(), 30_000)
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve) }).finally(() => clearTimeout(timeout))
  assert.equal(code, 0, output)
  assert.match(output, /PASS: destroy, ordinary close and final lifecycle exit/)
  console.log("Real Electron owner-close regression passed.")
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
