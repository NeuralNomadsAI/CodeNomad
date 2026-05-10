import { tool } from "@opencode-ai/plugin/tool"
import { createCodeNomadRequester, type CodeNomadConfig } from "./request"

type ContextPruneRouteRequest = {
  sessionID: string
  indices: number[]
}

const MAX_SELECTABLE_INDICES = 1000

export function createContextPruneTools(config: CodeNomadConfig) {
  const requester = createCodeNomadRequester(config)

  return {
    select_context_range: tool({
      description: "Stage context-prune badge selections in the UI using 1-based positions in the current visible pruneable conversation order. The model usually sees conversation entries as message ids like m0001, m0002, m0003; treat those as the visible chronological sequence and convert them into 1-based positions for this tool. Example: if the pruneable visible sequence is m0007, m0008, m0009, m0010, then their positions for this tool are 1, 2, 3, 4. A single call can include multiple individual positions and multiple ranges, such as 1,3-5,8,10-12. Call this tool once with the full final selection because later calls replace the staged selection.",
      args: {
        range: tool.schema.string().describe("Full final selection to stage in one call, using 1-based positions in the current pruneable visible conversation order. Example: if the pruneable visible sequence is m0007, m0008, m0009, m0010, use 1,2,3,4 respectively, so selecting m0008 through m0010 would be 2-4. Supports multiple single positions and inclusive ranges combined with commas, for example: 1,3-5,8,10-12. Repeated tool calls replace the previous staged selection instead of merging with it."),
      },
      async execute(args, context) {
        const indices = parseRange(args.range)
        await requester.requestVoid("/context-prune/select", {
          method: "POST",
          body: JSON.stringify({
            sessionID: context.sessionID,
            indices,
          } satisfies ContextPruneRouteRequest),
        })

        return ""
      },
    }),
  }
}

function parseRange(input: string): number[] {
  const raw = (input ?? "").trim()
  if (!raw) {
    throw new Error("Range is required")
  }

  const values = new Set<number>()
  const tokens = raw.split(",")

  for (const token of tokens) {
    const part = token.trim()
    if (!part) {
      throw new Error("Range contains an empty entry")
    }

    const rangeMatch = part.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const start = Number(rangeMatch[1])
      const end = Number(rangeMatch[2])
      if (start < 1 || end < 1) {
        throw new Error(`Invalid range: ${part}`)
      }
      if (start > end) {
        throw new Error(`Invalid range: ${part} (start must be less than or equal to end)`)
      }
      for (let index = start; index <= end; index += 1) {
        values.add(index)
      }
      continue
    }

    if (!/^\d+$/.test(part)) {
      throw new Error(`Invalid range token: ${part}`)
    }

    const value = Number(part)
    if (value < 1) {
      throw new Error(`Invalid index: ${part}`)
    }
    values.add(value)
  }

  const indices = Array.from(values).sort((left, right) => left - right)
  if (indices.length === 0) {
    throw new Error("Range did not resolve to any indices")
  }
  if (indices.length > MAX_SELECTABLE_INDICES) {
    throw new Error(`Range selects too many indices (${indices.length}). Maximum allowed is ${MAX_SELECTABLE_INDICES}.`)
  }

  return indices
}
