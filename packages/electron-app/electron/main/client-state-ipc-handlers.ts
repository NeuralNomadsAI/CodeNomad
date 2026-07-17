import type { ClientStateManager } from "./client-state"

export function shouldResetRendererAccessTokenForNavigation(
  url: string,
  isInPlace: boolean,
  isMainFrame: boolean,
  isTrustedOrigin: (url: string) => boolean,
): boolean {
  return isMainFrame && !isInPlace && isTrustedOrigin(url)
}

export function createRendererAccessNavigationCommitHandler(
  clientState: Pick<ClientStateManager, "resetRendererAccessToken">,
  isTrustedOrigin: (url: string) => boolean,
) {
  return (url: string, isInPlace: boolean, isMainFrame: boolean): void => {
    if (shouldResetRendererAccessTokenForNavigation(url, isInPlace, isMainFrame, isTrustedOrigin)) {
      clientState.resetRendererAccessToken()
    }
  }
}

export function createClientStateIPCHandlers(clientState: ClientStateManager) {
  const requireAccess = (token: unknown) => clientState.assertRendererAccessToken(token)

  return {
    claimAccess(token: unknown) {
      return clientState.claimClientStateAccess(token)
    },
    load(token: unknown) {
      requireAccess(token)
      return clientState.loadClientState()
    },
    save(token: unknown, snapshot: unknown) {
      requireAccess(token)
      return clientState.saveClientState(snapshot)
    },
    setRestoreEnabled(token: unknown, enabled: unknown) {
      requireAccess(token)
      if (typeof enabled !== "boolean") {
        throw new TypeError("Restore enabled must be a boolean")
      }
      return clientState.setRestoreEnabled(enabled)
    },
    clear(token: unknown) {
      requireAccess(token)
      return clientState.clearClientState()
    },
  }
}

export type ClientStateIPCHandlers = ReturnType<typeof createClientStateIPCHandlers>
