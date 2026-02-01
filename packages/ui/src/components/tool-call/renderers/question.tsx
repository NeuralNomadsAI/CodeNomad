import { For, Show } from "solid-js"
import type { ToolRenderer } from "../types"
import { readToolStatePayload } from "../utils"

interface QuestionInfoView {
  question: string
  header: string
  options: Array<{ label: string; description: string }>
  multiple?: boolean
}

interface QuestionAnswerView {
  question: string
  answers: string[]
}

function extractQuestionsFromState(state: import("@opencode-ai/sdk").ToolState | undefined) {
  if (!state) return { questions: [] as QuestionInfoView[], answers: [] as QuestionAnswerView[] }

  const { input, metadata } = readToolStatePayload(state)
  const questions: QuestionInfoView[] = Array.isArray(input.questions) ? input.questions : []
  const rawAnswers: string[][] = Array.isArray((metadata as any).answers) ? (metadata as any).answers : []

  const answers: QuestionAnswerView[] = questions.map((q, i) => ({
    question: q.question,
    answers: rawAnswers[i] ?? [],
  }))

  return { questions, answers }
}

export const questionRenderer: ToolRenderer = {
  tools: ["question"],
  getAction() {
    return "Asking..."
  },
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return "Questions"
    const { questions } = extractQuestionsFromState(state)
    const count = questions.length
    if (count === 0) return "Questions"
    if (state.status === "completed") return `${count} question${count > 1 ? "s" : ""} answered`
    return `${count} question${count > 1 ? "s" : ""}`
  },
  renderBody({ toolState }) {
    const state = toolState()
    if (!state) return null

    const { questions, answers } = extractQuestionsFromState(state)

    if (state.status === "completed" && answers.length > 0) {
      return (
        <div class="flex flex-col gap-2 px-3 py-2">
          <For each={answers}>
            {(qa) => (
              <div class="flex flex-col gap-1">
                <div class="text-sm text-foreground font-medium">{qa.question}</div>
                <div class="text-xs text-muted-foreground pl-2 border-l-2 border-info">
                  {qa.answers.length > 0 ? qa.answers.join(", ") : "(no answer)"}
                </div>
              </div>
            )}
          </For>
        </div>
      )
    }

    // Running state: show the questions being asked
    return (
      <div class="flex flex-col gap-2 px-3 py-2">
        <For each={questions}>
          {(q) => (
            <div class="flex flex-col gap-1.5">
              <div class="text-sm text-foreground font-medium">{q.question}</div>
              <Show when={q.options?.length > 0}>
                <div class="flex flex-wrap gap-1.5">
                  <For each={q.options}>
                    {(opt) => (
                      <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-secondary border border-border text-muted-foreground">{opt.label}</span>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </For>
      </div>
    )
  },
}
