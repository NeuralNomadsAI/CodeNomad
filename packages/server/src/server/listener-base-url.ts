export interface StartedListenerBaseUrlInput {
  protocol: "http" | "https"
  bindHost: string
  port: number
}

export interface ResolvePluginBaseUrlInput {
  httpStart?: StartedListenerBaseUrlInput | null
  httpsStart?: StartedListenerBaseUrlInput | null
  remoteUrl?: string
}

export function resolvePluginBaseUrl(input: ResolvePluginBaseUrlInput): string {
  const loopbackListener = [input.httpStart, input.httpsStart].find((listener) => listener && acceptsLoopback(listener.bindHost))
  if (loopbackListener) {
    return `${loopbackListener.protocol}://127.0.0.1:${loopbackListener.port}`
  }

  if (input.remoteUrl) {
    return input.remoteUrl
  }

  const fallbackListener = input.httpStart ?? input.httpsStart
  if (!fallbackListener) {
    throw new Error("No listeners started")
  }

  return `${fallbackListener.protocol}://${fallbackListener.bindHost}:${fallbackListener.port}`
}

function acceptsLoopback(bindHost: string): boolean {
  return bindHost === "0.0.0.0" || bindHost === "::" || bindHost === "localhost" || bindHost === "::1" || bindHost.startsWith("127.")
}
