import type { DrawerViewState } from "./instance/shell/types"

export function shouldMountSessionList(drawerState: DrawerViewState): boolean {
  return drawerState !== "floating-closed"
}

export function shouldRenderSessionRows(hasError: boolean, hasContent: boolean): boolean {
  return !hasError && hasContent
}
