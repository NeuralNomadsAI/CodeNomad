import { Show } from "solid-js"
import { Maximize2, Minimize2 } from "lucide-solid"
import { Button } from "./ui"

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
    <Button
      variant="ghost"
      size="icon"
      type="button"
      class="w-7 h-7 flex-shrink-0 text-muted-foreground bg-black/[0.04] hover:bg-secondary hover:text-foreground active:bg-info active:text-primary-foreground active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
      onClick={handleClick}
      aria-label="Toggle chat input height"
    >
      <Show
        when={props.expandState() === "normal"}
        fallback={<Minimize2 class="h-4 w-4" aria-hidden="true" />}
      >
        <Maximize2 class="h-4 w-4" aria-hidden="true" />
      </Show>
    </Button>
  )
}
