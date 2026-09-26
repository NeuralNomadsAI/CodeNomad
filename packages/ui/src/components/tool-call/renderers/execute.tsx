import { For, Show, createMemo } from "solid-js"
import type { ToolRenderer } from "../types"
import { defaultRenderer } from "./default"
import { executeData, executeSummary } from "./execute-data"
import { ensureMarkdownContent, formatUnknownForCopy, formatUnknownForRender, limitToolOutputForRender, limitToolTitleForRender } from "../utils"
import { getDefaultToolSearchText } from "../search-text"

export const executeRenderer: ToolRenderer = {
  tools: ["execute"],
  getTitle({ toolState, t }) {
    const data = executeData(toolState())
    const summary = executeSummary(data.calls)
    return limitToolTitleForRender(`${t("toolCall.execute.script")}${summary ? ` · ${summary}` : ""}`)
  },
  getSearchText(context) {
    const data = executeData(context.toolState)
    return [...getDefaultToolSearchText(context), data.code,
      ...data.calls.flatMap(call => [call.tool, formatUnknownForCopy(call.input)?.text ?? ""])]
  },
  getOutputChrome: defaultRenderer.getOutputChrome,
  renderBody(context) {
    const data = createMemo(() => executeData(context.toolState()))
    const markdown = (text: string, language: string, key: string) => context.renderMarkdown({
      content: ensureMarkdownContent(limitToolOutputForRender(text), language, true) ?? "",
      cacheKey: `execute-${key}`, disableHighlight: context.toolState()?.status === "running",
      wrap: context.outputWrapEnabled?.() ?? true,
    })
    return <div class="tool-call-execute">
      <Show when={data().code}>{code => <section aria-label={context.t("toolCall.execute.script")}>
        {markdown(code(), "javascript", "script")}
      </section>}</Show>
      <Show when={data().calls.length}>
        <section aria-label={context.t("toolCall.execute.calls")}>
          <ol class="execute-calls"><For each={data().calls.slice(0, 200)}>{(call, index) =>
            <li><details><summary>
              <span class="execute-call-name">{call.tool}</span>
              <span class="execute-call-status" data-status={call.status}>{context.t(`toolCall.status.${call.status}`)}</span>
            </summary><Show when={call.input}>{input => markdown(formatUnknownForRender(input())?.text ?? "", "json", `call-${index()}`)}</Show>
            </details></li>
          }</For></ol>
          <Show when={data().calls.length > 200}><p>{context.t("toolCall.execute.more", { count: data().calls.length - 200 })}</p></Show>
        </section>
      </Show>
      <Show when={data().failed}><p class="execute-call-status" data-status="error">{context.t("toolCall.status.error")}</p></Show>
      {defaultRenderer.renderBody(context)}
      <Show when={data().truncated}><p>{context.t("toolCall.execute.truncated")} <span>{data().outputPath}</span></p></Show>
    </div>
  },
}
