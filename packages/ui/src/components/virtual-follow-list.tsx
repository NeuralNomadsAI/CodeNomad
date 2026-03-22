import { Show, createEffect, createMemo, createSignal, onCleanup, type Accessor, type JSX, on } from "solid-js"
import { Virtualizer, type VirtualizerHandle } from "virtua/solid"

const DEFAULT_SCROLL_SENTINEL_MARGIN_PX = 48
const USER_SCROLL_INTENT_WINDOW_MS = 600
const SCROLL_INTENT_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Spacebar"])

export interface VirtualFollowListApi {
  scrollToTop: (opts?: { immediate?: boolean }) => void
  scrollToBottom: (opts?: { immediate?: boolean; suppressAutoAnchor?: boolean }) => void
  scrollToKey: (
    key: string,
    opts?: { behavior?: ScrollBehavior; block?: ScrollLogicalPosition; setAutoScroll?: boolean },
  ) => void
  notifyContentRendered: () => void
  setAutoScroll: (enabled: boolean) => void
  getAutoScroll: () => boolean
  getScrollElement: () => HTMLDivElement | undefined
  getShellElement: () => HTMLDivElement | undefined
}

export interface VirtualFollowListState {
  autoScroll: Accessor<boolean>
  showScrollTopButton: Accessor<boolean>
  showScrollBottomButton: Accessor<boolean>
  scrollButtonsCount: Accessor<number>
  activeKey: Accessor<string | null>
}

export interface VirtualFollowListProps<T> {
  items: Accessor<T[]>
  getKey: (item: T, index: number) => string
  renderItem: (item: T, index: number) => JSX.Element

  /**
   * Optional stable DOM id for the item wrapper.
   * Defaults to the key itself.
   */
  getAnchorId?: (key: string) => string

  /**
   * Decode an item key from an observed wrapper element id.
   * Defaults to identity.
   */
  getKeyFromAnchorId?: (anchorId: string) => string

  overscanPx?: number
  scrollSentinelMarginPx?: number
  virtualizationEnabled?: Accessor<boolean>
  suspendMeasurements?: Accessor<boolean>
  loading?: Accessor<boolean>
  isActive?: Accessor<boolean>

  /**
   * When switching back to an inactive (cached) pane, the list historically
   * re-pinned to the bottom if autoScroll was enabled.
   *
   * Disable this to preserve the existing scroll position across pane switches.
   */
  scrollToBottomOnActivate?: Accessor<boolean>

  /**
   * Controls whether the list should scroll to bottom the first time items
   * appear (default behavior for chat streams).
   *
   * Set to false when an outer component restores scroll from a cache.
   */
  initialScrollToBottom?: Accessor<boolean>

  /**
   * Initial value for the internal autoScroll signal.
   * Useful when restoring scroll state (e.g. start in non-follow mode).
   */
  initialAutoScroll?: Accessor<boolean>

  /**
   * When this value changes, the list resets internal follow/anchor state.
   * Useful when reusing the same list instance across different datasets.
   */
  resetKey?: Accessor<string | number>

  /**
   * If this value changes and autoScroll is enabled, the list will
   * anchor-scroll to the bottom (unless suppressed).
   */
  followToken?: Accessor<string | number>

  /**
   * Optional hooks to render content inside the scroll container.
   * Useful for empty/loading states that should scroll with the list.
   */
  renderBeforeItems?: Accessor<JSX.Element>

  /**
   * Render content inside the shell, above timeline/sidebar layers.
   * (Quote popovers, etc.)
   */
  renderOverlay?: Accessor<JSX.Element>

  /**
   * Provide localized labels for built-in controls.
   */
  scrollToTopAriaLabel?: Accessor<string>
  scrollToBottomAriaLabel?: Accessor<string>

  /**
   * Receive element refs for external logic (selection, geometry, etc.)
   */
  onScrollElementChange?: (element: HTMLDivElement | undefined) => void
  onShellElementChange?: (element: HTMLDivElement | undefined) => void

  /**
   * Callbacks for consumers.
   */
  onScroll?: () => void
  onMouseUp?: (event: MouseEvent) => void
  onClick?: (event: MouseEvent) => void
  onActiveKeyChange?: (key: string | null) => void
  registerApi?: (api: VirtualFollowListApi) => void
  registerState?: (state: VirtualFollowListState) => void
  renderControls?: (state: VirtualFollowListState, api: VirtualFollowListApi) => JSX.Element
}

export default function VirtualFollowList<T>(props: VirtualFollowListProps<T>) {
  const [scrollElement, setScrollElement] = createSignal<HTMLDivElement | undefined>()
  const [shellElement, setShellElement] = createSignal<HTMLDivElement | undefined>()
  const [virtuaHandle, setVirtuaHandle] = createSignal<VirtualizerHandle | undefined>()

  const isActive = () => (props.isActive ? props.isActive() : true)
  const scrollToBottomOnActivate = () => (props.scrollToBottomOnActivate ? props.scrollToBottomOnActivate() : true)
  const initialScrollToBottom = () => (props.initialScrollToBottom ? props.initialScrollToBottom() : true)
  const initialAutoScroll = () => (props.initialAutoScroll ? props.initialAutoScroll() : true)

  const [autoScroll, setAutoScroll] = createSignal(Boolean(initialAutoScroll()))
  const [showScrollTopButton, setShowScrollTopButton] = createSignal(false)
  const [showScrollBottomButton, setShowScrollBottomButton] = createSignal(false)
  const [activeKey, setActiveKey] = createSignal<string | null>(null)

  const scrollButtonsCount = createMemo(() => (showScrollTopButton() ? 1 : 0) + (showScrollBottomButton() ? 1 : 0))

  let userScrollIntentUntil = 0
  let lastUserScrollIntentDirection: "up" | "down" | null = null
  let detachScrollIntentListeners: (() => void) | undefined
  let lastResetKey: string | number | undefined
  let suppressAutoScrollOnce = false
  let pendingInitialScroll = true

  const state: VirtualFollowListState = {
    autoScroll,
    showScrollTopButton,
    showScrollBottomButton,
    scrollButtonsCount,
    activeKey,
  }

  function markUserScrollIntent(direction?: "up" | "down" | null) {
    const now = performance.now()
    userScrollIntentUntil = now + USER_SCROLL_INTENT_WINDOW_MS
    if (direction) {
      lastUserScrollIntentDirection = direction
    }
  }

  function hasUserScrollIntent() {
    return performance.now() <= userScrollIntentUntil
  }

  function attachScrollIntentListeners(element: HTMLDivElement | undefined) {
    if (detachScrollIntentListeners) {
      detachScrollIntentListeners()
      detachScrollIntentListeners = undefined
    }
    if (!element) return
    const handleWheelIntent = (event: WheelEvent) => {
      const dir: "up" | "down" | null = event.deltaY < 0 ? "up" : event.deltaY > 0 ? "down" : null
      markUserScrollIntent(dir)
    }
    const handlePointerIntent = () => markUserScrollIntent(null)
    const handleKeyIntent = (event: KeyboardEvent) => {
      if (!SCROLL_INTENT_KEYS.has(event.key)) return
      const key = event.key
      const dir: "up" | "down" | null =
        key === "ArrowUp" || key === "PageUp" || key === "Home"
          ? "up"
          : key === "ArrowDown" || key === "PageDown" || key === "End"
            ? "down"
            : key === " " || key === "Spacebar"
              ? event.shiftKey
                ? "up"
                : "down"
              : null
      markUserScrollIntent(dir)
    }
    element.addEventListener("wheel", handleWheelIntent, { passive: true })
    element.addEventListener("pointerdown", handlePointerIntent)
    element.addEventListener("touchstart", handlePointerIntent, { passive: true })
    element.addEventListener("keydown", handleKeyIntent)
    detachScrollIntentListeners = () => {
      element.removeEventListener("wheel", handleWheelIntent)
      element.removeEventListener("pointerdown", handlePointerIntent)
      element.removeEventListener("touchstart", handlePointerIntent)
      element.removeEventListener("keydown", handleKeyIntent)
    }
  }

  function updateScrollButtons() {
    const handle = virtuaHandle()
    const element = scrollElement()
    if (!handle || !element) return

    const offset = handle.scrollOffset
    const scrollHeight = handle.scrollSize
    const clientHeight = element.clientHeight
    const atBottom = scrollHeight - (offset + clientHeight) <= (props.scrollSentinelMarginPx ?? DEFAULT_SCROLL_SENTINEL_MARGIN_PX)
    const atTop = offset <= (props.scrollSentinelMarginPx ?? DEFAULT_SCROLL_SENTINEL_MARGIN_PX)

    const hasItems = props.items().length > 0
    setShowScrollBottomButton(hasItems && !atBottom)
    setShowScrollTopButton(hasItems && !atTop)

    // Sync autoScroll state based on scroll position if it was a user scroll
    if (hasUserScrollIntent()) {
      if (atBottom && !autoScroll()) {
        setAutoScroll(true)
      } else if (!atBottom && autoScroll()) {
        setAutoScroll(false)
      }
    }
  }

  function scrollToBottom(immediate = true, options?: { suppressAutoAnchor?: boolean }) {
    const handle = virtuaHandle()
    if (!handle) return
    if (options?.suppressAutoAnchor ?? !immediate) {
      suppressAutoScrollOnce = true
    }
    handle.scrollToIndex(props.items().length - 1, { align: "end", smooth: !immediate })
    setAutoScroll(true)
  }

  function scrollToTop(immediate = true) {
    const handle = virtuaHandle()
    if (!handle) return
    handle.scrollToIndex(0, { align: "start", smooth: !immediate })
    setAutoScroll(false)
  }

  function handleScroll() {
    const isUserScroll = hasUserScrollIntent()
    if (isUserScroll) {
      if (lastUserScrollIntentDirection === "up" && autoScroll()) {
        setAutoScroll(false)
      }
    }
    updateScrollButtons()
    props.onScroll?.()

    // Find active key (roughly the first visible item)
    const handle = virtuaHandle()
    if (handle) {
      const start = handle.findItemIndex(handle.scrollOffset)
      const items = props.items()
      if (items[start]) {
        const key = props.getKey(items[start], start)
        if (key !== activeKey()) {
          setActiveKey(key)
          props.onActiveKeyChange?.(key)
        }
      }
    }
  }

  const api: VirtualFollowListApi = {
    scrollToTop: (opts) => scrollToTop(opts?.immediate ?? true),
    scrollToBottom: (opts) => scrollToBottom(opts?.immediate ?? true, { suppressAutoAnchor: opts?.suppressAutoAnchor }),
    scrollToKey: (key, opts) => {
      const index = props.items().findIndex((item, i) => props.getKey(item, i) === key)
      if (index === -1) return
      const nextAutoScroll = opts?.setAutoScroll ?? false
      setAutoScroll(nextAutoScroll)
      virtuaHandle()?.scrollToIndex(index, { align: opts?.block ?? "start", smooth: opts?.behavior === "smooth" })
    },
    notifyContentRendered: () => {
      if (autoScroll()) {
        scrollToBottom(true)
      }
    },
    setAutoScroll: (enabled) => setAutoScroll(Boolean(enabled)),
    getAutoScroll: () => autoScroll(),
    getScrollElement: () => scrollElement(),
    getShellElement: () => shellElement(),
  }

  createEffect(() => props.registerApi?.(api))
  createEffect(() => props.registerState?.(state))

  // Handle autoScroll (Follow) on items change
  createEffect(on(() => props.items().length, (len, prevLen) => {
    if (len > (prevLen ?? 0) && autoScroll() && !suppressAutoScrollOnce) {
      requestAnimationFrame(() => scrollToBottom(true))
    }
    suppressAutoScrollOnce = false
  }, { defer: true }))

  // Handle followToken change
  createEffect(on(() => props.followToken?.(), () => {
    if (autoScroll()) {
      scrollToBottom(true)
    }
  }, { defer: true }))

  // Reset state on resetKey change
  createEffect(on(() => props.resetKey?.(), (nextKey) => {
    if (nextKey === lastResetKey) return
    lastResetKey = nextKey
    setAutoScroll(initialAutoScroll())
    pendingInitialScroll = true
  }))

  // Initial scroll and session activation
  createEffect(() => {
    const active = isActive()
    if (!active) return
    if (pendingInitialScroll && props.items().length > 0) {
      pendingInitialScroll = false
      if (initialScrollToBottom()) {
        scrollToBottom(true)
      }
    } else if (autoScroll() && scrollToBottomOnActivate()) {
      scrollToBottom(true)
    }
  })

  return (
    <div class="virtual-follow-list-shell" ref={shellElement => {
      setShellElement(shellElement)
      props.onShellElementChange?.(shellElement)
    }}>
      <div
        class="message-stream"
        ref={el => {
          setScrollElement(el)
          props.onScrollElementChange?.(el)
          attachScrollIntentListeners(el)
        }}
        onMouseUp={props.onMouseUp}
        onClick={props.onClick}
      >
        <Show when={props.renderBeforeItems}>
          {props.renderBeforeItems!()}
        </Show>
        <Virtualizer
          ref={setVirtuaHandle}
          scrollRef={scrollElement()}
          data={props.items()}
          bufferSize={props.overscanPx ?? 400}
          onScroll={handleScroll}
        >
          {(item, index) => props.renderItem(item, index())}
        </Virtualizer>
      </div>

      <Show when={props.renderOverlay}>
        <div class="virtual-follow-list-overlay">{props.renderOverlay!()}</div>
      </Show>

      <Show when={props.renderControls}>
        <div class="virtual-follow-list-controls-container">{props.renderControls!(state, api)}</div>
      </Show>

      <Show
        when={
          !props.renderControls &&
          (showScrollTopButton() || showScrollBottomButton()) &&
          props.scrollToTopAriaLabel &&
          props.scrollToBottomAriaLabel
        }
      >
        <div class="message-scroll-button-wrapper">
          <Show when={showScrollTopButton()}>
            <button type="button" class="message-scroll-button" onClick={() => scrollToTop()} aria-label={props.scrollToTopAriaLabel!()}>
              <span class="message-scroll-icon" aria-hidden="true">
                ↑
              </span>
            </button>
          </Show>
          <Show when={showScrollBottomButton()}>
            <button type="button" class="message-scroll-button" onClick={() => scrollToBottom()} aria-label={props.scrollToBottomAriaLabel!()}>
              <span class="message-scroll-icon" aria-hidden="true">
                ↓
              </span>
            </button>
          </Show>
        </div>
      </Show>
    </div>
  )
}
