import type { ToolRenderer } from "../types"
import { getQuestionToolSearchText } from "../search-text"
import { For, Show, createMemo } from "solid-js"
import { readToolStatePayload } from "../utils"

export const questionRenderer: ToolRenderer = {
  tools: ["question"],
  getSearchText: getQuestionToolSearchText,
  getAction: ({ t, toolState }) => toolState()?.status === "completed" ? t("interruption.answered") : t("toolCall.question.action.awaitingAnswers"),
  getTitle({ toolState, t }) {
    const state = toolState()
    if (!state) return t("toolCall.question.title.questions")
    if (state.status === "completed") return t("toolCall.question.title.questions")
    return t("toolCall.question.title.askingQuestions")
  },
  renderBody({ toolState, t }) {
    const payload = createMemo(() => readToolStatePayload(toolState()))
    const questions = () => Array.isArray(payload().input.questions) ? payload().input.questions : []
    const answers = () => {
      const { metadata, output } = payload()
      const value = metadata.answers ?? (output && typeof output === "object" ? (output as Record<string, unknown>).answers : undefined)
      return Array.isArray(value) ? value : undefined
    }
    return <dl class="interruption-receipt">
      <For each={questions()}>{(question, index) => <>
        <dt>{typeof question?.question === "string" ? question.question : ""}</dt>
        <Show when={toolState()?.status === "completed"}>
          <dd>{Array.isArray(answers()?.[index()])
            ? answers()![index()].filter((value: unknown) => typeof value === "string").join(", ") || t("interruption.noAnswer")
            : t("interruption.noAnswer")}</dd>
        </Show>
      </>}</For>
    </dl>
  },
}
