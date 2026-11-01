/** Trusted in-process authority only. Never deserialize this from a request or frame. */
export interface NativeMutationAuthority {
  /** Refresh exact consent/digest, session/Location and captured target authority. */
  revalidate(): Promise<void>
  /** Synchronous, idempotent check of live revocation, expiry and connection/mount fences. */
  assertCurrent(): void
}

/** A submitted native mutation may still complete. Never replay it automatically. */
export class NativeMutationUncertainError extends Error {
  readonly code = "mutation-uncertain"
  constructor() { super("Native mutation outcome is uncertain"); this.name = "NativeMutationUncertainError" }
}

/** One invocation, shared across nested queues, commit submission and deadline handlers. */
export class NativeMutationAdmission {
  private submitted = false
  constructor(readonly authority?: NativeMutationAuthority) {}

  async revalidate(): Promise<void> {
    await this.authority?.revalidate()
    this.assertCurrent()
  }

  assertCurrent(): void { this.authority?.assertCurrent() }

  /** Mark only immediately before the irreversible native call, never during preparation. */
  admit(): void {
    this.assertCurrent()
    this.submitted = true
  }

  failure(error: unknown): unknown {
    return this.authority && this.submitted ? new NativeMutationUncertainError() : error
  }
}
