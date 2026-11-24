import { ipcMain, type WebContents, type BrowserWindow, type Session } from "electron"
import { showBrowserDialog } from "./browser-dialog"
import { createBrowserPromptHandler } from "./browser-prompt-policy"
import { browserGuestLifetime } from "./browser-guest-lifetime"

export const browserPromptChannel = "codenomad:browser-prompt"
const sessions = new WeakSet<Session>()
export function configureBrowserPromptSession(target: Session, preload: string): void {
  if (sessions.has(target)) return
  target.registerPreloadScript({ id: browserPromptChannel, type: "frame", filePath: preload,
    matches: ["http://*/*", "https://*/*"], matchOriginAsFallback: true })
  sessions.add(target)
}

export function installBrowserPrompt(ownerOf: (contents: WebContents) => BrowserWindow | undefined): void {
  ipcMain.on(browserPromptChannel, createBrowserPromptHandler(ownerOf,
    (owner, origin, message, value, source, current) => showBrowserDialog(owner, origin, message, { text: value }, source, current),
    source => browserGuestLifetime.revision(source)))
}
