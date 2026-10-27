import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
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
  /** Shown, docked or floating over the conversation. */
  leftOpen: Accessor<boolean>
  rightPinned: Accessor<boolean>
  rightOpen: Accessor<boolean>
  leftPanelWidth: Accessor<number>
  rightPanelWidth: Accessor<number>
  /** Opens the panel (docked when it has room, else floating) or closes it. */
  setLeftOpen: (open: boolean) => void
  setRightOpen: (open: boolean) => void
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
  const layoutFor = (left: boolean, right: boolean) => resolveEmbeddedDrawers({ ...layoutInputs(), leftOpen: left, rightOpen: right })
  // A panel the user wants docks while the window has its room, in a fixed order: the
  // session panel first, the other only beside it. Without room a wanted panel hides
  // until the room returns, so the layout follows the window width alone (narrowing,
  // widening, restoring a minimized window that briefly reports a tiny viewport). A
  // panel the user opens without room floats over the conversation instead.
  const startsInPortrait = options.orientation?.() === "portrait"
  const [leftWanted, setLeftWanted] = createSignal(!startsInPortrait)
  const [rightWanted, setRightWanted] = createSignal(!startsInPortrait)
  const [leftFloating, setLeftFloating] = createSignal(false)
  const [rightFloating, setRightFloating] = createSignal(false)
  const embeddedDrawers = createMemo(() => layoutFor(leftWanted(), rightWanted()))
  const leftPinned = createMemo(() => embeddedDrawers().left)
  const rightPinned = createMemo(() => embeddedDrawers().right)
  const leftPanelWidth = createMemo(() => embeddedDrawers().leftWidth)
  const rightPanelWidth = createMemo(() => embeddedDrawers().rightWidth)
  const leftOpen = createMemo(() => leftPinned() || leftFloating())
  const rightOpen = createMemo(() => rightPinned() || rightFloating())
  const panels = {
    left: { wanted: leftWanted, setWanted: setLeftWanted, floating: leftFloating, setFloating: setLeftFloating, pinned: leftPinned, open: leftOpen, content: options.leftDrawerContentEl, toggle: options.leftToggleButtonEl },
    right: { wanted: rightWanted, setWanted: setRightWanted, floating: rightFloating, setFloating: setRightFloating, pinned: rightPinned, open: rightOpen, content: options.rightDrawerContentEl, toggle: options.rightToggleButtonEl },
  }
  const otherSide = (side: DrawerSide): DrawerSide => side === "left" ? "right" : "left"
  /** Whether the panel would dock if the user wanted it. */
  const hasRoom = (side: DrawerSide) => side === "left" ? layoutFor(true, rightWanted()).left : layoutFor(leftWanted(), true).right

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
    return leftFloating() ? "floating-open" : "floating-closed"
  })

  const rightDrawerState = createMemo<DrawerViewState>(() => {
    if (rightPinned()) return "pinned"
    return rightFloating() ? "floating-open" : "floating-closed"
  })

  // Panels the user hid themselves (toggle, Escape, outside click, list choice): the
  // layout's focus hand-off below leaves their focus to the user's own action.
  const hiddenByUser = { left: false, right: false }

  // Floating drawers cover the whole shell, so opening one replaces the other.
  const open = (side: DrawerSide) => {
    const panel = panels[side]
    if (panel.open()) return
    panels[otherSide(side)].setFloating(false)
    if (hasRoom(side)) panel.setWanted(true)
    else panel.setFloating(true)
    measureDrawerHost()
  }

  // Closing a docked panel stops wanting it; dismissing a floating one keeps the docked
  // choice for when the room returns. Hiding alone leaves focus where the user put it.
  const hide = (side: DrawerSide) => {
    const panel = panels[side]
    if (!panel.open()) return false
    hiddenByUser[side] = true
    blurIfInside(panel.content())
    if (panel.pinned()) panel.setWanted(false)
    panel.setFloating(false)
    return true
  }

  const close = (side: DrawerSide) => {
    if (hide(side)) focusTarget(panels[side].toggle())
  }

  const closeFloatingDrawersIfAny = () => {
    let handled = false
    for (const side of ["left", "right"] as const) {
      const panel = panels[side]
      if (panel.pinned() || !panel.floating()) continue
      close(side)
      handled = true
    }
    return handled
  }

  // Mid-rotation the window already has its new shape while the orientation has not
  // changed yet; the rotation then decides each panel, so nothing docks on the way.
  const rotating = () => {
    const orientation = options.orientation?.()
    if (!orientation || typeof window === "undefined") return false
    return (window.innerHeight >= window.innerWidth ? "portrait" : "landscape") !== orientation
  }

  // A floating panel that gains its room docks.
  for (const side of ["left", "right"] as const) {
    const panel = panels[side]
    createEffect(() => {
      if (!panel.floating() || !hasRoom(side) || rotating()) return
      panel.setWanted(true)
      panel.setFloating(false)
    })
  }

  // The panel whose content last took focus, kept while that focus is lost only with the
  // panel's own DOM: a panel the layout hides is removed, focused control included,
  // before an effect can see it.
  let focusedDrawer: DrawerSide | null = null

  // A panel hidden by the layout (lost room, rotation) hands focus to its toggle only if
  // it held focus. Not deferred: a deferred `on` would not record the initial state.
  for (const side of ["left", "right"] as const) {
    const panel = panels[side]
    createEffect(on(panel.open, (shown, wasShown) => {
      const byUser = hiddenByUser[side]
      hiddenByUser[side] = false
      if (!wasShown || shown || byUser || typeof document === "undefined") return
      const content = panel.content()
      const lost = (element: Element | null) =>
        !element || element === document.body || !element.isConnected || Boolean(content?.contains(element))
      const focused = document.activeElement
      const held = focused && focused !== document.body ? lost(focused) : focusedDrawer === side
      // Effect writes are batched, so resolve it on the next frame, unless focus moved on meanwhile.
      if (held) requestAnimationFrame(() => { if (lost(document.activeElement)) panel.toggle()?.focus() })
    }))
  }

  if (options.orientation) {
    // Each orientation keeps the panels the user wants in it. Started in portrait:
    // landscape keeps them closed until the user opens them, so a rotated phone never
    // gains panels it did not ask for.
    const rotate = createOrientationDrawerMemory({ left: !startsInPortrait, right: !startsInPortrait })
    // Not deferred: a deferred `on` would not record the initial orientation.
    createEffect(on(options.orientation, (next, previous) => {
      if (!next || !previous || next === previous) return
      const target = rotate(previous, next, { left: leftWanted(), right: rightWanted() })
      setLeftWanted(target.left)
      setRightWanted(target.right)
      setLeftFloating(false)
      setRightFloating(false)
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
      focusedDrawer = panels.left.content()?.contains(target) ? "left" : panels.right.content()?.contains(target) ? "right" : null
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
    setLeftOpen: (next) => next ? open("left") : void hide("left"),
    setRightOpen: (next) => next ? open("right") : void hide("right"),
    leftDrawerState,
    rightDrawerState,
    closeLeft: () => close("left"),
    closeRight: () => close("right"),
    closeFloatingDrawersIfAny,
    toggleLeft: () => leftOpen() ? close("left") : open("left"),
    toggleRight: () => rightOpen() ? close("right") : open("right"),
  }
}
