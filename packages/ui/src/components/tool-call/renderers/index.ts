import type { ToolRenderer } from "../types"
import { bashRenderer } from "./bash"
import { defaultRenderer } from "./default"
import { editRenderer } from "./edit"
import { patchRenderer } from "./patch"
import { readRenderer } from "./read"
import { taskRenderer } from "./task"
import { todoRenderer } from "./todo"
import { webfetchRenderer } from "./webfetch"
import { writeRenderer } from "./write"
import { invalidRenderer } from "./invalid"
import { questionRenderer } from "./question"

const TOOL_RENDERERS: ToolRenderer[] = [
  bashRenderer,
  readRenderer,
  writeRenderer,
  editRenderer,
  patchRenderer,
  webfetchRenderer,
  todoRenderer,
  taskRenderer,
  questionRenderer,
  invalidRenderer,
]

const rendererMap = TOOL_RENDERERS.reduce<Record<string, ToolRenderer>>((acc, renderer) => {
  renderer.tools.forEach((tool) => {
    acc[tool] = renderer
  })
  return acc
}, {})

export function resolveToolRenderer(toolName: string): ToolRenderer {
  return rendererMap[toolName] ?? defaultRenderer
}

export { defaultRenderer }
