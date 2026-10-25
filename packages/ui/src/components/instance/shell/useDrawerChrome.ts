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

type DrawerSide = "left" | "right"

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
  toggleLeft: () => void
  toggleRight: () => void
}

export function useDrawerChrome(options: UseDrawerChromeOptions): DrawerChromeApi {
  const layoutInputs = () => ({
    hostWidth: options.hostWidth(),
    minimumCenterWidth: options.minimumCenterWidth,
    minimumLeftWidth: options.minimumLeftWidth,
    minimumRightWidth: options.minimumRightWidth,
    leftWidth: options.leftWidth(),
    rightWidth: options.rightWidth(),
  })
  const initialLayout = resolveEmbeddedDrawers({ ...layoutInputs(), leftOpen: true, rightOpen: true })
  const startsInPortrait = options.orientation?.() === "portrait"
  const [leftOpen, setLeftOpen] = createSignal(startsInPortrait ? false : initialLayout.left)
  const [rightOpen, setRightOpen] = createSignal(startsInPortrait ? false : initialLayout.right)
  const embeddedDrawers = createMemo(() =>
    resolveEmbeddedDrawers({ ...layoutInputs(), leftOpen: leftOpen(), rightOpen: rightOpen() }),
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

  // The drawer whose content last took focus, kept while that focus is lost only with
  // the drawer's own DOM: a drawer that loses its docked room is re-rendered, focused
  // control included, before its closing runs.
  let focusedDrawer: DrawerSide | null = null
  const contentOf = (side: DrawerSide) => side === "left" ? options.leftDrawerContentEl() : options.rightDrawerContentEl()

  // A drawer closed by the layout (rotation, lost room) hands focus to its toggle only if it held focus.
  const closeForLayout = (side: DrawerSide, setOpen: Setter<boolean>, toggle: Accessor<HTMLElement | null>) => {
    const content = contentOf(side)
    const focused = typeof document !== "undefined" ? document.activeElement : null
    const held = focused && focused !== document.body
      ? !focused.isConnected || Boolean(content?.contains(focused))
      : focusedDrawer === side
    blurIfInside(content)
    setOpen(false)
    // Effect writes are batched, so resolve it on the next frame.
    if (held) requestAnimationFrame(() => toggle()?.focus())
  }

  // A docked drawer that loses its room (the window narrows, or the other drawer
  // opens) closes instead of floating over the conversation, and returns with the
  // room unless it is opened meanwhile: restoring a minimized window, which briefly
  // reports a tiny viewport, brings both back. A drawer opened without room still
  // floats. Not deferred: a deferred `on` would not record the initial docked state.
  const [leftAwaitsRoom, setLeftAwaitsRoom] = createSignal(false)
  const [rightAwaitsRoom, setRightAwaitsRoom] = createSignal(false)
  const closeWhenUndocked = (side: DrawerSide, pinned: Accessor<boolean>, isOpen: Accessor<boolean>, setOpen: Setter<boolean>, setAwaitsRoom: Setter<boolean>, toggle: Accessor<HTMLElement | null>) => {
    createEffect(on(pinned, (docked, wasDocked) => {
      if (!wasDocked || docked || !isOpen()) return
      setAwaitsRoom(true)
      closeForLayout(side, setOpen, toggle)
    }))
    createEffect(() => { if (isOpen()) setAwaitsRoom(false) })
  }
  closeWhenUndocked("left", leftPinned, leftOpen, setLeftOpen, setLeftAwaitsRoom, options.leftToggleButtonEl)
  closeWhenUndocked("right", rightPinned, rightOpen, setRightOpen, setRightAwaitsRoom, options.rightToggleButtonEl)
  // The session panel returns first; the other only if both then fit docked.
  createEffect(() => {
    const left = leftOpen() || (leftAwaitsRoom() && resolveEmbeddedDrawers({ ...layoutInputs(), leftOpen: true, rightOpen: rightOpen() }).left)
    const right = rightOpen() || (rightAwaitsRoom() && resolveEmbeddedDrawers({ ...layoutInputs(), leftOpen: left, rightOpen: true }).right)
    if (left && !leftOpen()) setLeftOpen(true)
    if (right && !rightOpen()) setRightOpen(true)
  })

  if (options.orientation) {
    // Started in portrait: landscape keeps drawers closed until the user opens
    // them, so a rotated phone never gains overlays it did not ask for.
    const rotate = createOrientationDrawerMemory(startsInPortrait ? { left: false, right: false } : initialLayout)
    const applyRotation = (side: DrawerSide, open: boolean, isOpen: boolean, setOpen: Setter<boolean>, toggle: Accessor<HTMLElement | null>) => {
      if (open || !isOpen) return void setOpen(open)
      closeForLayout(side, setOpen, toggle)
    }
    // Not deferred: a deferred `on` would not record the initial orientation.
    createEffect(on(options.orientation, (next, previous) => {
      if (!next || !previous || next === previous) return
      // The orientation's memory decides: a drawer closed for room was open in the
      // outgoing orientation and no longer awaits room in the incoming one.
      const target = rotate(previous, next, { left: leftOpen() || leftAwaitsRoom(), right: rightOpen() || rightAwaitsRoom() })
      setLeftAwaitsRoom(false)
      setRightAwaitsRoom(false)
      applyRotation("left", target.left, leftOpen(), setLeftOpen, options.leftToggleButtonEl)
      applyRotation("right", target.right, rightOpen(), setRightOpen, options.rightToggleButtonEl)
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

    const trackFocus = (event: FocusEvent) => {
      const target = event.target as Node
      focusedDrawer = contentOf("left")?.contains(target) ? "left" : contentOf("right")?.contains(target) ? "right" : null
    }
    // Focus the user moves to the page itself (a click on empty space) leaves the drawer;
    // focus lost with a removed control, or with the window, does not.
    const trackBlur = (event: FocusEvent) => {
      if (event.relatedTarget) return
      const target = event.target as Node
      queueMicrotask(() => { if (target.isConnected && document.hasFocus()) focusedDrawer = null })
    }
    document.addEventListener("focusin", trackFocus, true)
    document.addEventListener("focusout", trackBlur, true)
    onCleanup(() => {
      document.removeEventListener("focusin", trackFocus, true)
      document.removeEventListener("focusout", trackBlur, true)
    })
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
    toggleLeft,
    toggleRight,
  }
}
