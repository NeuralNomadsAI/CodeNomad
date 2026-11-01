// Electron main-process fixture for remote-recovery.test.ts: real preload, real IPC handlers.
import { app, BrowserWindow } from "electron"
import { writeFileSync } from "node:fs"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { setupCliIPC } from "./ipc"
import { RemoteRecoveryPages, showRemoteUnavailable } from "./remote-recovery"
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

// "/" is the server's own document; "/no-content" answers 204, so a retry commits no document.
const server = http.createServer((request, response) => {
  if (request.url === "/no-content") { response.writeHead(204); response.end(); return }
  response.writeHead(200, { "Content-Type": "text/html" })
  response.end("<!doctype html><title>Remote server</title><body>Remote-controlled content</body>")
})

// Runs in the page: each named recovery action with `token`, reporting which ones the host refused.
const attempt = (token: string | null, names = ["openLocalWindow", "retryRemoteWindow"]) => `(async () => {
  const results = {}
  for (const name of ${JSON.stringify(names)}) {
    try { await window.electronAPI[name](${JSON.stringify(token)}); results[name] = "allowed" } catch { results[name] = "refused" }
  }
  return results
})()`
const tokenOf = (url: string) => new URL(url).hash.split("=")[1] ?? null
const refused = (token: string | null) => attempt(token)

// The step in progress, reported if the fixture stalls.
let step = "starting"
const timer = setTimeout(() => { writeFileSync(resultPath, JSON.stringify({ error: `timeout during: ${step}` })); app.exit(2) }, 40_000)

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
  const navigate = async () => { counts.retried++; await window.loadURL(`${remoteUrl}no-content`) }
  const show = () => showRemoteUnavailable(recovery, window, { file: loadingFile }, navigate)
  // Waits until another document than `previous` has finished loading.
  const nextDocument = async (previous: string) => {
    for (let waited = 0; waited < 10_000; waited += 50) {
      if (page.getURL() !== previous && !page.isLoading()) return page.getURL()
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`no new document after ${previous}`)
  }

  // 1. The remote server's own document pretends to be the recovery page.
  step = "1 spoof"
  await window.loadURL(remoteUrl)
  result.spoofWithoutToken = await page.executeJavaScript(`history.replaceState(null, "", "/loading.html#remote-unavailable=guess"); ${refused("guess")}`)

  // 2. The host's recovery document; Try again reaches a 204, which commits nothing.
  step = "2 failed retry"
  await show()
  const first = page.getURL()
  result.hostWrongToken = await page.executeJavaScript(refused("not-the-token"))
  await page.executeJavaScript(`window.__firstDocument = true; window.electronAPI.retryRemoteWindow(${JSON.stringify(tokenOf(first))}); null`)
  const second = await nextDocument(first)
  result.afterFailedRetry = {
    newDocument: await page.executeJavaScript("window.__firstDocument !== true"),
    newToken: tokenOf(second) !== tokenOf(first),
    oldToken: await page.executeJavaScript(attempt(tokenOf(first), ["openLocalWindow"])),
    openLocalWindow: await page.executeJavaScript(attempt(tokenOf(second), ["openLocalWindow"])),
  }
  await page.executeJavaScript(`window.electronAPI.retryRemoteWindow(${JSON.stringify(tokenOf(second))}); null`)
  const third = await nextDocument(second)
  result.countsAfterRetries = { ...counts }

  // 3. Leaving for the server's document revokes the token, even replayed in a spoofed URL.
  step = "3 revoked spoof"
  await window.loadURL(remoteUrl)
  result.spoofWithRevokedToken = await page.executeJavaScript(`history.replaceState(null, "", ${JSON.stringify(new URL(third).pathname + new URL(third).search + new URL(third).hash)}); ${refused(tokenOf(third))}`)

  // 4. Reloading the recovery document revokes its token and shows a fresh document.
  step = "4 reload"
  await show()
  const beforeReload = page.getURL()
  page.reload()
  const afterReload = await nextDocument(beforeReload)
  result.afterReload = {
    oldToken: await page.executeJavaScript(attempt(tokenOf(beforeReload), ["openLocalWindow"])),
    newToken: await page.executeJavaScript(attempt(tokenOf(afterReload), ["openLocalWindow"])),
  }

  // 5. A renderer crash revokes the token and reloads nothing; the user's reload then shows a fresh
  //    document whose actions work, while the crashed token stays refused.
  step = "5 crash"
  let commits = 0
  page.on("did-navigate", () => { commits++ })
  const gone = new Promise((resolve) => page.once("render-process-gone", () => resolve(undefined)))
  page.forcefullyCrashRenderer()
  await gone
  await new Promise((resolve) => setTimeout(resolve, 300))
  const commitsBeforeReload = commits
  step = "5 reload after crash"
  page.reload()
  const afterCrash = await nextDocument(afterReload)
  result.afterCrash = {
    automaticReloads: commitsBeforeReload,
    newToken: tokenOf(afterCrash) !== tokenOf(afterReload),
    oldToken: await page.executeJavaScript(refused(tokenOf(afterReload))),
    openLocalWindow: await page.executeJavaScript(attempt(tokenOf(afterCrash), ["openLocalWindow"])),
  }
  const retriesBefore = counts.retried
  await page.executeJavaScript(`window.electronAPI.retryRemoteWindow(${JSON.stringify(tokenOf(afterCrash))}); null`)
  await nextDocument(afterCrash)
  result.afterCrashRetries = counts.retried - retriesBefore
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
