import { createHash } from "node:crypto"
import { z } from "zod"

const AUTHORITY_MAX_BYTES = 128 * 1024
const id = z.string().min(1).max(240)

// Physical identities are supplied by the ownership adapter, never inferred from
// a path prefix or projectID. executionHost includes the selected WSL distro.
export const authorityRootSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("git"), directory: z.string().min(1).max(4096), family: id, checkout: id }).strict(),
  z.object({ mode: z.literal("directory-only"), directory: z.string().min(1).max(4096) }).strict(),
])

export class MissionAuthorityError extends Error {
  constructor(readonly code: "invalid-intent" | "untrusted-signer" | "binding-mismatch" | "policy-unqualified"
    | "storage-unavailable" | "storage-invalid" | "namespace-mismatch" | "capacity" | "request-conflict"
    | "revision-conflict" | "epoch-conflict" | "authorization-blocked" | "unsigned-privileged-method"
    | "trust-unavailable" | "observation-unavailable" | "effect-unavailable") {
    super(`Mission authority rejected: ${code}`)
  }
}
export function rejectAuthority(code: MissionAuthorityError["code"]): never { throw new MissionAuthorityError(code) }

/** Bounded portable JSON: reject getters, exotic objects, sparse arrays and cycles. */
export function canonicalAuthority(value: unknown, maxBytes = AUTHORITY_MAX_BYTES): string {
  let nodes = 0
  let bytes = 0
  const emit = (text: string) => {
    bytes += Buffer.byteLength(text)
    if (bytes > maxBytes) rejectAuthority("capacity")
    return text
  }
  const visit = (input: unknown, depth: number): string => {
    if (++nodes > 200_000 || depth > 20) rejectAuthority("invalid-intent")
    if (input === null || typeof input === "boolean") return emit(JSON.stringify(input))
    if (typeof input === "string") {
      if (input.length > maxBytes) rejectAuthority("capacity")
      return emit(JSON.stringify(input))
    }
    if (typeof input === "number" && Number.isFinite(input)) return emit(JSON.stringify(input))
    if (Array.isArray(input)) {
      if (input.length > 20_000 || Object.keys(input).length !== input.length) rejectAuthority("invalid-intent")
      const values: string[] = []
      for (let index = 0; index < input.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
        if (!descriptor || !("value" in descriptor)) rejectAuthority("invalid-intent")
        values.push(visit(descriptor.value, depth + 1))
      }
      if (values.length > 1) emit(",".repeat(values.length - 1))
      return `${emit("[")}${values.join(",")}${emit("]")}`
    }
    if (typeof input !== "object" || !input || Object.getPrototypeOf(input) !== Object.prototype) rejectAuthority("invalid-intent")
    const keys = Reflect.ownKeys(input)
    if (keys.some(key => typeof key !== "string")) rejectAuthority("invalid-intent")
    const pairs = (keys as string[]).sort().map(key => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key)!
      if (!descriptor.enumerable || !("value" in descriptor)) rejectAuthority("invalid-intent")
      return `${emit(JSON.stringify(key))}${emit(":")}${visit(descriptor.value, depth + 1)}`
    })
    // Count each separator, not just one separator used by join().
    if (pairs.length > 1) emit(",".repeat(pairs.length - 1))
    return `${emit("{")}${pairs.join(",")}${emit("}")}`
  }
  return visit(value, 0)
}

export function authorityDigest(value: unknown): string {
  return createHash("sha256").update(canonicalAuthority(value)).digest("hex")
}
