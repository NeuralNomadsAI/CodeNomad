export const RENDERER_CLIENT_STATE_FLUSH_TIMEOUT_MS = 1_000

const RENDERER_CLIENT_STATE_FLUSH_CALLBACK = "__CODENOMAD_FLUSH_CLIENT_STATE_BEFORE_NATIVE_SHUTDOWN__"

interface RendererFlushWebContents {
  isDestroyed(): boolean
  getURL(): string
  executeJavaScript(source: string, userGesture?: boolean): Promise<unknown>
}

export interface RendererFlushWindow {
  isDestroyed(): boolean
  webContents: RendererFlushWebContents
}

export type RendererFlushResult = "flushed" | "not-primary" | "window-unavailable" | "untrusted-origin" | "no-application"

/**
 * The loading page and the server's sign-in and pairing pages never run the application, so nothing
 * there could answer a flush: waiting for one would keep the window from closing and CodeNomad from quitting.
 */
export function isListenerlessDocument(url: string): boolean {
  try {
    const { pathname } = new URL(url)
    return pathname.endsWith("/loading.html") || pathname === "/login" || pathname === "/remote-pair" || pathname.startsWith("/auth/")
  } catch {
    return false
  }
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, operation = "Renderer client-state flush"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export async function flushRendererClientStateBeforeShutdown(
  window: RendererFlushWindow | null,
  isPrimary: boolean,
  isTrustedOrigin: (url: string) => boolean,
  timeoutMs = RENDERER_CLIENT_STATE_FLUSH_TIMEOUT_MS,
): Promise<RendererFlushResult> {
  if (!isPrimary) return "not-primary"
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return "window-unavailable"

  const currentUrl = window.webContents.getURL()
  if (!isTrustedOrigin(currentUrl)) return "untrusted-origin"
  if (isListenerlessDocument(currentUrl)) return "no-application"

  const callbackName = JSON.stringify(RENDERER_CLIENT_STATE_FLUSH_CALLBACK)
  const expectedOrigin = JSON.stringify(new URL(currentUrl).origin)
  await withTimeout(
    window.webContents.executeJavaScript(`(() => {
      if (window.location.origin !== ${expectedOrigin}) throw new Error("Renderer origin changed before client-state flush");
      const flush = window[${callbackName}];
      if (typeof flush !== "function") throw new Error("Renderer client-state flush callback is unavailable");
      return flush();
    })()`),
    timeoutMs,
  )
  return "flushed"
}
