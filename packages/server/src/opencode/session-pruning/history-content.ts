import { storageDirectory } from "./storage-path"
import type { HistoryHit } from "./history-contract"
import type { HistoryScope } from "./history-store"

export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024
export const HISTORY_SLICE_MS = 40

export function historyScopeSQL(scope: HistoryScope) {
  const directory = storageDirectory(scope.directory)
  const prefix = directory.endsWith("/") ? directory : `${directory}/`
  return {
    where: (scope.sessionID ? "s.directory = ?" : "(s.directory = ? OR substr(s.directory,1,length(?)) = ?)") + " AND s.workspace_id IS ?"
      + (scope.sessionID ? " AND s.id = ? AND s.project_id = ?" : " AND s.project_id IN (?, 'global')"),
    params: [directory, ...(!scope.sessionID ? [prefix, prefix] : []), scope.workspaceID ?? null,
      ...(scope.sessionID ? [scope.sessionID, scope.projectID!] : [scope.projectID ?? "global"])],
  }
}

// Retain original part positions while materializing only readable fields.
export const textProjection = `CASE WHEN json_valid(m.data) THEN CASE WHEN json_type(m.data) = 'object' THEN
  CASE WHEN json_type(m.data, '$.content') = 'array' THEN json_object('content', (
    SELECT json_group_array(CASE WHEN p.type = 'object' THEN
      CASE WHEN json_extract(p.value, '$.type') = 'text' AND json_type(p.value, '$.text') = 'text'
        THEN json_object('type', 'text', 'text', json_extract(p.value, '$.text')) END END)
    FROM json_each(m.data, '$.content') p
  )) WHEN m.type != 'assistant' THEN json_object(
    'text', CASE WHEN json_type(m.data, '$.text') = 'text' THEN json_extract(m.data, '$.text') END,
    'summary', CASE WHEN json_type(m.data, '$.summary') = 'text' THEN json_extract(m.data, '$.summary') END,
    'command', CASE WHEN json_type(m.data, '$.command') = 'text' THEN json_extract(m.data, '$.command') END,
    'output', json_object('output', CASE WHEN json_type(m.data, '$.output.output') = 'text' THEN json_extract(m.data, '$.output.output') END)
  ) END END END`

export function historyContent(data: any, role: unknown): any[] {
  if (!data || typeof data !== "object") throw new Error("Unsupported history content")
  if (role === "assistant" && !Array.isArray(data.content)) throw new Error("Unsupported assistant content")
  return Array.isArray(data.content) ? data.content : [data.text, data.summary, data.command, data.output?.output]
    .filter((text): text is string => typeof text === "string").map(text => ({ type: "text", text }))
}

function diffTexts(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object") return []
  const { diff, files } = metadata as { diff?: unknown; files?: unknown }
  return [diff, ...(Array.isArray(files) ? files.map((file: { patch?: unknown } | null) => file?.patch) : [])]
    .filter((text): text is string => typeof text === "string")
}

export function* historyTexts(content: any[], includeTechnical: boolean): Generator<Pick<HistoryHit, "partIndex" | "kind"> & { text: string }> {
  for (let partIndex = 0; partIndex < content.length; partIndex++) {
    const part = content[partIndex]
    if (!part || typeof part !== "object") continue
    const kind = part.type
    if (kind !== "text" && (!includeTechnical || (kind !== "tool" && kind !== "reasoning"))) continue
    const texts = kind === "tool"
      ? [part.tool, part.name, JSON.stringify(part.input ?? part.state?.input), part.state?.error, ...(Array.isArray(part.state?.content)
        ? part.state.content.filter((p: any) => p?.type === "text").map((p: any) => p.text) : []), ...diffTexts(part.state?.metadata)]
      : [part.text]
    for (const text of texts) if (typeof text === "string") yield { partIndex, kind, text }
  }
}
