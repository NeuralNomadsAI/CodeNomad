import { Loader2, Mic } from "lucide-solid"
import { createSignal, Show } from "solid-js"
import type { RecordingState } from "./recording-controller"

interface DictationButtonProps {
  title: string
  state: RecordingState
  canStart: boolean
  separateCapture: boolean
  start(): void
  stop(): void
  cancel(): void
}

export default function DictationButton(props: DictationButtonProps) {
  const [held, setHeld] = createSignal<number | string>()

  function release(id: number | string, cancel = false) {
    if (held() !== id) return
    setHeld(undefined)
    if (cancel || props.state === "starting") props.cancel()
    else if (props.state === "recording") props.stop()
  }

  const holdKey = (key: string) => key === " " || key === "Enter"

  return (
    <button
      type="button"
      class="voice-button"
      classList={{ recording: props.state === "recording" }}
      aria-label={props.title}
      title={props.title}
      disabled={held() === undefined && !props.canStart}
      onPointerDown={event => {
        if (props.separateCapture || event.button !== 0 || !event.isPrimary || !props.canStart || held() !== undefined) return
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        setHeld(event.pointerId)
        props.start()
      }}
      onPointerUp={event => release(event.pointerId)}
      onPointerCancel={event => release(event.pointerId, true)}
      onLostPointerCapture={event => release(event.pointerId, true)}
      onKeyDown={event => {
        if (props.separateCapture || !holdKey(event.key)) return
        event.preventDefault()
        if (event.repeat || !props.canStart || held() !== undefined) return
        setHeld(event.key)
        props.start()
      }}
      onKeyUp={event => {
        if (props.separateCapture || !holdKey(event.key)) return
        event.preventDefault()
        release(event.key)
      }}
      onBlur={() => {
        const key = held()
        if (typeof key === "string") release(key, true)
      }}
      onClick={() => { if (props.separateCapture && props.canStart) props.start() }}
      onContextMenu={event => event.preventDefault()}
    >
      <Show when={props.state === "transcribing"} fallback={<Mic class="h-4 w-4" aria-hidden="true" />}>
        <span class="inline-flex animate-spin"><Loader2 class="h-4 w-4" aria-hidden="true" /></span>
      </Show>
    </button>
  )
}
