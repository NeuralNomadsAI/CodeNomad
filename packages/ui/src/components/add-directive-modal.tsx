import { Component, createSignal, createMemo, Show, For } from "solid-js"
import { X, Sparkles, RefreshCw, Plus, ChevronDown } from "lucide-solid"
import { cn } from "../lib/cn"
import { Button } from "./ui"
import {
  formatDirectiveRuleBased,
  validateDirective,
  getSuggestedSections,
  type FormatResult,
} from "../lib/directive-formatter"

interface AddDirectiveModalProps {
  open: boolean
  onClose: () => void
  type: "project" | "global"
  existingSections: string[]
  defaultSection?: string
  onAdd: (text: string, section?: string) => void
}

const AddDirectiveModal: Component<AddDirectiveModalProps> = (props) => {
  const [input, setInput] = createSignal("")
  const [selectedSection, setSelectedSection] = createSignal<string>(props.defaultSection || "")
  const [isNewSection, setIsNewSection] = createSignal(false)
  const [newSectionName, setNewSectionName] = createSignal("")
  const [formatResult, setFormatResult] = createSignal<FormatResult | null>(null)
  const [isFormatting, setIsFormatting] = createSignal(false)
  const [validationError, setValidationError] = createSignal<string | null>(null)

  // Combine existing sections with suggested sections
  const allSections = createMemo(() => {
    const existing = props.existingSections
    const suggested = getSuggestedSections()
    const combined = new Set([...existing, ...suggested])
    return Array.from(combined).sort()
  })

  const handleInputChange = (value: string) => {
    setInput(value)
    setFormatResult(null)
    setValidationError(null)
  }

  const handleFormat = async () => {
    const text = input().trim()
    const validation = validateDirective(text)

    if (!validation.valid) {
      setValidationError(validation.error || "Invalid directive")
      return
    }

    setIsFormatting(true)
    setValidationError(null)

    try {
      // Use rule-based formatting (AI can be added later)
      const result = formatDirectiveRuleBased(text, props.existingSections)
      setFormatResult(result)

      // Auto-select the suggested section if none is selected
      if (!selectedSection()) {
        setSelectedSection(result.suggestedSection)
      }
    } finally {
      setIsFormatting(false)
    }
  }

  const handleAdd = () => {
    const formatted = formatResult()
    const text = formatted?.formatted || input().trim()

    const validation = validateDirective(text)
    if (!validation.valid) {
      setValidationError(validation.error || "Invalid directive")
      return
    }

    const section = isNewSection() ? newSectionName().trim() : selectedSection()
    props.onAdd(text, section || undefined)

    // Reset form
    setInput("")
    setSelectedSection("")
    setNewSectionName("")
    setIsNewSection(false)
    setFormatResult(null)
    setValidationError(null)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      props.onClose()
    }
    if (e.key === "Enter" && e.metaKey) {
      e.preventDefault()
      if (formatResult()) {
        handleAdd()
      } else {
        handleFormat()
      }
    }
  }

  const canAdd = () => {
    const text = formatResult()?.formatted || input().trim()
    return text.length >= 5 && (isNewSection() ? newSectionName().trim() : true)
  }

  return (
    <Show when={props.open}>
      <div
        class={cn("fixed inset-0 flex items-center justify-center p-4 bg-black/60 z-[100]")}
        onClick={props.onClose}
        onKeyDown={handleKeyDown}
      >
        <div
          class={cn("w-full max-w-lg rounded-xl overflow-hidden bg-background border border-border shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5)]")}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div class={cn("flex items-center justify-between px-6 py-4 border-b border-border")}>
            <h3 class={cn("text-lg font-semibold text-foreground")}>
              {props.type === "project" ? "Add Project Directive" : "Add Global Directive"}
            </h3>
            <button type="button" class={cn("p-1 rounded transition-colors text-muted-foreground hover:text-foreground")} onClick={props.onClose}>
              <X class="w-5 h-5" />
            </button>
          </div>

          {/* Body */}
          <div class={cn("p-6 space-y-4")}>
            {/* Input */}
            <div class={cn("space-y-2")}>
              <label class={cn("block text-sm font-medium text-foreground")}>Directive</label>
              <textarea
                class={cn(
                  "w-full p-3 rounded-lg text-sm resize-none min-h-[80px]",
                  "bg-secondary border border-border text-foreground",
                  "placeholder:text-muted-foreground",
                  "focus:outline-none focus:border-info"
                )}
                value={input()}
                onInput={(e) => handleInputChange(e.currentTarget.value)}
                placeholder="Describe your directive in natural language, e.g., 'Always use TypeScript for new files' or 'Never commit API keys to the repository'"
                autofocus
              />
              <p class={cn("text-xs text-muted-foreground")}>
                Type your directive in natural language. It will be formatted automatically.
              </p>
            </div>

            {/* Validation Error */}
            <Show when={validationError()}>
              <div class={cn("p-3 rounded-md text-sm bg-destructive/10 text-destructive")}>
                {validationError()}
              </div>
            </Show>

            {/* Format Button - now optional, shown as secondary action */}
            <Show when={!formatResult() && input().trim().length >= 5}>
              <div class="flex gap-2">
                <button
                  type="button"
                  class={cn(
                    "flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors",
                    "bg-accent border border-border text-foreground",
                    "hover:bg-accent/80",
                    "disabled:opacity-50 disabled:cursor-not-allowed"
                  )}
                  onClick={handleFormat}
                  disabled={isFormatting()}
                >
                  {isFormatting() ? (
                    <>
                      <RefreshCw class="w-4 h-4 animate-spin" />
                      Formatting...
                    </>
                  ) : (
                    <>
                      <Sparkles class="w-4 h-4" />
                      Preview & Choose Section
                    </>
                  )}
                </button>
              </div>
              <p class={cn("text-xs text-muted-foreground text-center")}>
                Or add directly to the default section
              </p>
            </Show>

            {/* Format Preview */}
            <Show when={formatResult()}>
              <div class={cn("p-4 rounded-lg bg-secondary border border-border")}>
                <div class={cn("text-xs font-medium uppercase tracking-wide mb-2 text-muted-foreground")}>Formatted Directive</div>
                <div class={cn("text-sm text-foreground")}>{formatResult()?.formatted}</div>
                <div class={cn("text-xs mt-2 text-muted-foreground")}>
                  Suggested section: <strong>{formatResult()?.suggestedSection}</strong>
                </div>
              </div>

              {/* Section Selection */}
              <div class={cn("space-y-2")}>
                <label class={cn("block text-sm font-medium text-foreground")}>Section</label>
                <Show when={!isNewSection()}>
                  <div class="flex gap-2">
                    <select
                      class={cn(
                        "flex-1 w-full p-2 rounded-lg text-sm",
                        "bg-secondary border border-border text-foreground",
                        "focus:outline-none focus:border-info"
                      )}
                      value={selectedSection()}
                      onChange={(e) => setSelectedSection(e.currentTarget.value)}
                    >
                      <option value="">Select a section...</option>
                      <For each={allSections()}>
                        {(section) => (
                          <option value={section}>{section}</option>
                        )}
                      </For>
                    </select>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setIsNewSection(true)}
                      title="Create new section"
                    >
                      <Plus class="w-4 h-4" />
                    </Button>
                  </div>
                </Show>
                <Show when={isNewSection()}>
                  <div class="flex gap-2">
                    <input
                      type="text"
                      class={cn(
                        "flex-1 w-full p-2 rounded-lg text-sm",
                        "bg-secondary border border-border text-foreground",
                        "focus:outline-none focus:border-info"
                      )}
                      value={newSectionName()}
                      onInput={(e) => setNewSectionName(e.currentTarget.value)}
                      placeholder="Enter new section name..."
                      autofocus
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setIsNewSection(false)
                        setNewSectionName("")
                      }}
                    >
                      <ChevronDown class="w-4 h-4" />
                    </Button>
                  </div>
                </Show>
              </div>
            </Show>
          </div>

          {/* Footer */}
          <div class={cn("flex items-center justify-end gap-3 px-6 py-4 border-t border-border bg-secondary")}>
            <Button variant="outline" size="sm" onClick={props.onClose}>
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                // Auto-format if not already formatted
                if (!formatResult() && input().trim().length >= 5) {
                  const result = formatDirectiveRuleBased(input().trim(), props.existingSections)
                  setFormatResult(result)
                  if (!selectedSection()) {
                    setSelectedSection(result.suggestedSection)
                  }
                }
                handleAdd()
              }}
              disabled={input().trim().length < 5}
            >
              <Plus class="w-4 h-4" />
              Add Directive
            </Button>
          </div>
        </div>
      </div>
    </Show>
  )
}

export default AddDirectiveModal
