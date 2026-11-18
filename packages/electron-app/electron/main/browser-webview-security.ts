import type { WebPreferences } from "electron"

export const browserPartitionPrefix = "persist:codenomad-browser-"

export function browserPartition(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)) throw new Error("Invalid browser session ID")
  return `${browserPartitionPrefix}${sessionId}`
}

export function isBrowserUrlAllowed(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
  } catch {
    return false
  }
}

export function isBrowserSiteUrlAllowed(rawUrl: string, openerUrl: string): boolean {
  if (isBrowserUrlAllowed(rawUrl) || /^about:blank(?:[?#]|$)/.test(rawUrl)) return true
  try {
    const url = new URL(rawUrl)
    return url.protocol === "blob:" && isBrowserUrlAllowed(openerUrl) && url.origin === new URL(openerUrl).origin
  } catch { return false }
}

export function isBrowserDownloadUrlAllowed(rawUrl: string, openerUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    return url.protocol === "data:" || (url.protocol !== "about:" && isBrowserSiteUrlAllowed(rawUrl, openerUrl))
  } catch { return false }
}

export function secureBrowserWebview(webPreferences: WebPreferences, params: Record<string, string>): boolean {
  if (!params.partition.startsWith(browserPartitionPrefix)
    || !/^[A-Za-z0-9_-]{1,256}$/.test(params.partition.slice(browserPartitionPrefix.length))
    || !isBrowserUrlAllowed(params.src)) return false
  delete webPreferences.preload
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInWorker = false
  // Electron gates frame preloads behind this flag, even with sandbox enabled.
  // The separate preview session has only the prompt preload; page Node stays off.
  webPreferences.nodeIntegrationInSubFrames = true
  webPreferences.webviewTag = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  webPreferences.disableDialogs = false
  return true
}
