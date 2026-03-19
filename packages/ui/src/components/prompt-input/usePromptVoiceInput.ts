import type { Accessor } from "solid-js"
import { usePromptBufferedVoiceInput } from "./usePromptBufferedVoiceInput"
import { usePromptRealtimeVoiceInput } from "./usePromptRealtimeVoiceInput"

interface UsePromptVoiceInputOptions {
  prompt: Accessor<string>
  setPrompt: (value: string, options?: { persistDraft?: boolean }) => void
  getTextarea: () => HTMLTextAreaElement | null
  enabled: Accessor<boolean>
  disabled: Accessor<boolean>
  useRealtime: Accessor<boolean>
}

export function usePromptVoiceInput(options: UsePromptVoiceInputOptions) {
  const buffered = usePromptBufferedVoiceInput(options)
  const realtime = usePromptRealtimeVoiceInput(options)

  const active = () => (options.useRealtime() ? realtime : buffered)

  return {
    state: () => active().state(),
    elapsedMs: () => active().elapsedMs(),
    canUseVoiceInput: () => active().canUseVoiceInput(),
    toggleRecording: () => active().toggleRecording(),
    cancelRecording: () => active().cancelRecording(),
    isRecording: () => active().isRecording(),
    isTranscribing: () => active().isTranscribing(),
    buttonTitle: () => active().buttonTitle(),
  }
}
