import { parsePageOperation } from "./operations"
import { PAGE_DRIVER_VERSION, PageDriverUnsupportedError, type PageDriver, type DriverKind, type PageOperation, type SemanticNode } from "./protocol"

/** Shared typed surface for direct CDP and the fenced native operation transport. */
export function operationDriver(kind: DriverKind, send: (operation: PageOperation) => Promise<Record<string, unknown>>, checkpoint: () => Promise<void>, application = false): PageDriver {
  const run = async (operation: PageOperation) => {
    const result = await send(parsePageOperation(operation, application))
    const error = result?.error as { code?: unknown; operation?: unknown } | undefined
    if (error?.code === "unsupported") throw new PageDriverUnsupportedError(kind, String(error.operation ?? operation.op))
    return result
  }
  return {
    kind, version: PAGE_DRIVER_VERSION,
    tree: async () => { const { nodes } = await run({ op: "tree" }); return Array.isArray(nodes) ? nodes as SemanticNode[] : [] },
    resolve: async node => (await run({ op: "resolve", node })).handle as string | undefined,
    call: async (functionId, handle, args) => run({ op: "call", function: functionId, ...(handle === undefined ? {} : { handle }), args }),
    scrollIntoView: async node => { await run({ op: "scroll-into-view", node }) },
    geometry: async node => { const { quads } = await run({ op: "geometry", node }); return Array.isArray(quads) ? quads as number[][] : [] },
    viewport: async () => { const result = await run({ op: "viewport" }); return { width: typeof result.width === "number" ? result.width : Infinity, height: typeof result.height === "number" ? result.height : Infinity } },
    hitTest: async (x, y) => (await run({ op: "hit-test", x, y })).node as number | undefined,
    pointer: async event => { await run({ op: "pointer", event }) },
    wheel: async event => { await run({ op: "wheel", event }) },
    keyboard: async event => { await run({ op: "keyboard", event }) },
    insertText: async text => { await run({ op: "insert-text", text }) },
    releaseHandles: async () => { await run({ op: "release-handles" }) }, checkpoint,
  }
}
