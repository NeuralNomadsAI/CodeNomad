// Electron main-process fixture for remote-recovery.test.ts: real preload, real IPC handlers.
import { app, BrowserWindow } from "electron"
import { writeFileSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { setupCliIPC } from "./ipc"
import { RemoteRecoveryPages } from "./remote-recovery"
import { RemoteWindowRegistry } from "./remote-window-registry"

const [scratch, resultPath, preloadPath] = process.argv.slice(-3)
app.setPath("userData", join(scratch, "user-data"))

const remoteWindows = new RemoteWindowRegistry(() => {})
const recovery = new RemoteRecoveryPages()
const counts = { opened: 0, retried: 0 }
setupCliIPC({} as never, {
  resolveLocal: () => undefined,
  getAllowedOrigins: () => [],
  openRemoteWindow: async () => {}, newWindow: async () => {},
  // The same expression as main.ts.
  resolveRemoteRecovery: (event, token) => remoteWindows.resolve(event.sender) ? recovery.authorize(event, token) : undefined,
  openLocalWindow: async () => { counts.opened++ },
  nextFolder: () => null, acknowledgeFolder: () => {},
  nextConnection: () => null, acknowledgeConnection: () => {},
  browserController: {} as never,
})

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" })
  response.end("<!doctype html><title>Remote server</title><body>Remote-controlled content</body>")
})

// Runs in the page: both recovery actions with `token`, reporting which ones the host refused.
const attempt = (token: string | null) => `(async () => {
  const results = {}
  for (const name of ["openLocalWindow", "retryRemoteWindow"]) {
    try { await window.electronAPI[name](${JSON.stringify(token)}); results[name] = "allowed" } catch { results[name] = "refused" }
  }
  return results
})()`

const timer = setTimeout(() => { writeFileSync(resultPath, JSON.stringify({ error: "timeout" })); app.exit(2) }, 25_000)

app.whenReady().then(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const remoteUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const loadingFile = join(scratch, "loading.html")
  writeFileSync(loadingFile, "<!doctype html><title>Loading</title><body>Unavailable</body>")
  const window = new BrowserWindow({
    show: false,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, additionalArguments: ["--codenomad-window-context=remote"] },
  })
  remoteWindows.register("server", window)
  const page = window.webContents
  const result: Record<string, unknown> = {}

  // 1. The remote server's own document pretends to be the recovery page.
  await window.loadURL(remoteUrl)
  result.spoofWithoutToken = await page.executeJavaScript(`history.replaceState(null, "", "/loading.html#remote-unavailable=guess"); ${attempt("guess")}`)

  // 2. The host's own recovery document, with the token it issued and with another one.
  let retried = false
  const fragment = recovery.issue(page, async () => { counts.retried++; retried = true })
  const token = fragment.slice(fragment.indexOf("=") + 1)
  await window.loadFile(loadingFile, { hash: fragment })
  result.hostWrongToken = await page.executeJavaScript(attempt("not-the-token"))
  result.hostDocument = await page.executeJavaScript(attempt(token))
  result.retried = retried

  // 3. Back on the server's document, even the leaked real token in a spoofed URL is refused.
  await window.loadURL(remoteUrl)
  result.spoofWithRevokedToken = await page.executeJavaScript(`history.replaceState(null, "", "/loading.html#${fragment}"); ${attempt(token)}`)
  result.counts = counts

  writeFileSync(resultPath, JSON.stringify(result))
  clearTimeout(timer)
  window.destroy()
  server.close()
  app.exit(0)
}).catch((error: unknown) => {
  writeFileSync(resultPath, JSON.stringify({ error: String((error as Error)?.stack ?? error) }))
  app.exit(1)
})
