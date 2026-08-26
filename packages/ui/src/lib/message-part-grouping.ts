import type { ClientPart } from "../types/message"

export type TechnicalPartGroup =
  | { kind: "part"; part: ClientPart }
  | { kind: "reasoning"; parts: ClientPart[] }
  | { kind: "exploration"; parts: ClientPart[] }

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
