import { For, Show, createMemo } from "solid-js"
import type { ToolRenderer } from "../types"
import { defaultRenderer } from "./default"
import { parseWebSearchResults } from "./websearch-data"
import { getDefaultToolSearchText } from "../search-text"
import { limitToolTitleForRender, readToolStatePayload } from "../utils"
import { openExternalUrl } from "../../../lib/external-url"

export const websearchRenderer: ToolRenderer = {
  tools: ["websearch"],
  getTitle({ toolState }) {
    const { input, metadata } = readToolStatePayload(toolState())
    return limitToolTitleForRender(["websearch", input.query, metadata.provider].filter(value => typeof value === "string").join(" · "))
  },
  getSearchText: getDefaultToolSearchText,
  getOutputChrome: defaultRenderer.getOutputChrome,
  renderBody(context) {
    const results = createMemo(() => {
      const state = context.toolState()
      return state?.status === "completed" && typeof state.output === "string"
        ? parseWebSearchResults(state.output) : undefined
    })
    return <Show when={results()} fallback={defaultRenderer.renderBody(context)}>{items =>
      <Show when={items().length} fallback={<p>{context.t("toolCall.websearch.empty")}</p>}>
        <ol class="websearch-results"><For each={items()}>{result => <li>
          <a href={result.url} target="_blank" rel="noopener noreferrer" onClick={event => {
            event.preventDefault()
            void openExternalUrl(result.url, "websearch-result")
          }}>{result.title}</a>
          <div class="websearch-result-source">{result.host}<Show when={result.published}>{date => <> · <time>{date()}</time></>}</Show></div>
          <Show when={result.snippet}><p>{result.snippet}</p></Show>
        </li>}</For></ol>
      </Show>
    }</Show>
  },
}
