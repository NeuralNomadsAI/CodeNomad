import { Loader2, Square, Volume2 } from "lucide-solid"
import type { JSX } from "solid-js"

interface SpeechActionButtonProps {
  class?: string
  title: string
  isLoading: boolean
  isPlaying: boolean
  onClick: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>
  type?: "button" | "submit" | "reset"
}

export default function SpeechActionButton(props: SpeechActionButtonProps) {
  return (
    <button
      type={props.type ?? "button"}
      class={props.class}
      onClick={props.onClick}
      aria-label={props.title}
      title={props.title}
    >
      {props.isLoading ? (
        <Loader2 class="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
      ) : props.isPlaying ? (
        <Square class="w-3.5 h-3.5" aria-hidden="true" />
      ) : (
        <Volume2 class="w-3.5 h-3.5" aria-hidden="true" />
      )}
    </button>
  )
}
