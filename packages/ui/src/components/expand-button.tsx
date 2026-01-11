import { createSignal, Show } from "solid-js"
import { Maximize2, Minimize2 } from "lucide-solid"

interface ExpandButtonProps {
  expandState: () => "normal" | "fifty" | "eighty"
  onToggleExpand: (nextState: "normal" | "fifty" | "eighty") => void
}

export default function ExpandButton(props: ExpandButtonProps) {
  const [clickTime, setClickTime] = createSignal<number>(0)
  const [clickTimer, setClickTimer] = createSignal<number | null>(null)
  const DOUBLE_CLICK_THRESHOLD = 300

  function handleClick() {
    const now = Date.now()
    const lastClick = clickTime()
    const isDoubleClick = now - lastClick < DOUBLE_CLICK_THRESHOLD

    // Clear any pending single-click timer
    const timer = clickTimer()
    if (timer !== null) {
      clearTimeout(timer)
      setClickTimer(null)
    }

    const current = props.expandState()

    if (isDoubleClick) {
      // Double click behavior - execute immediately
      if (current === "normal") {
        props.onToggleExpand("eighty")
      } else if (current === "fifty") {
        props.onToggleExpand("eighty")
      } else {
        props.onToggleExpand("fifty")
      }
      // Reset click time to prevent triple-click issues
      setClickTime(0)
    } else {
      // Single click behavior - delay to wait for potential double-click
      setClickTime(now)

      const newTimer = window.setTimeout(() => {
        const currentState = props.expandState()
        if (currentState === "normal") {
          props.onToggleExpand("fifty")
        } else {
          props.onToggleExpand("normal")
        }
        setClickTimer(null)
      }, DOUBLE_CLICK_THRESHOLD)

      setClickTimer(newTimer)
    }
  }

  const getTooltip = () => {
    const current = props.expandState()
    if (current === "normal") {
      return "Click to expand (50%) • Double-click to expand further (80%)"
    } else if (current === "fifty") {
      return "Double-click to expand to 80% • Click to minimize"
    } else {
      return "Click to minimize • Double-click to reduce to 50%"
    }
  }

  return (
    <button
      type="button"
      class="prompt-expand-button"
      onClick={handleClick}
      disabled={false}
      aria-label="Toggle chat input height"
      data-tooltip={getTooltip()}
    >
      <Show
        when={props.expandState() === "normal"}
        fallback={<Minimize2 class="h-5 w-5" aria-hidden="true" />}
      >
        <Maximize2 class="h-5 w-5" aria-hidden="true" />
      </Show>
    </button>
  )
}
