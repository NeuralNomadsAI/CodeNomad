import {
  createComponent,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type JSX,
  type Setter,
} from "solid-js"
import MenuOpenIcon from "@suid/icons-material/MenuOpen"

import type { TranslateParams } from "../../../lib/i18n"

import type { DrawerViewState } from "./types"
import { resolveEmbeddedDrawers } from "./drawer-layout"

export interface UseDrawerChromeOptions {
  t: (key: string, params?: TranslateParams) => string
  hostWidth: Accessor<number>
  minimumCenterWidth: number
  minimumLeftWidth: number
  minimumRightWidth: number
  leftWidth: Accessor<number>
  rightWidth: Accessor<number>
  leftDrawerContentEl: Accessor<HTMLElement | null>
  rightDrawerContentEl: Accessor<HTMLElement | null>
  leftToggleButtonEl: Accessor<HTMLElement | null>
  rightToggleButtonEl: Accessor<HTMLElement | null>
  measureDrawerHost?: () => void
}

export interface DrawerChromeApi {
  leftPinned: Accessor<boolean>
  leftOpen: Accessor<boolean>
  rightPinned: Accessor<boolean>
  rightOpen: Accessor<boolean>
  leftPanelWidth: Accessor<number>
  rightPanelWidth: Accessor<number>
  setLeftOpen: Setter<boolean>
  setRightOpen: Setter<boolean>
  leftDrawerState: Accessor<DrawerViewState>
  rightDrawerState: Accessor<DrawerViewState>
  closeLeft: () => void
  closeRight: () => void
  closeFloatingDrawersIfAny: () => boolean
  leftAppBarButtonLabel: Accessor<string>
  rightAppBarButtonLabel: Accessor<string>
  leftAppBarButtonIcon: Accessor<JSX.Element>
  rightAppBarButtonIcon: Accessor<JSX.Element>
  handleLeftAppBarButtonClick: () => void
  handleRightAppBarButtonClick: () => void
}

export function useDrawerChrome(options: UseDrawerChromeOptions): DrawerChromeApi {
  const initialLayout = resolveEmbeddedDrawers({
    hostWidth: options.hostWidth(),
    minimumCenterWidth: options.minimumCenterWidth,
    minimumLeftWidth: options.minimumLeftWidth,
    minimumRightWidth: options.minimumRightWidth,
    leftWidth: options.leftWidth(),
    rightWidth: options.rightWidth(),
    leftOpen: true,
    rightOpen: true,
  })
  const [leftOpen, setLeftOpen] = createSignal(initialLayout.left)
  const [rightOpen, setRightOpen] = createSignal(initialLayout.right)
  const embeddedDrawers = createMemo(() =>
    resolveEmbeddedDrawers({
      hostWidth: options.hostWidth(),
      minimumCenterWidth: options.minimumCenterWidth,
      minimumLeftWidth: options.minimumLeftWidth,
      minimumRightWidth: options.minimumRightWidth,
      leftWidth: options.leftWidth(),
      rightWidth: options.rightWidth(),
      leftOpen: leftOpen(),
      rightOpen: rightOpen(),
    }),
  )
  const leftPinned = createMemo(() => embeddedDrawers().left)
  const rightPinned = createMemo(() => embeddedDrawers().right)
  const leftPanelWidth = createMemo(() => embeddedDrawers().leftWidth)
  const rightPanelWidth = createMemo(() => embeddedDrawers().rightWidth)

  const measureDrawerHost = () => options.measureDrawerHost?.()

  const focusTarget = (element: HTMLElement | null) => {
    if (!element) return
    requestAnimationFrame(() => {
      element.focus()
    })
  }

  const blurIfInside = (element: HTMLElement | null) => {
    if (typeof document === "undefined" || !element) return
    const active = document.activeElement as HTMLElement | null
    if (active && element.contains(active)) {
      active.blur()
    }
  }

  const leftDrawerState = createMemo<DrawerViewState>(() => {
    if (leftPinned()) return "pinned"
    return leftOpen() ? "floating-open" : "floating-closed"
  })

  const rightDrawerState = createMemo<DrawerViewState>(() => {
    if (rightPinned()) return "pinned"
    return rightOpen() ? "floating-open" : "floating-closed"
  })

  const leftAppBarButtonLabel = () => {
    return options.t("instanceShell.leftDrawer.toggle.open")
  }

  const rightAppBarButtonLabel = () => {
    return options.t("instanceShell.rightDrawer.toggle.open")
  }

  const leftAppBarButtonIcon = () => {
    return createComponent(MenuOpenIcon, { fontSize: "small", sx: { transform: "scaleX(-1)" } })
  }

  const rightAppBarButtonIcon = () => {
    return createComponent(MenuOpenIcon, { fontSize: "small" })
  }

  const handleLeftAppBarButtonClick = () => {
    const state = leftDrawerState()
    if (state !== "floating-closed") return
    setLeftOpen(true)
    measureDrawerHost()
  }

  const handleRightAppBarButtonClick = () => {
    const state = rightDrawerState()
    if (state !== "floating-closed") return
    setRightOpen(true)
    measureDrawerHost()
  }

  const closeLeft = () => {
    blurIfInside(options.leftDrawerContentEl())
    setLeftOpen(false)
    focusTarget(options.leftToggleButtonEl())
  }

  const closeRight = () => {
    blurIfInside(options.rightDrawerContentEl())
    setRightOpen(false)
    focusTarget(options.rightToggleButtonEl())
  }

  const closeFloatingDrawersIfAny = () => {
    let handled = false
    if (!leftPinned() && leftOpen()) {
      setLeftOpen(false)
      blurIfInside(options.leftDrawerContentEl())
      focusTarget(options.leftToggleButtonEl())
      handled = true
    }
    if (!rightPinned() && rightOpen()) {
      setRightOpen(false)
      blurIfInside(options.rightDrawerContentEl())
      focusTarget(options.rightToggleButtonEl())
      handled = true
    }
    return handled
  }

  onMount(() => {
    if (typeof window === "undefined") return
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      if (!closeFloatingDrawersIfAny()) return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener("keydown", handleEscape, true)
    onCleanup(() => window.removeEventListener("keydown", handleEscape, true))
  })

  return {
    leftPinned,
    leftOpen,
    rightPinned,
    rightOpen,
    leftPanelWidth,
    rightPanelWidth,
    setLeftOpen,
    setRightOpen,
    leftDrawerState,
    rightDrawerState,
    closeLeft,
    closeRight,
    closeFloatingDrawersIfAny,
    leftAppBarButtonLabel,
    rightAppBarButtonLabel,
    leftAppBarButtonIcon,
    rightAppBarButtonIcon,
    handleLeftAppBarButtonClick,
    handleRightAppBarButtonClick,
  }
}
