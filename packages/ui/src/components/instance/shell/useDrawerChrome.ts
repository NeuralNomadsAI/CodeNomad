import {
  batch,
  createComponent,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type JSX,
  type Setter,
} from "solid-js"
import MenuIcon from "@suid/icons-material/Menu"

import type { TranslateParams } from "../../../lib/i18n"

import type { DrawerViewState, LayoutMode } from "./types"
import { persistPinState, readStoredPinState } from "./storage"

export interface UseDrawerChromeOptions {
  t: (key: string, params?: TranslateParams) => string
  layoutMode: Accessor<LayoutMode>
  leftPinningSupported: Accessor<boolean>
  rightPinningSupported: Accessor<boolean>
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
  setLeftOpen: Setter<boolean>
  setRightOpen: Setter<boolean>
  leftDrawerState: Accessor<DrawerViewState>
  rightDrawerState: Accessor<DrawerViewState>
  pinLeft: () => void
  unpinLeft: () => void
  pinRight: () => void
  unpinRight: () => void
  closeLeft: () => void
  closeRight: () => void
  leftAppBarButtonLabel: Accessor<string>
  rightAppBarButtonLabel: Accessor<string>
  leftAppBarButtonIcon: Accessor<JSX.Element>
  rightAppBarButtonIcon: Accessor<JSX.Element>
  handleLeftAppBarButtonClick: () => void
  handleRightAppBarButtonClick: () => void
}

export function useDrawerChrome(options: UseDrawerChromeOptions): DrawerChromeApi {
  const [leftPinned, setLeftPinned] = createSignal(true)
  const [leftOpen, setLeftOpen] = createSignal(true)
  const [rightPinned, setRightPinned] = createSignal(true)
  const [rightOpen, setRightOpen] = createSignal(true)

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

  const persistPinIfSupported = (side: "left" | "right", value: boolean) => {
    if (side === "left" && !options.leftPinningSupported()) return
    if (side === "right" && !options.rightPinningSupported()) return
    persistPinState(side, value)
  }

  createEffect(() => {
    switch (options.layoutMode()) {
      case "desktop": {
        const leftSaved = readStoredPinState("left", true)
        const rightSaved = readStoredPinState("right", true)
        setLeftPinned(leftSaved)
        setLeftOpen(leftSaved)
        setRightPinned(rightSaved)
        setRightOpen(rightSaved)
        break
      }
      case "tablet": {
        setLeftPinned(true)
        setLeftOpen(true)
        setRightPinned(false)
        setRightOpen(false)
        break
      }
      default:
        setLeftPinned(false)
        setLeftOpen(false)
        setRightPinned(false)
        setRightOpen(false)
        break
    }
  })

  const leftDrawerState = createMemo<DrawerViewState>(() => {
    if (leftPinned()) return "pinned"
    return leftOpen() ? "floating-open" : "floating-closed"
  })

  const rightDrawerState = createMemo<DrawerViewState>(() => {
    if (rightPinned()) return "pinned"
    return rightOpen() ? "floating-open" : "floating-closed"
  })

  const leftAppBarButtonLabel = () => {
    const state = leftDrawerState()
    if (state === "pinned") return options.t("instanceShell.leftDrawer.toggle.pinned")
    return options.t("instanceShell.leftDrawer.toggle.open")
  }

  const rightAppBarButtonLabel = () => {
    const state = rightDrawerState()
    if (state === "pinned") return options.t("instanceShell.rightDrawer.toggle.pinned")
    return options.t("instanceShell.rightDrawer.toggle.open")
  }

  const leftAppBarButtonIcon = () => {
    return createComponent(MenuIcon, { fontSize: "small" })
  }

  const rightAppBarButtonIcon = () => {
    return createComponent(MenuIcon, { fontSize: "small", sx: { transform: "scaleX(-1)" } })
  }

  const pinLeft = () => {
    blurIfInside(options.leftDrawerContentEl())
    batch(() => {
      setLeftPinned(true)
      setLeftOpen(true)
    })
    persistPinIfSupported("left", true)
    measureDrawerHost()
  }

  const unpinLeft = () => {
    blurIfInside(options.leftDrawerContentEl())
    batch(() => {
      setLeftPinned(false)
      setLeftOpen(true)
    })
    persistPinIfSupported("left", false)
    measureDrawerHost()
  }

  const pinRight = () => {
    blurIfInside(options.rightDrawerContentEl())
    batch(() => {
      setRightPinned(true)
      setRightOpen(true)
    })
    persistPinIfSupported("right", true)
    measureDrawerHost()
  }

  const unpinRight = () => {
    blurIfInside(options.rightDrawerContentEl())
    batch(() => {
      setRightPinned(false)
      setRightOpen(true)
    })
    persistPinIfSupported("right", false)
    measureDrawerHost()
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
    if (leftDrawerState() === "pinned") return
    blurIfInside(options.leftDrawerContentEl())
    setLeftOpen(false)
    focusTarget(options.leftToggleButtonEl())
  }

  const closeRight = () => {
    if (rightDrawerState() === "pinned") return
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
    setLeftOpen,
    setRightOpen,
    leftDrawerState,
    rightDrawerState,
    pinLeft,
    unpinLeft,
    pinRight,
    unpinRight,
    closeLeft,
    closeRight,
    leftAppBarButtonLabel,
    rightAppBarButtonLabel,
    leftAppBarButtonIcon,
    rightAppBarButtonIcon,
    handleLeftAppBarButtonClick,
    handleRightAppBarButtonClick,
  }
}
