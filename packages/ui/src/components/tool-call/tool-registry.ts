import type { ToolRenderer } from "./types"
import { getToolRegistryEntry } from "./tool-presentation"
import { applyPatchRenderer } from "./renderers/apply-patch"
import { bashRenderer } from "./renderers/bash"
import { defaultRenderer } from "./renderers/default"
import { editRenderer } from "./renderers/edit"
import { invalidRenderer } from "./renderers/invalid"
import { patchRenderer } from "./renderers/patch"
import { questionRenderer } from "./renderers/question"
import { readRenderer } from "./renderers/read"
import { searchRenderer } from "./renderers/search"
import { skillRenderer } from "./renderers/skill"
import { taskRenderer } from "./renderers/task"
import { todoRenderer } from "./renderers/todo"
import { webfetchRenderer } from "./renderers/webfetch"
import { writeRenderer } from "./renderers/write"

export * from "./tool-presentation"

const renderers: Record<string, ToolRenderer> = {
  bash: bashRenderer, read: readRenderer, write: writeRenderer, edit: editRenderer,
  patch: patchRenderer, apply_patch: applyPatchRenderer, webfetch: webfetchRenderer,
  glob: searchRenderer, grep: searchRenderer, todowrite: todoRenderer, task: taskRenderer,
  skill: skillRenderer, question: questionRenderer, invalid: invalidRenderer,
}

export function resolveToolRenderer(toolName: string): ToolRenderer {
  return renderers[getToolRegistryEntry(toolName).tool] ?? defaultRenderer
}
