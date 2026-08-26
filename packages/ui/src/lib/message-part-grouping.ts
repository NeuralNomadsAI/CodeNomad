import type { ClientPart } from "../types/message"

export type TechnicalPartGroup =
  | { kind: "part"; part: ClientPart }
  | { kind: "reasoning"; parts: ClientPart[] }
  | { kind: "exploration"; parts: ClientPart[] }

export type ExplorationSegment<T> =
  | { kind: "group"; items: T[] }
  | { kind: "pending"; item: T }

function groupKind(part: ClientPart) {
  if (part.type === "reasoning") return "reasoning" as const
  if (part.type === "tool" && ["read", "glob", "grep"].includes(part.tool.toLowerCase())) return "exploration" as const
}

export function groupTechnicalParts(parts: ClientPart[]): TechnicalPartGroup[] {
  return parts.reduce<TechnicalPartGroup[]>((groups, part) => {
    const kind = groupKind(part)
    const previous = groups.at(-1)
    if (!kind) {
      groups.push({ kind: "part", part })
    } else if (previous?.kind === kind) {
      previous.parts.push(part)
    } else {
      groups.push({ kind, parts: [part] })
    }
    return groups
  }, [])
}

export function segmentExplorationItems<T>(items: T[], isPending: (item: T) => boolean): ExplorationSegment<T>[] {
  return items.reduce<ExplorationSegment<T>[]>((segments, item) => {
    const previous = segments.at(-1)
    if (isPending(item)) {
      segments.push({ kind: "pending", item })
    } else if (previous?.kind === "group") {
      previous.items.push(item)
    } else {
      segments.push({ kind: "group", items: [item] })
    }
    return segments
  }, [])
}
