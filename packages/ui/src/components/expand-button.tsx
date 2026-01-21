import { Show } from "solid-js"
import { Maximize2, Minimize2 } from "lucide-solid"

interface ExpandButtonProps {
  expandState: () => "normal" | "expanded"
  onToggleExpand: (nextState: "normal" | "expanded") => void
}

export default function ExpandButton(props: ExpandButtonProps) {
  function handleClick() {
    const current = props.expandState()
    props.onToggleExpand(current === "normal" ? "expanded" : "normal")
  }

  return (
    <button
      type="button"
      class="prompt-expand-button"
      onClick={handleClick}
      aria-label="Toggle chat input height"
    >
      <Show
        when={props.expandState() === "normal"}
        fallback={<Minimize2 class="h-4 w-4" aria-hidden="true" />}
      >
        <Maximize2 class="h-4 w-4" aria-hidden="true" />
      </Show>
    </button>
  )
}
