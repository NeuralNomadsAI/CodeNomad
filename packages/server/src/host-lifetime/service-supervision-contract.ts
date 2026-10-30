import { createHash } from "node:crypto"
import path from "node:path"
import { z } from "zod"

export const SUPERVISION_MANIFEST_BYTES = 64 * 1024
const text = z.string().min(1).max(4096).regex(/^[^\x00-\x1f\x7f]+$/)
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1)
const requestID = z.string().uuid()
const platform = z.enum(["win32", "darwin", "linux", "wsl"])
const nativePath = (value: string, windows: boolean) => {
  const api = windows ? path.win32 : path.posix
  return api.isAbsolute(value) && api.normalize(value) === value
    && !value.split(/[\\/]/).some(part => part === "." || part === "..")
    && (windows ? /^[A-Za-z]:\\/.test(value) && !value.slice(2).includes(":") : !value.includes("\\"))
}

/** Values come from the acquired Settings execution host, after native realpath
 * and UID/SID verification. Profiles, binaries, URLs and PIDs never enter the key. */
export const supervisionNamespaceSchema = z.object({
  platform, host: text, user: text,
  distro: text.optional(),
  configDirectory: text, stateDirectory: text,
  registrationName: z.string().max(240).regex(/^service(?:-[a-zA-Z0-9._-]+)?\.json$/),
}).strict().superRefine((value, ctx) => {
  const windows = value.platform === "win32"
  if (!nativePath(value.configDirectory, windows) || !nativePath(value.stateDirectory, windows)
    || (value.platform === "wsl") !== Boolean(value.distro)
    || (windows ? !/^S-1-\d+(?:-\d+)+$/.test(value.user) : !/^(?:0|[1-9]\d*)$/.test(value.user)))
    ctx.addIssue({ code: "custom", message: "supervision-namespace" })
})
export type SupervisionNamespace = z.infer<typeof supervisionNamespaceSchema>

export function supervisionKey(input: SupervisionNamespace): string {
  const value = supervisionNamespaceSchema.parse(input)
  // Case folding is limited to Windows paths/channel spelling. POSIX
  // namespace spelling is the canonical realpath supplied by its execution host.
  const fold = (entry: string) => value.platform === "win32" ? entry.toLowerCase() : entry
  return createHash("sha256").update(JSON.stringify([value.platform, value.host, value.user,
    value.distro ?? null, fold(value.configDirectory), fold(value.stateDirectory), fold(value.registrationName)])).digest("hex")
}

/** The owning runtime resolver validates this selection. No arbitrary argv,
 * command string, profile environment or credentials can be persisted here. */
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const supervisionTargetSchema = z.object({ binary: text, provenance: z.enum(["npm", "standalone", "custom"]),
  sha256: digest.optional(),
  package: z.object({ file: text, sha256: digest, lock: text }).strict().optional(),
}).strict()
export type SupervisionTarget = z.infer<typeof supervisionTargetSchema>
const controlSchema = z.object({
  requestID, expectedRevision: counter,
  action: z.enum(["on", "off", "first-play", "retry", "select-binary"]),
  target: supervisionTargetSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.action === "select-binary") !== Boolean(value.target))
    ctx.addIssue({ code: "custom", message: "supervision-target" })
})
export type SupervisionControl = z.infer<typeof controlSchema>
const receiptSchema = z.object({ control: controlSchema, appliedRevision: counter }).strict()
const timestamp = z.string().datetime({ offset: true })
const attemptSchema = z.object({ revision: counter, at: timestamp, cause: z.literal("adapter-failed").nullable() }).strict()
export const supervisionManifestSchema = z.object({
  v: z.literal(1), key: z.string().regex(/^[a-f0-9]{64}$/), namespace: supervisionNamespaceSchema,
  revision: counter, desired: z.enum(["unset", "on", "off"]), target: supervisionTargetSchema,
  // Acknowledgement requires a fresh read of the exact owned OS resources. This
  // revision is separate from the preference write and never inferred from time.
  reconciledRevision: counter.nullable(),
  receipt: receiptSchema.nullable(),
  attempt: attemptSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.key !== supervisionKey(value.namespace)
    || !nativePath(value.target.binary, value.namespace.platform === "win32")
    || value.target.package && (!nativePath(value.target.package.file, value.namespace.platform === "win32")
      || !nativePath(value.target.package.lock, value.namespace.platform === "win32"))
    || value.reconciledRevision !== null && value.reconciledRevision > value.revision
    || value.receipt !== null && value.receipt.appliedRevision !== value.revision
    || value.attempt !== undefined && value.attempt.revision > value.revision)
    ctx.addIssue({ code: "custom", message: "supervision-manifest" })
})
export type SupervisionManifest = z.infer<typeof supervisionManifestSchema>

export class SupervisionError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "busy" | "unknown-request" | "unsafe-storage") { super(`supervision-${code}`) }
}
export function parseSupervisionManifest(input: unknown): SupervisionManifest {
  try {
    if (Buffer.byteLength(JSON.stringify(input) ?? "", "utf8") > SUPERVISION_MANIFEST_BYTES) throw new Error()
    return supervisionManifestSchema.parse(input)
  } catch { throw new SupervisionError("invalid") }
}
export function initialSupervisionManifest(namespace: SupervisionNamespace, target: SupervisionTarget): SupervisionManifest {
  return parseSupervisionManifest({ v: 1, key: supervisionKey(namespace), namespace, target,
    revision: 0, desired: "unset", reconciledRevision: null, receipt: null })
}

/** One bounded current receipt. A missing/evicted receipt is unknown; stale
 * revisions never authorize an old ON to overwrite a later OFF. */
export function applySupervisionControl(input: SupervisionManifest, raw: SupervisionControl): SupervisionManifest {
  const current = parseSupervisionManifest(input)
  const parsed = controlSchema.safeParse(raw)
  if (!parsed.success) throw new SupervisionError("invalid")
  const control = parsed.data
  if (current.receipt?.control.requestID === control.requestID) {
    if (JSON.stringify(current.receipt.control) !== JSON.stringify(control)) throw new SupervisionError("conflict")
    return current
  }
  if (control.expectedRevision !== current.revision) throw new SupervisionError("conflict")
  if (control.action === "first-play" && current.desired !== "unset") return current
  // Preserve an unresolved original operation, including an unacknowledged binary
  // selection. OFF alone may fence it; retry reconciles that same revision.
  if (current.receipt && current.reconciledRevision !== current.revision && !["off", "retry"].includes(control.action))
    throw new SupervisionError("busy")
  if (control.action === "retry") return current
  return parseSupervisionManifest({ ...current, revision: current.revision + 1,
    desired: control.action === "on" || control.action === "first-play" ? "on" : control.action === "off" ? "off" : current.desired,
    target: control.target ?? current.target,
    receipt: { control, appliedRevision: current.revision + 1 } })
}

export type SupervisionHealth =
  | { state: "healthy"; pid: number; id: string; startIdentity: string }
  | { state: "absent" | "unknown" | "starting" | "unhealthy" }
export interface SupervisionObservation {
  revision: number
  resources: "absent" | "installed" | "unknown"
  guard: "active" | "absent" | "unknown"
  health: SupervisionHealth
  recoveryNextTickAt?: string
  artifactMissing?: boolean
  linuxLinger?: "enabled" | "external" | "disabled" | "deferred" | "uncertain" | "permission-required"
  detail?: {
    cause: "native-service-disabled-or-unknown" | "start-failed" | "guard-failed" | "service-unknown" | "wsl-forwarding-unavailable" | null
    lastAttemptAt?: string
    retryAt?: string
  }
}
export type SupervisionStatus = {
  desired: SupervisionManifest["desired"]; revision: number
  state: "off" | "pending" | "installed" | "running" | "failing"
  cause: "reconciliation-pending" | "observation-stale" | "resources-unknown" | "guard-absent"
    | "guard-unknown" | "service-absent" | "service-unknown" | "service-starting" | "service-unhealthy"
    | "adapter-failed" | "native-service-disabled-or-unknown" | "start-failed" | "guard-failed" | "artifact-missing" | "wsl-forwarding-unavailable"
    | "linux-linger-deferred" | "linux-linger-uncertain" | "linux-linger-permission-required" | "linux-linger-disabled" | null
  serviceResponding: boolean
  lastAttemptAt?: string
  retryAt?: string
  recoveryNextTickAt?: string
}
export function supervisionStatus(manifest: SupervisionManifest, observation: SupervisionObservation): SupervisionStatus {
  const value = parseSupervisionManifest(manifest)
  const result = (state: SupervisionStatus["state"], cause: SupervisionStatus["cause"]): SupervisionStatus => ({
    desired: value.desired, revision: value.revision, state, cause,
    serviceResponding: observation.revision === value.revision && observation.health.state === "healthy",
    ...(value.attempt?.revision === value.revision ? { lastAttemptAt: value.attempt.at } : {}),
    ...(value.desired === "on" && observation.revision === value.revision && observation.recoveryNextTickAt
      ? { recoveryNextTickAt: observation.recoveryNextTickAt } : {}),
    ...(observation.revision === value.revision && observation.guard === "active" ? {
      ...(observation.detail?.lastAttemptAt ? { lastAttemptAt: observation.detail.lastAttemptAt } : {}),
      ...(observation.detail?.retryAt ? { retryAt: observation.detail.retryAt } : {}),
    } : {}),
  })
  if (observation.revision !== value.revision) return result("failing", "observation-stale")
  if (value.desired === "unset" && observation.resources === "absent" && observation.guard === "absent") return result("off", null)
  if (value.desired === "on" && observation.artifactMissing) return result("failing", "artifact-missing")
  if (observation.linuxLinger && ["uncertain", "permission-required"].includes(observation.linuxLinger))
    return result("failing",
      `linux-linger-${observation.linuxLinger}` as SupervisionStatus["cause"])
  if (value.desired === "on" && observation.linuxLinger === "disabled") return result("failing", "linux-linger-disabled")
  if (value.attempt?.revision === value.revision && value.attempt.cause) return result("failing", value.attempt.cause)
  if (value.reconciledRevision !== value.revision) return result("pending", "reconciliation-pending")
  if (value.desired !== "on") return observation.resources === "absent" && observation.guard === "absent"
    ? result("off", observation.linuxLinger === "deferred" ? "linux-linger-deferred" : null) : result("failing", "resources-unknown")
  if (observation.resources !== "installed") return result("failing", "resources-unknown")
  if (observation.guard !== "active") return result("failing", observation.guard === "absent" ? "guard-absent" : "guard-unknown")
  if (observation.detail?.cause) return result("failing", observation.detail.cause)
  if (observation.health.state === "healthy") return result("running", null)
  if (observation.health.state === "starting") return result("installed", "service-starting")
  return result("failing", `service-${observation.health.state}`)
}
