import { createSignal, Show } from "solid-js"
import AgentSelector from "./agent-selector"
import ModelSelector from "./model-selector"

interface PromptInputProps {
  instanceId: string
  sessionId: string
  onSend: (prompt: string) => Promise<void>
  disabled?: boolean
  agent: string
  model: { providerId: string; modelId: string }
  onAgentChange: (agent: string) => Promise<void>
  onModelChange: (model: { providerId: string; modelId: string }) => Promise<void>
}

export default function PromptInput(props: PromptInputProps) {
  const [prompt, setPrompt] = createSignal("")
  const [sending, setSending] = createSignal(false)
  let textareaRef: HTMLTextAreaElement | undefined

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  async function handleSend() {
    const text = prompt().trim()
    if (!text || sending() || props.disabled) return

    setSending(true)
    try {
      await props.onSend(text)
      setPrompt("")

      if (textareaRef) {
        textareaRef.style.height = "auto"
      }
    } catch (error) {
      console.error("Failed to send message:", error)
      alert("Failed to send message: " + (error instanceof Error ? error.message : String(error)))
    } finally {
      setSending(false)
      textareaRef?.focus()
    }
  }

  function handleInput(e: Event) {
    const target = e.target as HTMLTextAreaElement
    setPrompt(target.value)

    target.style.height = "auto"
    target.style.height = Math.min(target.scrollHeight, 200) + "px"
  }

  const canSend = () => prompt().trim().length > 0 && !sending() && !props.disabled

  return (
    <div class="prompt-input-container">
      <div class="prompt-input-wrapper">
        <textarea
          ref={textareaRef}
          class="prompt-input"
          placeholder="Type your message or /command..."
          value={prompt()}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          disabled={sending() || props.disabled}
          rows={1}
        />
        <button class="send-button" onClick={handleSend} disabled={!canSend()} aria-label="Send message">
          <Show when={sending()} fallback={<span class="send-icon">▶</span>}>
            <span class="spinner-small" />
          </Show>
        </button>
      </div>
      <div class="prompt-input-hints">
        <span class="hint">
          <kbd>Enter</kbd> to send, <kbd>Shift+Enter</kbd> for new line
        </span>
        <div class="flex items-center gap-2">
          <AgentSelector
            instanceId={props.instanceId}
            sessionId={props.sessionId}
            currentAgent={props.agent}
            onAgentChange={props.onAgentChange}
          />
          <ModelSelector
            instanceId={props.instanceId}
            sessionId={props.sessionId}
            currentModel={props.model}
            onModelChange={props.onModelChange}
          />
        </div>
      </div>
    </div>
  )
}
