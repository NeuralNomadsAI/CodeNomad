import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { app, BrowserWindow, type WebContents } from "electron"
import { isBrowserDialog } from "../../electron/main/browser-dialog"

const exec = promisify(execFile)
const pause = () => new Promise(resolve => setTimeout(resolve, 30))

/** Real production guest hooks and native dialogs, on the fixture's own X display. */
export async function qualifyBeforeUnload(owner: BrowserWindow, root: WebContents): Promise<void> {
  const driver = process.env.CODENOMAD_FIXTURE_DIALOG_DRIVER
  assert.ok(driver, "Set CODENOMAD_FIXTURE_DIALOG_DRIVER to linux-answer-beforeunload.sh")
  const evidence = resolve(process.env.CODENOMAD_FIXTURE_EVIDENCE ?? `.tmp/beforeunload-${process.pid}`)
  await mkdir(evidence, { recursive: true })
  const timeout = setTimeout(() => { console.error("beforeunload acceptance timed out"); app.exit(1) }, 90_000)
  const capture = async (guest: WebContents, name: string) => writeFile(resolve(evidence, `${name}.png`), (await guest.capturePage()).toPNG())
  const fresh = async (guest: WebContents) => {
    const end = Date.now() + 5000
    while (Date.now() < end) {
      if (!guest.isLoading() && await guest.executeJavaScript("document.readyState==='complete' && !document.body.dataset.retained")) return
      await pause()
    }
    assert.fail("Leave did not replace the document")
  }
  const arm = async (guest: WebContents) => {
    guest.focus()
    await guest.capturePage()
    await pause()
    guest.sendInputEvent({ type: "mouseDown", x: 4, y: 4, button: "left", clickCount: 1 })
    guest.sendInputEvent({ type: "mouseUp", x: 4, y: 4, button: "left", clickCount: 1 })
    await pause()
    assert.equal(await guest.executeJavaScript("navigator.userActivation.hasBeenActive"), true)
    await guest.executeJavaScript("document.body.dataset.retained='yes'; window.onbeforeunload=e=>{e.preventDefault(); e.returnValue='unsaved'; return 'unsaved'}; void 0")
  }
  const decide = async (guest: WebContents, name: string, answer: "stay" | "leave", action: () => void) => {
    const prevented = new Promise<void>((resolve, reject) => guest.once("will-prevent-unload", event => {
      try { assert.equal(event.defaultPrevented, answer === "leave"); resolve() }
      catch (error) { reject(error) }
    }))
    const input = exec("bash", [driver, answer, String(process.pid), resolve(evidence, `${name}-confirm.png`)], { timeout: 13_000, windowsHide: true })
    action()
    await Promise.all([prevented, input])
    if (answer === "stay") {
      assert.equal(guest.isDestroyed(), false)
      assert.equal(await guest.executeJavaScript("document.body.dataset.retained"), "yes")
      await capture(guest, name)
    }
  }
  try {
    await arm(root)
    await decide(root, "navigation-stay", "stay", () => { void root.loadURL("http://127.0.0.1:18741/next").catch(() => {}) })
    await decide(root, "navigation-leave", "leave", () => { void root.loadURL("http://127.0.0.1:18741/next").catch(() => {}) })
    await fresh(root)
    assert.equal(new URL(root.getURL()).pathname, "/next")
    await capture(root, "navigation-leave")
    await arm(root)
    await decide(root, "reload-stay", "stay", () => root.reload())
    await decide(root, "reload-leave", "leave", () => root.reload())
    await fresh(root)
    await capture(root, "reload-leave")
    await root.executeJavaScript("window.open('/close-test'); void 0", true)
    const popup = BrowserWindow.getAllWindows().find(window => window !== owner && !isBrowserDialog(window))!
    assert.ok(popup)
    while (popup.webContents.isLoading()) await pause()
    await popup.webContents.executeJavaScript("window.close=()=>{};void 0")
    await arm(popup.webContents)
    await decide(popup.webContents, "popup-close-stay", "stay", () => popup.close())
    const closed = new Promise<void>(resolve => popup.once("closed", () => resolve()))
    await decide(popup.webContents, "popup-close-leave", "leave", () => popup.close())
    await closed
    assert.equal(popup.isDestroyed(), true)
    console.log(`PASS native Electron beforeunload navigation/reload/popup-close Stay/Leave; evidence=${evidence}`)
    app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
  finally { clearTimeout(timeout) }
}
