import { Show, createMemo, createSignal, createUniqueId, type Accessor, type JSX } from "solid-js"
import { useI18n } from "../lib/i18n"
import { scrollAxes } from "../lib/scroll-gesture-routing"
import {
  getRenderTextWindow,
  TOOL_OUTPUT_RENDER_CHARACTER_LIMIT,
  type RenderTextWindow,
  type TextSource,
} from "../lib/render-text-window"
import {
  getRevealedRecordText,
  revealHiddenRecordText,
  type RecordTextRevealTarget,
} from "../stores/message-v2/record-display-cache"
import type { AlignInTranscript } from "./search-highlight-ranges"
import { focusRevealedElement } from "./reveal-focus"
import { useTranscriptAlignment } from "./transcript-alignment"

// Async Markdown can land the revealed text well after the click; stop waiting after this.
const REVEAL_LANDING_TIMEOUT_MS = 10_000
// The transcript list re-measures a held element for about 30 frames.
const REVEAL_ANCHOR_LINGER_MS = 1_500

const sameWindow = (a: RenderTextWindow, b: RenderTextWindow) =>
  a.text === b.text && a.hidden === b.hidden && a.revealsAll === b.revealsAll && a.nextReveal === b.nextReveal

/**
 * Reactive display window of `source`. With a `target` the reveal lives in the
 * record display cache (surviving remounts); without one it lasts for this owner.
 */
export function createTextWindow(options: {
  source: Accessor<string | TextSource>
  limit: Accessor<number>
  target: Accessor<RecordTextRevealTarget | undefined>
}) {
  const [localSteps, setLocalSteps] = createSignal(0)
  const steps = () => {
    const target = options.target()
    return target ? getRevealedRecordText(target) : localSteps()
  }
  const window = createMemo(() => getRenderTextWindow(options.source(), options.limit(), steps()), undefined, { equals: sameWindow })
  const reveal = () => {
    const target = options.target()
    if (target) revealHiddenRecordText(target)
    else setLocalSteps((value) => value + 1)
  }
  return { window, steps, reveal }
}

function insideNestedScroller(element: HTMLElement, transcript: HTMLElement) {
  for (let node = element.parentElement; node && node !== transcript; node = node.parentElement) {
    if (scrollAxes(node).y) return true
  }
  return false
}

/**
 * An absolutely positioned marker at the former reveal point. Revealed text grows
 * below it, so holding it keeps the reader's place where bottom-following or the
 * list's compensation for a row starting above the viewport would move it.
 */
function placeRevealAnchor(notice: HTMLElement): HTMLElement | null {
  const row = notice.closest<HTMLElement>("[data-virtual-follow-key]")
  if (!row) return null
  const anchor = document.createElement("span")
  anchor.className = "message-hidden-text-anchor"
  anchor.setAttribute("aria-hidden", "true")
  row.appendChild(anchor)
  const parent = anchor.offsetParent ?? row
  anchor.style.top = `${notice.getBoundingClientRect().top - parent.getBoundingClientRect().top - parent.clientTop}px`
  return anchor
}

function holdRevealAnchor(anchor: HTMLElement, offset: number, align: AlignInTranscript, block: HTMLElement | null, blockHeight: number) {
  let lingering: ReturnType<typeof setTimeout> | undefined
  let observer: ResizeObserver | undefined
  const landing = setTimeout(() => release(), REVEAL_LANDING_TIMEOUT_MS)
  const release = () => {
    observer?.disconnect()
    clearTimeout(landing)
    clearTimeout(lingering)
    anchor.remove()
  }
  const hold = () => {
    if (!anchor.isConnected) return release()
    align(anchor, offset)
    clearTimeout(lingering)
    lingering = setTimeout(release, REVEAL_ANCHOR_LINGER_MS)
  }
  if (block && typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(() => {
      if (block.getBoundingClientRect().height <= blockHeight) return
      observer?.disconnect()
      hold()
    })
    observer.observe(block)
  }
  // Hold before the text grows, so bottom-following never moves it for a frame;
  // synchronous renderers have grown by the next frame, Markdown may commit later.
  hold()
  requestAnimationFrame(hold)
}

/** Reveals in place: keeps the reveal point where it was and keyboard focus with the revealed text. */
function revealTextInPlace(button: HTMLButtonElement, reveal: () => void, align: AlignInTranscript | undefined) {
  const notice = button.closest<HTMLElement>(".message-hidden-text")
  if (!notice) return reveal()
  const content = notice.previousElementSibling as HTMLElement | null
  const block = notice.parentElement
  const transcript = notice.closest<HTMLElement>(".message-stream")
  const hadFocus = document.activeElement === button
  // A block inside its own scroller (tool output panes) grows there, where the
  // browser keeps the scroll position; only transcript-level growth needs a hold.
  const anchor = align && transcript && !insideNestedScroller(notice, transcript) ? placeRevealAnchor(notice) : null
  const offset = anchor && transcript ? notice.getBoundingClientRect().top - transcript.getBoundingClientRect().top : 0
  const blockHeight = block?.getBoundingClientRect().height ?? 0
  if (anchor && align) holdRevealAnchor(anchor, offset, align, block, blockHeight)
  reveal()
  requestAnimationFrame(() => {
    // "Show N more" keeps its control mounted and focused for the next step.
    if (!hadFocus || button.isConnected) return
    const active = document.activeElement
    if (active && active !== document.body) return
    if (content?.isConnected) focusRevealedElement(content)
  })
}

/** Status line closing a display-bounded text block, directly after the bounded content. */
export function HiddenTextNotice(props: { window: RenderTextWindow; onReveal: () => void }) {
  const { t, locale } = useI18n()
  const align = useTranscriptAlignment()
  const labelId = createUniqueId()
  const format = (value: number) => new Intl.NumberFormat(locale()).format(value)
  return (
    <div class="message-hidden-text">
      <span id={labelId} class="message-hidden-text-label">
        {t(props.window.hidden === 1 ? "messageBlock.hiddenText.one" : "messageBlock.hiddenText.other", { count: format(props.window.hidden) })}
      </span>
      <button
        type="button"
        class="button-secondary message-hidden-text-button"
        aria-describedby={labelId}
        onClick={(event) => revealTextInPlace(event.currentTarget, props.onReveal, align)}
      >
        {props.window.revealsAll
          ? t("messageBlock.hiddenText.showAll")
          : t("messageBlock.hiddenText.showMore", { count: format(props.window.nextReveal) })}
      </button>
    </div>
  )
}

/** Renders the display window of `source` through `children`, followed by its reveal line. */
export function BoundedText(props: {
  source: string | TextSource
  limit?: number
  revealTarget?: RecordTextRevealTarget
  children: (text: Accessor<string>) => JSX.Element
}) {
  const bounded = createTextWindow({
    source: () => props.source,
    limit: () => props.limit ?? TOOL_OUTPUT_RENDER_CHARACTER_LIMIT,
    target: () => props.revealTarget,
  })
  const text = createMemo(() => bounded.window().text)
  return (
    <>
      {props.children(text)}
      <Show when={bounded.window().hidden > 0}>
        <HiddenTextNotice window={bounded.window()} onReveal={bounded.reveal} />
      </Show>
    </>
  )
}
