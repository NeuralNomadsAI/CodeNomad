const { app, BrowserWindow, WebContentsView, ipcMain, session } = require("electron")
const http = require("node:http")
const { join } = require("node:path")
const { writeFileSync } = require("node:fs")

const [scratch, resultFile, preloads] = process.argv.slice(2)
app.setPath("userData", join(scratch, "profile"))
const errors = []
const windows = []
const inspect = `({
  copyAllowed: window.dispatchEvent(new Event("copy", { cancelable: true })),
  printConfigurable: Object.getOwnPropertyDescriptor(window, "print")?.configurable,
  prompt: typeof window.prompt, appBridge: typeof window.electronAPI,
  node: typeof window.require
})`
const server = http.createServer((_request, response) => response.end(
  `<!doctype html><script>window.atDocumentStart = ${inspect}</script><h1>Built preload</h1>`))

app.whenReady().then(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  const result = { errors, contexts: [] }
  const watch = contents => contents.on("preload-error", (_event, file, error) => errors.push({ file, error: error.message }))
  try {
    ipcMain.on("codenomad:browser-prompt", (event, args) => { event.returnValue = args.message === "fixture" ? "native answer" : null })
    const owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    windows.push(owner)
    const target = session.fromPartition("built-preload-guest")
    target.registerPreloadScript({ id: "built-prompt", type: "frame", filePath: join(preloads, "browser-prompt.js"),
      matches: ["http://*/*", "https://*/*"], matchOriginAsFallback: true })
    const guest = new WebContentsView({ webPreferences: {
      session: target, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true,
    } })
    owner.contentView.addChildView(guest)
    watch(guest.webContents)
    for (const [name, host] of [["remote", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.preview.localhost"], ["local", "127.0.0.1"]]) {
      await guest.webContents.loadURL(`http://${host}:${port}/`)
      result[name] = await guest.webContents.executeJavaScript("window.atDocumentStart")
      result[name].promptResult = await guest.webContents.executeJavaScript(
        'Object.getOwnPropertyDescriptor(window, "prompt")?.configurable === false ? window.prompt("fixture") : "unavailable"')
    }
    for (const context of ["local", "preferences", "remote"]) {
      const window = new BrowserWindow({ show: false, webPreferences: {
        preload: join(preloads, "index.js"), sandbox: true, contextIsolation: true, nodeIntegration: false,
        additionalArguments: [`--codenomad-window-context=${context}`],
      } })
      windows.push(window)
      watch(window.webContents)
      await window.loadURL(`http://127.0.0.1:${port}/`)
      result.contexts.push(await window.webContents.executeJavaScript(`({
        context: window.__CODENOMAD_WINDOW_CONTEXT__, host: window.__CODENOMAD_RUNTIME_HOST__,
        bridge: typeof window.electronAPI, node: typeof window.require,
        localAction: typeof window.electronAPI?.newWindow,
        preferencesAction: typeof window.electronAPI?.preferencesReady,
        remoteAction: typeof window.electronAPI?.retryRemoteWindow
      })`))
    }
    result.hidden = windows.every(window => !window.isVisible() && !window.isFocused()) && BrowserWindow.getFocusedWindow() === null
    writeFileSync(resultFile, JSON.stringify(result))
  } catch (error) {
    writeFileSync(resultFile, JSON.stringify({ ...result, error: error.stack }))
    process.exitCode = 1
  } finally {
    for (const window of windows) window.destroy()
    server.close()
    app.quit()
  }
})
