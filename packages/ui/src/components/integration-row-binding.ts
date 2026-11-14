import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type {
  IntegrationAttachResponse,
  IntegrationDetachResponse,
  IntegrationHostOffer,
  IntegrationHostsResponse,
  IntegrationView,
} from "../../../server/src/integration-types"
import { useI18n } from "../lib/i18n"
import {
  integrationAttachChoice,
  integrationChainAction,
  integrationConnection,
  integrationConnectionMessage,
  integrationLink,
  type IntegrationLink,
} from "../lib/integration-row-state"
import { integrationAttachmentRequest } from "../lib/integrations-api"
import { captureBackendOperation } from "../lib/backend-operation"
import { backendEvents } from "../lib/server-events"
import { showToastNotification } from "../lib/notifications"
import { integrationBindings, integrationEpoch } from "../stores/integrations"
import type { IntegrationBindingTarget } from "../stores/integration-bindings-store"

const sameTarget = (left?: IntegrationBindingTarget, right?: IntegrationBindingTarget) => left === right || (!!left && !!right
  && left.instanceId === right.instanceId && left.directory === right.directory && left.sessionID === right.sessionID && left.integrationId === right.integrationId)
const OUTCOMES = new Set(["busy", "gone", "refused"])
interface AttachIntent { target: IntegrationBindingTarget; epoch: string; controller: AbortController; authority: ReturnType<typeof captureBackendOperation> }

/**
 * The displayed conversation's attachment to one integration of a Plugins row: its authoritative read, demanded
 * while the row is shown, and the user's explicit attach and detach. The integration also attaches a conversation
 * itself at its first use. Every request is sent once and the binding is read again afterwards.
 */
export function createIntegrationRowBinding(options: {
  instanceId: () => string
  directory: () => string
  sessionId: () => string | undefined
  integration: () => IntegrationView | undefined
  active: () => boolean
}) {
  const { t } = useI18n()
  const target = createMemo<IntegrationBindingTarget | undefined>(() => {
    const entry = options.integration(), sessionID = options.sessionId()
    return entry && sessionID && options.directory() && entry.family === "native" && entry.state === "ok" && !entry.ambiguous
      ? { instanceId: options.instanceId(), directory: options.directory(), sessionID, integrationId: entry.id } : undefined
  }, undefined, { equals: sameTarget })
  createEffect(() => {
    const value = target()
    if (!value || !options.active()) return
    onCleanup(integrationBindings.demand(value))
  })
  const link = createMemo<IntegrationLink | undefined>(() => {
    const entry = options.integration(), value = target()
    return entry ? integrationLink(entry, value ? integrationBindings.state(value) : undefined) : undefined
  })
  const [reading, setReading] = createSignal(false)
  /** The documents offered to choose from, while that menu is open. */
  const [choices, setChoices] = createSignal<Array<IntegrationHostOffer & { attach: () => void }>>()
  const epoch = createMemo(() => integrationEpoch(options.instanceId(), options.sessionId()))
  let intent: AttachIntent | undefined
  let disposed = false
  const revoke = () => {
    intent?.controller.abort(); intent = undefined
    setChoices(undefined); setReading(false)
  }
  createEffect(on(() => [target(), options.active(), epoch()] as const, revoke, { defer: true }))
  createEffect(on(() => backendEvents.signalForInstance(options.instanceId()), revoke, { defer: true }))
  onCleanup(() => { disposed = true; revoke() })
  const owns = (captured: AttachIntent) => captured.authority.current() && !disposed && intent === captured && !captured.controller.signal.aborted
    && options.active() && sameTarget(target(), captured.target) && epoch() === captured.epoch
  const busy = () => { const value = target(); return reading() || (value ? integrationBindings.busy(value) : false) }
  const fail = (value: IntegrationBindingTarget, key = "integrations.error.retry", vars?: Record<string, string>) => {
    if (!disposed && options.active() && sameTarget(target(), value)) showToastNotification({ category: "opencode", variant: "error", message: t(key, vars) })
  }
  /** Why the conversation cannot be attached now, or undefined when it can. */
  const unavailable = createMemo(() => {
    const entry = options.integration()
    if (!entry || link()?.state === "attached") return undefined
    if (!options.sessionId()) return t("integrations.link.noConversation")
    const connection = integrationConnection(entry)
    if (connection.state === "offers") return undefined
    const [key, vars] = integrationConnectionMessage(connection, entry.app.name)
    return t(key, vars)
  })

  /** At most one `detachHost` for the displayed conversation. */
  const detach = async () => {
    const value = target()
    if (disposed || !value || link()?.state !== "attached" || busy() || !options.active()) return
    const authority = captureBackendOperation(value.instanceId, undefined, () => !disposed && options.active() && sameTarget(target(), value))
    if (!authority.current()) return
    await integrationBindings.run(value, async () => {
      if (!authority.current()) return
      try {
        const result = await integrationAttachmentRequest<IntegrationDetachResponse>(value.instanceId, value.directory, value.integrationId,
          "detach", authority.signal, { sessionID: value.sessionID })
        if (result?.outcome !== "detached" && result?.outcome !== "none") throw new Error("Invalid detach result")
      } catch { if (authority.current()) fail(value) }
    })
  }
  /** At most one `attachHost` of the displayed conversation to the chosen offer. */
  const attach = async (captured: AttachIntent, offerID: string) => {
    if (!owns(captured) || busy() || chainAction() !== "attach") return
    const value = captured.target
    await integrationBindings.run(value, async () => {
      if (!owns(captured)) return
      // Consume consent at dispatch; the admitted mutation has its own lifetime and is never replayed.
      revoke()
      try {
        const result = await integrationAttachmentRequest<IntegrationAttachResponse>(value.instanceId, value.directory, value.integrationId,
          "attach", captured.authority.signal, { sessionID: value.sessionID, offerID })
        if (!captured.authority.current()) return
        if (result?.outcome === "attached") return
        if (OUTCOMES.has(result?.outcome)) fail(value, `integrations.outcome.${result.outcome}`)
        else throw new Error("Invalid attach result")
      } catch { if (captured.authority.current()) fail(value) }
    })
  }
  /** What the chain button does now. */
  const chainAction = () => { const value = link(); return value ? integrationChainAction(value, unavailable()) : "unavailable" }
  /** The chain button: detach when attached; else read the offers, attach the only one or offer the choice. */
  const activate = async () => {
    if (chainAction() === "detach") return detach()
    const value = target(), entry = options.integration()
    if (disposed || !value || !entry || chainAction() !== "attach" || busy() || !options.active()) return
    const authority = captureBackendOperation(value.instanceId)
    if (!authority.current()) return
    const captured: AttachIntent = { target: value, epoch: epoch(), controller: new AbortController(), authority }
    intent = captured
    setReading(true)
    try {
      const result = await integrationAttachmentRequest<IntegrationHostsResponse>(value.instanceId, value.directory, value.integrationId,
        "hosts", AbortSignal.any([captured.controller.signal, authority.signal]))
      if (!owns(captured)) return
      if (!Array.isArray(result?.offers)) throw new Error("Invalid hosts result")
      const choice = integrationAttachChoice(result.offers)
      if (choice.kind === "none") { fail(value, "integrations.connection.noOffer", { app: entry.app.name }); revoke() }
      else if (choice.kind === "attach") { setReading(false); await attach(captured, choice.offerID) }
      else setChoices(choice.offers.map(offer => ({ ...offer, attach: () => void attach(captured, offer.offerID) })))
    } catch { if (owns(captured)) { fail(value); revoke() } }
    finally { if (intent === captured) setReading(false) }
  }
  return { link, busy, unavailable, chainAction, choices, closeChoices: () => { if (choices()) revoke() }, activate, detach }
}

export type IntegrationRowBinding = ReturnType<typeof createIntegrationRowBinding>
