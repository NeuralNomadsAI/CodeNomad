import { app, BrowserWindow, session } from "electron"
import { secureBrowserWebview } from "../../electron/main/browser-webview-security"
import { configureBrowserPermissionHandlers } from "../../electron/main/permissions"
import { configureBrowserDownloads } from "../../electron/main/browser-downloads"
import { protectBrowserGuest, configureBrowserGuests } from "../../electron/main/browser-guests"
import { configureBrowserPromptSession } from "../../electron/main/browser-prompt"
import { qualifyPrompt } from "./prompt-acceptance"
import { qualifyBeforeUnload } from "./beforeunload-acceptance"

if (!process.env.CODENOMAD_PROFILE) throw new Error("Set an isolated CODENOMAD_PROFILE directory")
app.setPath("userData", process.env.CODENOMAD_PROFILE)
void app.whenReady().then(async () => {
const partition = "persist:codenomad-browser-capabilities"
const store = session.fromPartition(partition)
configureBrowserGuests()
configureBrowserPromptSession(store, process.env.CODENOMAD_FIXTURE_PROMPT_PRELOAD!)
configureBrowserPermissionHandlers(store)
configureBrowserDownloads(store, app.getPath("downloads"))
const owner = new BrowserWindow({ width: 920, height: 820,
  webPreferences: { webviewTag: true, nodeIntegration: false, contextIsolation: true, sandbox: true } })
owner.webContents.on("will-attach-webview", (event, preferences, params) => {
  if (!secureBrowserWebview(preferences, params)) event.preventDefault()
})
owner.webContents.on("did-attach-webview", (_event, guest) => {
  protectBrowserGuest(owner, guest)
  if (process.env.CODENOMAD_FIXTURE_PROMPT_TEST) guest.once("did-finish-load", () => { void qualifyPrompt(owner, guest) })
  else if (process.env.CODENOMAD_FIXTURE_BEFOREUNLOAD_TEST) guest.once("did-finish-load", () => { void qualifyBeforeUnload(owner, guest) })
  guest.on("console-message", details => console.log("guest", details.message))
  if (process.env.CODENOMAD_FIXTURE_NETWORK) guest.once("did-finish-load", () => {
    void guest.loadURL("https://example.com").then(() => guest.executeJavaScript(`
      document.body.innerHTML='<button id="network" style="font-size:24px;padding:20px">Test local network</button>';
      document.getElementById('network').onclick=()=>fetch('http://127.0.0.1:18741/').then(r=>r.text()).then(v=>console.log('network-result',v.length),e=>console.log('network-error',e.name));
      void 0;
    `))
  })
  if (process.env.CODENOMAD_FIXTURE_CLOSE_AFTER) setTimeout(() => guest.close({ waitForBeforeUnload: false }),
    Number(process.env.CODENOMAD_FIXTURE_CLOSE_AFTER) * 1000)
})
await owner.loadURL(`data:text/html,${encodeURIComponent(`<style>html,body{margin:0;width:100%;height:100%}webview{display:flex;width:100%;height:100%}</style><webview src="http://127.0.0.1:18741/" partition="${partition}" allowpopups></webview>`)}`)
})
app.on("window-all-closed", () => app.quit())
