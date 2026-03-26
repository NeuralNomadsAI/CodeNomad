import { Loader2, Volume2 } from "lucide-solid"
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
        <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" stroke="none" />
        </svg>
      ) : (
        <Volume2 class="w-3.5 h-3.5" aria-hidden="true" />
      )}
    </button>
  )
}
