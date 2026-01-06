import type { ToolState } from "@opencode-ai/sdk"
import type { ToolRendererContext, ToolRenderer, ToolCallPart } from "./types"
import { getDefaultToolAction, getToolName, isToolStateCompleted, isToolStateRunning } from "./utils"
import { defaultRenderer } from "./renderers/default"
import { bashRenderer } from "./renderers/bash"
import { readRenderer } from "./renderers/read"
import { writeRenderer } from "./renderers/write"
import { editRenderer } from "./renderers/edit"
import { patchRenderer } from "./renderers/patch"
import { webfetchRenderer } from "./renderers/webfetch"
import { todoRenderer } from "./renderers/todo"
import { invalidRenderer } from "./renderers/invalid"

const TITLE_RENDERERS: Record<string, ToolRenderer> = {
  bash: bashRenderer,
  read: readRenderer,
  write: writeRenderer,
  edit: editRenderer,
  patch: patchRenderer,
  webfetch: webfetchRenderer,
  todowrite: todoRenderer,
  todoread: todoRenderer,
  invalid: invalidRenderer,
}

interface TitleSnapshot {
  toolName: string
  state?: ToolState
}

function lookupRenderer(toolName: string): ToolRenderer {
  return TITLE_RENDERERS[toolName] ?? defaultRenderer
}

function createStaticToolPart(snapshot: TitleSnapshot): ToolCallPart {
  return {
    id: "",
    type: "tool",
    tool: snapshot.toolName,
    state: snapshot.state,
  } as ToolCallPart
}

function createStaticContext(snapshot: TitleSnapshot): ToolRendererContext {
  const toolStateAccessor = () => snapshot.state
  const toolNameAccessor = () => snapshot.toolName
  const toolCallAccessor = () => createStaticToolPart(snapshot)
  const messageVersionAccessor = () => undefined
  const partVersionAccessor = () => undefined
  const renderMarkdown: ToolRendererContext["renderMarkdown"] = () => null
  const renderAnsi: ToolRendererContext["renderAnsi"] = () => null
  const renderDiff: ToolRendererContext["renderDiff"] = () => null

  return {
    toolCall: toolCallAccessor,
    toolState: toolStateAccessor,
    toolName: toolNameAccessor,
    messageVersion: messageVersionAccessor,
    partVersion: partVersionAccessor,
    renderMarkdown,
    renderAnsi,
    renderDiff,
    scrollHelpers: undefined,
  }
}

export function resolveTitleForTool(snapshot: TitleSnapshot): string {
  const renderer = lookupRenderer(snapshot.toolName)
  const context = createStaticContext(snapshot)
  const state = snapshot.state
  const defaultAction = renderer.getAction?.(context) ?? getDefaultToolAction(snapshot.toolName)

  if (!state || state.status === "pending") {
    return defaultAction
  }

  const stateTitle = typeof (state as { title?: string }).title === "string" ? (state as { title?: string }).title : undefined
  if (stateTitle && stateTitle.length > 0) {
    return stateTitle
  }

  const customTitle = renderer.getTitle?.(context)
  if (customTitle) {
    return customTitle
  }

  return getToolName(snapshot.toolName)
}
