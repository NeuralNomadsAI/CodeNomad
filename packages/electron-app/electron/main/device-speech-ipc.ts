import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron"
import { isDeviceSpeechRequest } from "../../../desktop-speech/contract"
import type { DeviceSpeech } from "./device-speech"
import { validateMainFrame } from "./ipc-security"

export function setupDeviceSpeechIPC(
  ipc: Pick<IpcMain, "handle">,
  speech: Pick<DeviceSpeech, "request" | "revoke" | "revokeAll" | "revokeRendererMicrophone">,
  dependencies: {
    resolveLocal(sender: IpcMainInvokeEvent["sender"]): BrowserWindow | undefined
    resolvePreferences(sender: IpcMainInvokeEvent["sender"]): BrowserWindow | undefined
    resolveDictation?(event: IpcMainInvokeEvent): BrowserWindow | undefined
    getAllowedOrigins(): string[]
    isShuttingDown?(): boolean
  },
) {
  const bound = new WeakSet<IpcMainInvokeEvent["sender"]>()
  ipc.handle("device-speech:request", (event, input: unknown) => {
    const local = dependencies.resolveLocal(event.sender)
    const dictation = dependencies.resolveDictation?.(event)
    const composer = local ?? dictation
    const window = composer ?? dependencies.resolvePreferences(event.sender)
    if (!window) throw new Error("Device speech requires a local application window")
    if (!dictation) validateMainFrame(event, window, dependencies.getAllowedOrigins())
    if (!isDeviceSpeechRequest(input)) throw new Error("Invalid device speech request")
    if (dependencies.isShuttingDown?.()) throw new Error("Application is shutting down")
    if (!composer && input.action === "start") throw new Error("Dictation requires a local composer window")
    if (input.action === "claimMicrophone" &&
      (!window.isFocused() || (!composer && input.purpose !== "test") || (dictation && input.purpose !== "dictation"))) {
      throw new Error("Microphone use requires its focused application window")
    }
    if (composer && (input.action === "select" || input.action === "prepare")) {
      throw new Error("Device speech settings require the Preferences window")
    }

    const contents = event.sender
    const owner = contents.id
    if (!dictation && !bound.has(contents)) {
      bound.add(contents)
      contents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) speech.revoke(owner, false)
      })
      contents.on("did-navigate", () => speech.revokeRendererMicrophone(owner))
      contents.on("render-process-gone", () => speech.revoke(owner))
      contents.once("destroyed", () => speech.revoke(owner))
      if (process.platform === "win32") window.once("session-end", () => speech.revokeAll())
    }
    return speech.request(owner, input)
  })
}
