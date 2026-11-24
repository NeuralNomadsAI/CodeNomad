import type { SemanticNode } from "./protocol"
import type { AxNode } from "./snapshot"

/** CDP fields end here; stable numeric node identities remain shared with RefTable. */
export function semanticTree(nodes: readonly AxNode[]): SemanticNode[] {
  return nodes.map(node => ({ id: node.nodeId, parent: node.parentId, children: node.childIds, ignored: node.ignored,
    node: node.backendDOMNodeId, role: node.role?.value, name: node.name?.value, description: node.description?.value,
    value: node.value?.value, properties: node.properties?.map(property => ({ name: property.name, value: property.value?.value })) }))
}
/** Keep the established snapshot renderer and its budgets unchanged. */
export function snapshotTree(nodes: readonly SemanticNode[]): AxNode[] {
  return nodes.map(node => ({ nodeId: node.id, parentId: node.parent, childIds: node.children, ignored: node.ignored,
    backendDOMNodeId: node.node, role: { value: node.role }, name: { value: node.name }, description: { value: node.description },
    value: { value: node.value }, properties: node.properties?.map(property => ({ name: property.name, value: { value: property.value } })) }))
}
