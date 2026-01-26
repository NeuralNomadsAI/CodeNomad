import type { ToolRenderer } from "../types"

export const questionRenderer: ToolRenderer = {
  tools: ["question"],
  getAction: ({ t }) => t("toolCall.question.action.awaitingAnswers"),
  getTitle({ toolState, t }) {
    const state = toolState()
    if (!state) return t("toolCall.question.title.questions")
    if (state.status === "completed") return t("toolCall.question.title.questions")
    return t("toolCall.question.title.askingQuestions")
  },
  renderBody() {
    // The question tool UI is rendered by ToolCall itself so
    // it can share the same layout for pending/completed.
    return null
  },
}
