import type { DrawerViewState } from "./instance/shell/types"

export function shouldMountSessionList(drawerState: DrawerViewState): boolean {
  return drawerState !== "floating-closed"
}

export function isSessionListViewportAttached(
  viewport: Pick<HTMLElement, "isConnected" | "ownerDocument">,
): boolean {
  return viewport.isConnected && Boolean(viewport.ownerDocument.defaultView)
}

export function shouldRenderSessionRows(hasError: boolean, hasContent: boolean, hasSavedRows = false): boolean {
  return hasContent && (!hasError || hasSavedRows)
}
