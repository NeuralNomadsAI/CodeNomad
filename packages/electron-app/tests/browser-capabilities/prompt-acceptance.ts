import assert from "node:assert/strict"
import { app, BrowserWindow, type WebContents } from "electron"
import { isBrowserDialog, showBrowserDialog } from "../../electron/main/browser-dialog"

/** Run inside the real-engine fixture with CODENOMAD_FIXTURE_PROMPT_TEST=1. */
export async function qualifyPrompt(owner: BrowserWindow, guest: WebContents): Promise<void> {
  const answer = async (expression: string, value: string | null, target: Pick<WebContents, "executeJavaScript"> = guest) => {
    let handled = false
    const timer = setInterval(() => {
      const dialog = BrowserWindow.getAllWindows().find(isBrowserDialog)
      if (handled || !dialog || dialog.webContents.isLoading()) return
      handled = true
      void dialog.webContents.executeJavaScript(`(() => {
        const field = document.querySelector('input');
        if (field) field.value = ${JSON.stringify(value ?? "")};
        document.querySelector('button[value="${value === null ? "cancel" : "accept"}"]').click();
      })()`)
    }, 30)
    try { return await target.executeJavaScript(expression, true) }
    finally { clearInterval(timer) }
  }
  const timeout = setTimeout(() => { console.error("prompt acceptance timed out"); app.exit(1) }, 20_000)
  try {
    assert.deepEqual(await guest.executeJavaScript(`[
      typeof require, typeof ipcRenderer, typeof electronAPI, typeof contextBridge,
      prompt.constructor('return typeof require')(), typeof process
    ]`), Array(6).fill("undefined"))
    assert.equal(await owner.webContents.executeJavaScript("typeof require + '/' + typeof electronAPI"), "undefined/undefined")
    assert.equal(await answer("prompt('root', 'default')", "root-answer"), "root-answer")
    assert.equal(await answer("prompt('cancel')", null), null)
    assert.equal(await answer("prompt('empty')", ""), "")
    await guest.executeJavaScript("new Promise(resolve => { const f = document.createElement('iframe'); f.srcdoc = '<title>frame</title>'; f.onload = () => resolve(); document.body.append(f) })")
    assert.equal(await answer("document.querySelector('iframe').contentWindow.prompt('subframe')", "frame-answer"), "frame-answer")
    assert.deepEqual(await guest.executeJavaScript("['require','process','ipcRenderer','electronAPI','contextBridge'].map(k=>typeof document.querySelector('iframe').contentWindow[k])"), Array(5).fill("undefined"))
    assert.equal(guest.getLastWebPreferences().sandbox, true)
    assert.equal(guest.getLastWebPreferences().nodeIntegration, false)
    await guest.executeJavaScript("new Promise(resolve => { const f=document.createElement('iframe'); f.src='http://localhost:18741/hold'; f.onload=()=>resolve(); document.body.append(f) })")
    const crossOrigin = guest.mainFrame.framesInSubtree.find(frame => frame.url === "http://localhost:18741/hold")!
    assert.ok(crossOrigin)
    assert.equal(await answer("prompt('cross-origin frame')", "cross-frame-answer", crossOrigin), "cross-frame-answer")
    assert.deepEqual(await crossOrigin.executeJavaScript("[typeof require,typeof process,typeof ipcRenderer,typeof electronAPI]"), Array(4).fill("undefined"))
    await guest.executeJavaScript("window.open('about:blank', 'prompt-test'); void 0", true)
    const popup = BrowserWindow.getAllWindows().find(window => window !== owner && !isBrowserDialog(window))!
    assert.ok(popup)
    assert.equal(await answer("prompt('blank popup')", "popup-answer", popup.webContents), "popup-answer")
    popup.destroy()
    let selected = false
    const choose = setInterval(() => {
      const dialog = BrowserWindow.getAllWindows().find(isBrowserDialog)
      if (selected || !dialog || dialog.webContents.isLoading()) return
      selected = true
      void dialog.webContents.executeJavaScript("document.querySelector('select').value='24'; document.querySelector('button[value=accept]').click()")
    }, 30)
    try { assert.equal(await showBrowserDialog(owner, "https://fixture.invalid", "choose", { choices: Array.from({ length: 25 }, (_, i) => `Device ${i + 1}`) }), "24") }
    finally { clearInterval(choose) }
    console.log("PASS real-engine prompt: string/cancel/empty/blank-popup/srcdoc/cross-origin subframe; sandbox retained; isolated globals; chooser entry 25")
    app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
  finally { clearTimeout(timeout) }
}
