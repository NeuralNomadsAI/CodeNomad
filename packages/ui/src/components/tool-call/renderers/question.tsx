import type { ToolRenderer } from "../types"

export const questionRenderer: ToolRenderer = {
  tools: ["question"],
  getAction: () => "Awaiting answers...",
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return "Questions"
    if (state.status === "completed") return "Questions"
    return "Asking questions"
  },
  renderBody() {
    // The question tool UI is rendered by ToolCall itself so
    // it can share the same layout for pending/completed.
    return null
  },
}
