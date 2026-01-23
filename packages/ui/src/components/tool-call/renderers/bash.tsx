import type { ToolRenderer } from "../types"
import { ensureMarkdownContent, formatUnknown, getToolName, isToolStateCompleted, isToolStateError, isToolStateRunning, readToolStatePayload } from "../utils"

export const bashRenderer: ToolRenderer = {
  tools: ["bash"],
  getAction: () => "Writing command...",
  getTitle({ toolState }) {
    const state = toolState()
    if (!state) return undefined
    const { input } = readToolStatePayload(state)
    const name = getToolName("bash")
    const description = typeof input.description === "string" && input.description.length > 0 ? input.description : ""
    const timeout = typeof input.timeout === "number" && input.timeout > 0 ? input.timeout : undefined

    const baseTitle = description ? `${name} ${description}` : name
    if (!timeout) {
      return baseTitle
    }

    const timeoutLabel = `${timeout}ms`
    return `${baseTitle} · Timeout: ${timeoutLabel}`
  },
  renderBody({ toolState, renderMarkdown, renderAnsi }) {
    const state = toolState()
    if (!state || state.status === "pending") return null

    const { input, metadata } = readToolStatePayload(state)
    const command = typeof input.command === "string" && input.command.length > 0 ? `$ ${input.command}` : ""
    const outputResult = formatUnknown(
      isToolStateCompleted(state)
        ? state.output
        : (isToolStateRunning(state) || isToolStateError(state)) && metadata.output
          ? metadata.output
          : undefined,
    )
    const parts = [command, outputResult?.text].filter(Boolean)
    if (parts.length === 0) return null

    const joined = parts.join("\n")
    if (state.status === "running") {
      return renderAnsi({ content: joined, variant: "running" })
    }

    const ansiBody = renderAnsi({ content: joined, requireAnsi: true, variant: "final" })
    if (ansiBody) {
      return ansiBody
    }

    const content = ensureMarkdownContent(joined, "bash", true)
    if (!content) return null

    return renderMarkdown({ content })
  },
}
