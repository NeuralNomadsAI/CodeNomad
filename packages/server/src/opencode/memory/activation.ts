// The agent-memory request a backend carries in each of its memory leases: the
// `server.memoryEnabled` preference. The native tool is registered only while a
// live lease requests it.
import { leaseRequestContent, leaseRequests } from "../lease-request"

export const memoryLeaseContent = (enabled: boolean): string => leaseRequestContent("memory", enabled)
export const leaseRequestsMemory = (content: string): boolean => leaseRequests(content, "memory")
