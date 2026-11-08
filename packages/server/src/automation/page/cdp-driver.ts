import { declaration, ELEMENT_FUNCTIONS, GLOBAL_FUNCTIONS, handleResult } from "./functions"
import { OBJECT_GROUP, type PageChannel, type PageOperation } from "./protocol"
import { semanticTree } from "./semantic-tree"
import type { AxNode } from "./snapshot"
import { operationDriver } from "./driver"
import { parsePageOperation } from "./operations"
const optional = (key: string, value: unknown): Record<string, unknown> => value === undefined ? {} : { [key]: value }

/** Used in the app's CDP connection and Electron's native guest dispatcher. */
export async function executeCdpOperation(channel: PageChannel, raw: PageOperation, mark = false): Promise<Record<string, unknown>> {
  const operation = parsePageOperation(raw, mark)
  switch (operation.op) {
    case "tree": { const result = await channel.send("Accessibility.getFullAXTree"); return { nodes: semanticTree(Array.isArray(result.nodes) ? result.nodes as AxNode[] : []) } }
    case "resolve": { const result = await channel.send("DOM.resolveNode", { backendNodeId: operation.node, objectGroup: OBJECT_GROUP }); return optional("handle",(result.object as {objectId?: string})?.objectId) }
    case "call": {
      const id = operation.function
      const result = Object.hasOwn(ELEMENT_FUNCTIONS, id)
        ? await channel.send("Runtime.callFunctionOn", { objectId: operation.handle,
            functionDeclaration: declaration(id as keyof typeof ELEMENT_FUNCTIONS, mark),
            arguments: operation.args.map(value => value && typeof value === "object" && Object.hasOwn(value, "handle") ? { objectId: (value as {handle: string}).handle } : { value }),
            returnByValue: !handleResult(id), objectGroup: OBJECT_GROUP })
        : await channel.send("Runtime.evaluate", { expression: GLOBAL_FUNCTIONS[id as keyof typeof GLOBAL_FUNCTIONS],
            ...(handleResult(id) ? { objectGroup: OBJECT_GROUP } : { returnByValue: true }) })
      const failure = result.exceptionDetails as {exception?: {description?: unknown}; text?: unknown} | undefined
      if (failure) return { exception: String(failure.exception?.description ?? failure.text ?? "") }
      const value = result.result as {value?: unknown; objectId?: string} | undefined
      return handleResult(id) ? optional("handle",value?.objectId) : optional("value",value?.value)
    }
    case "scroll-into-view": return channel.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: operation.node })
    case "geometry": return channel.send("DOM.getContentQuads", { backendNodeId: operation.node })
    case "viewport": {
      const metrics = await channel.send("Page.getLayoutMetrics")
      const viewport = (metrics.cssLayoutViewport ?? metrics.layoutViewport) as {clientWidth?: number; clientHeight?: number} | undefined
      return { ...optional("width",viewport?.clientWidth), ...optional("height",viewport?.clientHeight) }
    }
    case "hit-test": { const result = await channel.send("DOM.getNodeForLocation", { x: operation.x, y: operation.y, includeUserAgentShadowDOM: false, ignorePointerEventsNone: false }); return optional("node",result.backendNodeId) }
    case "pointer": case "wheel": return channel.send("Input.dispatchMouseEvent", operation.event as unknown as Record<string, unknown>)
    case "keyboard": return channel.send("Input.dispatchKeyEvent", operation.event as unknown as Record<string, unknown>)
    case "insert-text": return channel.send("Input.insertText", { text: operation.text })
    case "release-handles": return channel.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP })
    case "checkpoint": return {}
  }
}
export function cdpDriver(channel: PageChannel, checkpoint: () => Promise<void>, mark = false) {
  return operationDriver("cdp", operation => executeCdpOperation(channel, operation, mark), checkpoint, mark)
}
export function cdpSession(channel: PageChannel, checkpoint: () => Promise<void>, markAutomation: boolean) {
  return { driver: cdpDriver(channel, checkpoint, markAutomation), checkpoint, markAutomation }
}
