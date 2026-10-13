import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
  type Setter,
} from "solid-js"

import type { TranslateParams } from "../../../lib/i18n"

import type { DrawerViewState } from "./types"
import { resolveEmbeddedDrawers } from "./drawer-layout"
import { createOrientationDrawerMemory, type DrawerOrientation } from "./drawer-orientation"

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
  /** Touch tablets only: null keeps one open state for every window shape. */
  orientation?: Accessor<DrawerOrientation | null>
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
  leftToggleLabel: Accessor<string>
  rightToggleLabel: Accessor<string>
  toggleLeft: () => void
  toggleRight: () => void
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
  const startsInPortrait = options.orientation?.() === "portrait"
  const [leftOpen, setLeftOpen] = createSignal(startsInPortrait ? false : initialLayout.left)
  const [rightOpen, setRightOpen] = createSignal(startsInPortrait ? false : initialLayout.right)
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

  const leftToggleLabel = () =>
    options.t(leftOpen() ? "instanceShell.leftDrawer.toggle.close" : "instanceShell.leftDrawer.toggle.open")

  const rightToggleLabel = () =>
    options.t(rightOpen() ? "instanceShell.rightDrawer.toggle.close" : "instanceShell.rightDrawer.toggle.open")

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

  // Floating drawers cover the whole shell, so opening one replaces the other.
  const toggleLeft = () => {
    if (leftOpen()) return closeLeft()
    if (!rightPinned() && rightOpen()) setRightOpen(false)
    setLeftOpen(true)
    measureDrawerHost()
  }

  const toggleRight = () => {
    if (rightOpen()) return closeRight()
    if (!leftPinned() && leftOpen()) setLeftOpen(false)
    setRightOpen(true)
    measureDrawerHost()
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

  if (options.orientation) {
    // Started in portrait: landscape keeps drawers closed until the user opens
    // them, so a rotated phone never gains overlays it did not ask for.
    const rotate = createOrientationDrawerMemory(startsInPortrait ? { left: false, right: false } : initialLayout)
    // A drawer closed by rotation hands focus to its toggle only if it held focus.
    const applyRotation = (open: boolean, isOpen: boolean, setOpen: Setter<boolean>, content: HTMLElement | null, toggle: Accessor<HTMLElement | null>) => {
      if (open || !isOpen) return void setOpen(open)
      const focused = typeof document !== "undefined" ? document.activeElement : null
      blurIfInside(content)
      setOpen(false)
      // Closing removed the focused control (the drawer header included): hand
      // focus to the fixed toggle. Effect writes are batched, so resolve it on
      // the next frame.
      if (focused && focused !== document.body && (!focused.isConnected || content?.contains(focused))) {
        requestAnimationFrame(() => toggle()?.focus())
      }
    }
    // Not deferred: a deferred `on` would not record the initial orientation.
    createEffect(on(options.orientation, (next, previous) => {
      if (!next || !previous || next === previous) return
      const target = rotate(previous, next, { left: leftOpen(), right: rightOpen() })
      applyRotation(target.left, leftOpen(), setLeftOpen, options.leftDrawerContentEl(), options.leftToggleButtonEl)
      applyRotation(target.right, rightOpen(), setRightOpen, options.rightDrawerContentEl(), options.rightToggleButtonEl)
      measureDrawerHost()
    }))
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
    leftToggleLabel,
    rightToggleLabel,
    toggleLeft,
    toggleRight,
  }
}
