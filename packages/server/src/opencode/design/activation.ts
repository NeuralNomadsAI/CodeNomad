// The Design request a backend carries in each of its session-pruning leases.
import { LEASE_REQUEST_MAX_BYTES, leaseRequestContent, leaseRequests } from "../lease-request"

/** Leases larger than this request nothing and are never read further. */
export const DESIGN_LEASE_MAX_BYTES = LEASE_REQUEST_MAX_BYTES

/** The lease content of a backend: empty when it requests nothing. */
export const designLeaseContent = (requested: boolean): string => leaseRequestContent("design", requested)

/** Only an exact version 1 request counts; empty, malformed or unknown versions request nothing. */
export const leaseRequestsDesign = (content: string): boolean => leaseRequests(content, "design")
