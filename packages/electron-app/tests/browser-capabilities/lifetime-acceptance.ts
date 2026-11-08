import assert from "node:assert/strict"
import { writeFile } from "node:fs/promises"
import { app, BrowserWindow, type WebContents } from "electron"
import { browserGuestLifetime } from "../../electron/main/browser-guest-lifetime"

export async function qualifyLifetime(owner: BrowserWindow, guest: WebContents): Promise<void> {
  const mode = process.env.CODENOMAD_FIXTURE_LIFETIME!
  const pause = () => new Promise(resolve => setTimeout(resolve, 50))
  const wait = async (condition: () => boolean) => {
    for (let i = 0; i < 200; i++) { if (condition()) return; await pause() }
    assert.fail("native lifetime condition timed out")
  }
  // Keep the process alive so owner destruction can be asserted before app.exit.
  const sentinel = new BrowserWindow({ show: false })
  try {
    await guest.executeJavaScript("window.onbeforeunload=()=>true;window.open('/lifetime-child');void 0", true)
    await wait(() => BrowserWindow.getAllWindows().length === 3)
    const child = BrowserWindow.getAllWindows().find(window => window !== owner && window !== sentinel)!
    await wait(() => !child.webContents.isLoading())
    await child.webContents.executeJavaScript("window.onbeforeunload=()=>true;window.open('/hold');void 0", true)
    await wait(() => BrowserWindow.getAllWindows().length === 4)
    const descendants = BrowserWindow.getAllWindows().filter(window => window !== owner && window !== sentinel)
    const contents = descendants.map(window => window.webContents)
    if (mode === "opener-close") guest.close({ waitForBeforeUnload: false })
    else if (mode === "opener-reload") { await guest.executeJavaScript("window.onbeforeunload=null;void 0"); guest.reload() }
    else if (mode === "owner-destroy") owner.destroy()
    else if (mode === "owner-close") owner.close()
    else if (mode === "renderer-reload") owner.reload()
    else assert.fail(`Unknown lifetime mode ${mode}`)
    await wait(() => descendants.every(window => window.isDestroyed()))
    for (const source of contents) assert.equal(browserGuestLifetime.owner(source), undefined)
    if (mode !== "opener-reload") assert.equal(browserGuestLifetime.owner(guest), undefined)
    await writeFile(`${process.env.CODENOMAD_PROFILE}/lifetime-${mode}.txt`, `PASS ${mode}: two native descendants destroyed; registries empty; armed child beforeunload bypassed\n`)
    app.exit(0)
  } catch (error) { console.error(error); app.exit(1) }
}
