import type { ToolRenderer } from "../types"
import { getQuestionToolSearchText } from "../search-text"
import { For, Show, createMemo } from "solid-js"
import { readToolStatePayload } from "../utils"
import { getQuestionReceipts } from "./question-data"

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
    const questions = createMemo(() => getQuestionReceipts(readToolStatePayload(toolState())))
    return <Show when={toolState()?.status === "completed" && questions().length > 0}>
      <dl class="interruption-receipt question-receipt">
        <For each={questions()}>{question => <div class="question-receipt-item">
          <dt>
            <Show when={question.header}><span class="question-receipt-caption">{question.header}</span></Show>
            <span class="question-receipt-prompt">{question.prompt}</span>
          </dt>
          <dd>
            <span class="question-receipt-caption">{t("question-receipt.answer")}</span>
            <Show when={question.selected?.length} fallback={
              <p class="question-receipt-empty">{t(question.selected ? "interruption.noAnswer" : "question-receipt.unavailable")}</p>
            }>
              <ul class="question-receipt-answers">
                <For each={question.selected}>{answer => <li>
                  <span class="question-receipt-label">{answer.label}</span>
                  <Show when={answer.description}><p class="question-receipt-description">{answer.description}</p></Show>
                </li>}</For>
              </ul>
            </Show>
            <Show when={question.remaining.length > 0}>
              <details class="question-receipt-choices">
                <summary>{t(question.selected ? "question-receipt.otherChoices" : "question-receipt.offeredChoices", { count: question.remaining.length })}</summary>
                <ul>
                  <For each={question.remaining}>{option => <li>
                    <span class="question-receipt-label">{option.label}</span>
                    <Show when={option.description}><p class="question-receipt-description">{option.description}</p></Show>
                  </li>}</For>
                </ul>
              </details>
            </Show>
          </dd>
        </div>}</For>
      </dl>
    </Show>
  },
}
