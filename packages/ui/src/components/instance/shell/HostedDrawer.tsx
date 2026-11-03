import Drawer, { type DrawerProps } from "@suid/material/Drawer"
import { splitProps } from "solid-js"
import { isNestedDrawerSurface } from "./drawer-events"

type HostedDrawerProps = Omit<DrawerProps, "variant" | "ModalProps"> & {
  container: HTMLElement | undefined
}

/** Render directly under `container`, alongside the content this drawer isolates.
 * SUID's ModalManager excludes the modal root, not Solid Portal's extra wrapper,
 * from ariaHiddenSiblings. Portalling back into this same host therefore hides
 * the open drawer's own ancestor (and can retain it across opposite drawers).
 * Keep the modal root a direct host child. Nested surfaces own Escape; SUID owns focus and isolation.
 */
export function HostedDrawer(props: HostedDrawerProps) {
  const [local, drawer] = splitProps(props, ["container"])
  return <Drawer {...drawer} variant="temporary" ModalProps={{
    get container() { return local.container },
    disablePortal: true,
    get disableEscapeKeyDown() { return isNestedDrawerSurface(document.activeElement) },
  }} />
}
