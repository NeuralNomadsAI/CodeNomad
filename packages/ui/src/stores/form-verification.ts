import { batch, createSignal } from "solid-js"
import type { FormWithLocation } from "./forms"
import { backgroundReads } from "../lib/background-read-queue"
import { captureKnownFormVerification } from "./instances"
import { canAnswerInterruption, captureInterruptionRevision, publishVerifiedFormAuthority } from "./interruption-authority"
import { FORM_VERIFICATION_TIMEOUT_MS } from "../../../server/src/opencode/form-verification-policy"
import { runAbortable } from "./app-session-restore-timeout"

type Status = "checking" | "pending" | "answered" | "cancelled" | "indeterminate"
type Attempt = { status: Status; current: () => boolean }
const attempts = new WeakMap<FormWithLocation, Attempt>()
const [revision, setRevision] = createSignal(0)
const changed = () => setRevision(value => value + 1)
// Only native fields consumed by the editor participate; inert future properties
// have no authority. Changed editor schemas remain indeterminate, preserving drafts.
const fieldKeys = ["type", "key", "title", "description", "required", "hidden", "when", "op", "value", "label", "format",
  "minLength", "maxLength", "pattern", "placeholder", "default", "options", "custom", "minimum", "maximum", "minItems", "maxItems", "url"]

export function formVerificationStatus(form: FormWithLocation): Status | undefined {
  revision()
  const attempt = attempts.get(form)
  return attempt?.current() ? attempt.status : undefined
}

export function canVerifyKnownForm(instanceId: string, form: FormWithLocation): boolean {
  const captured = captureKnownFormVerification(instanceId, form)
  return !canAnswerInterruption(instanceId, "form", form) && captured.current() && !captured.busy()
}

/** The caller supplies its held editor object before queueing; no automatic caller. */
export async function verifyKnownForm(instanceId: string, form: FormWithLocation): Promise<void> {
  const captured = captureKnownFormVerification(instanceId, form)
  const nativeRevision = captureInterruptionRevision(instanceId, "form", form.id)
  if (!captured.current() || captured.busy() || !captured.client || !captured.location || canAnswerInterruption(instanceId, "form", form)
    || formVerificationStatus(form) === "checking") return
  const expiresAt = performance.now() + FORM_VERIFICATION_TIMEOUT_MS
  const signal = AbortSignal.timeout(FORM_VERIFICATION_TIMEOUT_MS)
  const attempt: Attempt = { status: "checking", current: () => captured.current() && nativeRevision() }
  const current = () => attempts.get(form) === attempt && attempt.current()
  const assertCurrent = () => { signal.throwIfAborted(); if (performance.now() >= expiresAt || !current()) throw new Error("Form verification superseded") }
  attempts.set(form, attempt); changed()
  try {
    const value = await backgroundReads.run(signal, async () => {
      assertCurrent()
      const result = await runAbortable(() => {
        assertCurrent()
        return captured.client!.session.form.get({ sessionID: form.sessionID, formID: form.id }, { ...captured.options, signal })
      }, { signal })
      assertCurrent()
      return result
    }, "visible")
    assertCurrent()
    // The proxy validates WIRE before the SDK and removes answers. Only narrow
    // identity/state is used here; changed schemas wait for a fresh native event.
    if (!value || value.id !== form.id || value.sessionID !== form.sessionID
      || !["pending", "answered", "cancelled"].includes(value.state?.status)
      || JSON.stringify(value.fields, fieldKeys) !== JSON.stringify(form.fields, fieldKeys)) throw new Error("Invalid Form verification")
    assertCurrent()
    batch(() => {
      attempt.status = value.state.status
      attempt.current = publishVerifiedFormAuthority(instanceId, form, captured.location!, captured.current, value.state.status === "pending")
      changed()
    })
  } catch {
    if (!current()) return
    attempt.status = "indeterminate"
  } finally { changed() }
}
