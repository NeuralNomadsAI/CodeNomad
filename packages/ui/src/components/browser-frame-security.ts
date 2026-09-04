import type { RuntimeEnvironment } from "../lib/runtime-env"

const FRAME_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-downloads"

export function getBrowserFramePolicy(_environment: Pick<RuntimeEnvironment, "host" | "windowContext">) {
  return {
    sandbox: FRAME_SANDBOX,
    canInspectDom: false,
  }
}

export function getPreviewFrameSource(
  environment: Pick<RuntimeEnvironment, "host" | "windowContext">,
  preview: { token: string; targetUrl: string; proxyUrl: string },
  parentUrl: string,
): string {
  if (environment.windowContext !== "local" || (environment.host !== "electron" && environment.host !== "tauri")) {
    return preview.proxyUrl
  }
  const source = new URL(parentUrl)
  const loopback = source.hostname === "localhost" || source.hostname === "::1" || /^127(?:\.|$)/.test(source.hostname)
  if (source.protocol !== "http:" || !loopback) return preview.proxyUrl
  const target = new URL(preview.targetUrl)
  source.hostname = `${preview.token}.preview.localhost`
  source.pathname = target.pathname
  source.search = target.search
  source.hash = target.hash
  return source.href
}
