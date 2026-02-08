import { createMemo, Show, For, createEffect, type Accessor } from "solid-js"
import type { ToolState } from "@opencode-ai/sdk"
import type { QuestionRequest } from "@opencode-ai/sdk/v2"
import { useI18n } from "../../lib/i18n"

type QuestionOption = { label: string; description: string }

type QuestionPrompt = {
  header: string
  question: string
  options: QuestionOption[]
  multiple?: boolean
}

export type QuestionToolBlockProps = {
  toolName: Accessor<string>
  toolState: Accessor<ToolState | undefined>
  toolCallId: Accessor<string>
  request: Accessor<QuestionRequest | undefined>
  active: Accessor<boolean>
  submitting: Accessor<boolean>
  error: Accessor<string | null>
  draftAnswers: Accessor<Record<string, string[][]>>
  setDraftAnswers: (updater: (prev: Record<string, string[][]>) => Record<string, string[][]>) => void
  onSubmit: () => void | Promise<void>
  onDismiss: () => void | Promise<void>
}

export function QuestionToolBlock(props: QuestionToolBlockProps) {
  const { t } = useI18n()
  let firstInputRef: HTMLInputElement | undefined

  createEffect(() => {
    if (props.active() && firstInputRef) {
      firstInputRef.focus()
    }
  })

  const requestId = createMemo(() => {
    const state = props.toolState()
    const request = props.request()
    return request?.id ?? (state as any)?.input?.requestID ?? `question-${props.toolCallId()}`
  })

  const questions = createMemo(() => {
    const state = props.toolState()
    const request = props.request()
    const isQuestionTool = props.toolName() === "question"
    if (!request && !isQuestionTool) return [] as QuestionPrompt[]

    const questionsSource = request?.questions ?? ((state as any)?.input?.questions as any[] | undefined) ?? []
    const list = Array.isArray(questionsSource) ? questionsSource : []
    return list as QuestionPrompt[]
  })

  const isVisible = createMemo(() => {
    const request = props.request()
    const isQuestionTool = props.toolName() === "question"
    return Boolean(request) || isQuestionTool
  })

  const answers = createMemo(() => {
    const state = props.toolState()

    const completedAnswers =
      (state as any)?.status === "completed" && Array.isArray((state as any)?.metadata?.answers)
        ? ((state as any).metadata.answers as string[][])
        : undefined

    if (completedAnswers) return completedAnswers

    const request = props.request()
    const requestAnswers = request?.questions?.map((q) => (q as any)?.answer) // defensive (if server ever inlines)

    if (Array.isArray(requestAnswers) && requestAnswers.some((row) => Array.isArray(row) && row.length > 0)) {
      return requestAnswers as string[][]
    }

    const draft = props.draftAnswers()[requestId()] ?? []
    return Array.isArray(draft) ? draft : []
  })

  const hasFinalAnswers = createMemo(() => {
    const state = props.toolState()
    if ((state as any)?.status === "completed") return true

    const request = props.request()
    const requestAnswers = request?.questions?.map((q) => (q as any)?.answer)
    if (Array.isArray(requestAnswers) && requestAnswers.length > 0) {
      return requestAnswers.every((row) => Array.isArray(row) && row.length > 0)
    }

    return false
  })

  const updateAnswer = (questionIndex: number, next: string[]) => {
    if (!props.active()) return
    props.setDraftAnswers((prev) => {
      const current = prev[requestId()] ?? []
      const updated = [...current]
      updated[questionIndex] = next
      return { ...prev, [requestId()]: updated }
    })
  }

  const toggleOption = (questionIndex: number, label: string) => {
    const info = questions()[questionIndex]
    const multi = info?.multiple === true
    const existing = answers()[questionIndex] ?? []
    if (multi) {
      const next = existing.includes(label) ? existing.filter((x) => x !== label) : [...existing, label]
      updateAnswer(questionIndex, next)
      return
    }
    updateAnswer(questionIndex, [label])
  }

  const submitDisabled = () => {
    if (!props.active()) return true
    if (props.submitting()) return true
    return questions().some((_, index) => (answers()[index]?.length ?? 0) === 0)
  }

  const toggleFromCustomInput = (questionIndex: number, input: HTMLInputElement | null) => {
    if (!props.active()) return
    const rawValue = input?.value ?? ""
    const value = rawValue
    if (value.trim().length === 0) return

    const info = questions()[questionIndex]
    const multi = info?.multiple === true
    if (!multi) {
      // When switching a radio to custom, clear existing selection first.
      updateAnswer(questionIndex, [])
      toggleOption(questionIndex, value)
      return
    }

    // For multi-select, focusing the input should never toggle an existing custom value off.
    // Ensure the current input value is selected; removal is handled by unchecking Custom.
    const existing = answers()[questionIndex] ?? []
    if (!existing.includes(value)) {
      updateAnswer(questionIndex, [...existing, value])
    }
  }

  const clearCustomAnswer = (questionIndex: number, valuesToRemove: string[]) => {
    if (!props.active()) return
    if (valuesToRemove.length === 0) return
    const existing = answers()[questionIndex] ?? []
    const next = existing.filter((value) => !valuesToRemove.includes(value))
    updateAnswer(questionIndex, next)
  }

  const handleCustomTyping = (questionIndex: number, input: HTMLInputElement) => {
    if (!props.active()) return

    const value = input.value
    const trimmed = value.trim()
    const info = questions()[questionIndex]
    const multi = info?.multiple === true

    if (!multi) {
      updateAnswer(questionIndex, trimmed.length > 0 ? [value] : [])
      return
    }

    const optionLabels = new Set((info?.options ?? []).map((opt) => opt.label))
    const existing = answers()[questionIndex] ?? []
    const last = input.dataset.lastValue ?? ""

    let next = existing.filter((item) => item !== last)

    if (trimmed.length > 0) {
      // Only treat it as custom if it doesn't match an existing option label.
      if (!optionLabels.has(trimmed) && !next.includes(value)) {
        next = [...next, value]
      } else if (optionLabels.has(trimmed)) {
        // If they typed an existing option label, don't treat it as custom.
      } else if (!next.includes(value)) {
        next = [...next, value]
      }
      input.dataset.lastValue = value
    } else {
      delete input.dataset.lastValue
    }

    updateAnswer(questionIndex, next)
  }

  return (
    <Show when={isVisible() && questions().length > 0}>
      <div
        class={`tool-call-permission p-0 gap-2 ${props.active() ? "tool-call-permission-active" : "tool-call-permission-queued"} ${hasFinalAnswers() ? "tool-call-permission-answered" : ""}`}
      >
        <div class="tool-call-permission-body">
          <div class="flex flex-col gap-2">
            <For each={questions()}>
              {(q, index) => {
                const i = () => index()
                const multi = () => q?.multiple === true
                const selected = () => answers()[i()] ?? []
                const inputType = () => (multi() ? "checkbox" : "radio")
                const groupName = () => `question-${requestId()}-${i()}`
                const optionLabels = () => new Set((q?.options ?? []).map((opt) => opt.label))
                const customSelected = () => selected().filter((value) => !optionLabels().has(value))
                const customValue = () => customSelected()[0] ?? ""
                const customChecked = () => customValue().length > 0

                return (
                  <div class="border border-base bg-surface-secondary p-3 text-primary">
                    <div class="flex items-baseline justify-between gap-2">
                      <div class="text-sm text-primary">
                        {t("toolCall.question.number", { number: i() + 1 })} <span class="font-semibold">{q?.header}</span>
                      </div>
                      <Show when={multi()}>
                        <div class="text-xs text-muted">{t("toolCall.question.multiple")}</div>
                      </Show>
                    </div>

                    <div class="mt-1 text-sm font-medium text-primary">{q?.question}</div>

                    <div class="mt-3 flex flex-col gap-1">
                      <For each={q?.options ?? []}>
                        {(opt, optIndex) => {
                          const checked = () => selected().includes(opt.label)
                          return (
                            <label
                              class={`flex items-start gap-2 py-1 ${props.active() ? "cursor-pointer" : props.request() ? "opacity-80" : ""}`}
                              title={opt.description}
                            >
                              <input
                                ref={(el) => {
                                  if (i() === 0 && optIndex() === 0) firstInputRef = el
                                }}
                                type={inputType()}
                                name={groupName()}
                                class="mt-0.5 accent-[var(--accent-primary)]"
                                checked={checked()}
                                disabled={!props.active() || props.submitting()}
                                onChange={() => toggleOption(i(), opt.label)}
                              />
                              <div class="flex flex-col">
                                <div class="text-sm leading-tight text-primary">{opt.label}</div>
                                <div class="text-xs text-muted leading-tight">{opt.description}</div>
                              </div>
                            </label>
                          )
                        }}
                      </For>

                      <label
                        class={`mt-2 flex items-start gap-2 py-1 ${props.active() ? "cursor-pointer" : props.request() ? "opacity-80" : ""}`}
                        title={t("toolCall.question.custom.title")}
                      >
                        <input
                          ref={(el) => {
                            if (i() === 0 && (q?.options?.length ?? 0) === 0) firstInputRef = el
                          }}
                          type={inputType()}
                          name={groupName()}
                          class="mt-0.5 accent-[var(--accent-primary)]"
                          checked={customChecked()}
                          disabled={!props.active() || props.submitting()}
                          onChange={(e) => {
                            const container = e.currentTarget.closest("label")
                            const input = container?.querySelector("input[type='text']") as HTMLInputElement | null
                            if (!props.active()) return
                            if (customChecked()) {
                              clearCustomAnswer(i(), customSelected())
                              if (input) {
                                delete input.dataset.lastValue
                              }
                              return
                            }
                            toggleFromCustomInput(i(), input)
                          }}
                        />
                        <div class="flex flex-1 flex-col gap-2">
                          <div class="text-sm leading-tight text-primary">{t("toolCall.question.custom.label")}</div>
                          <input
                            class="w-full rounded-md border border-base bg-surface-base px-2 py-1 text-sm text-primary"
                            type="text"
                            placeholder={t("toolCall.question.custom.placeholder")}
                              disabled={!props.active() || props.submitting()}
                              value={customValue()}
                            onFocus={(e) => {
                              if (!props.active()) return
                              // Keep the radio/checkbox selected while editing.
                              toggleFromCustomInput(i(), e.currentTarget)
                            }}
                            onInput={(e) => handleCustomTyping(i(), e.currentTarget)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && !e.isComposing) {
                                if (!submitDisabled()) {
                                  props.onSubmit()
                                }
                              }
                            }}
                          />
                        </div>
                      </label>
                    </div>
                  </div>
                )
              }}
            </For>

            <Show when={props.active()}>
              <div class="tool-call-permission-actions px-3 pb-3">
                <div class="tool-call-permission-buttons">
                  <button
                    type="button"
                    class="tool-call-permission-button"
                    disabled={submitDisabled()}
                    onClick={() => props.onSubmit()}
                  >
                    {t("toolCall.question.actions.submit")}
                  </button>
                  <button
                    type="button"
                    class="tool-call-permission-button"
                    disabled={props.submitting()}
                    onClick={() => props.onDismiss()}
                  >
                    {t("toolCall.question.actions.dismiss")}
                  </button>
                </div>

                <div class="tool-call-permission-shortcuts">
                  <kbd class="kbd">Enter</kbd>
                  <span>{t("toolCall.question.shortcuts.submit")}</span>
                  <kbd class="kbd">Esc</kbd>
                  <span>{t("toolCall.question.shortcuts.dismiss")}</span>
                </div>

                <Show when={props.error()}>
                  <div class="tool-call-permission-error">{props.error()}</div>
                </Show>
              </div>
            </Show>

            <Show when={!props.active() && props.request()}>
              <p class="tool-call-permission-queued-text px-3 pb-3">{t("toolCall.question.queuedText")}</p>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  )
}
