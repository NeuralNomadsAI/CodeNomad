import { createEffect, createMemo, onCleanup } from "solid-js"
import type { IntegrationDetachResponse, IntegrationView } from "../../../server/src/integration-types"
import { useI18n } from "../lib/i18n"
import { integrationLink, type IntegrationLink } from "../lib/integration-row-state"
import { integrationAttachmentRequest } from "../lib/integrations-api"
import { showToastNotification } from "../lib/notifications"
import { integrationBindings } from "../stores/integrations"
import type { IntegrationBindingTarget } from "../stores/integration-bindings-store"

const sameTarget = (left?: IntegrationBindingTarget, right?: IntegrationBindingTarget) => left === right || (!!left && !!right
  && left.instanceId === right.instanceId && left.directory === right.directory && left.sessionID === right.sessionID && left.integrationId === right.integrationId)

/**
 * The displayed conversation's attachment to one integration of a Plugins row: its authoritative read, demanded
 * while the row is shown, and the one-click detach. The integration attaches a conversation itself at first use.
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
  const busy = () => { const value = target(); return value ? integrationBindings.busy(value) : false }
  /** At most one `detachHost` for the displayed conversation; its result is read again, never replayed. */
  const detach = async () => {
    const value = target()
    if (!value || link()?.state !== "attached" || busy() || !options.active()) return
    await integrationBindings.run(value, async () => {
      try {
        const result = await integrationAttachmentRequest<IntegrationDetachResponse>(value.instanceId, value.directory, value.integrationId,
          "detach", new AbortController().signal, { sessionID: value.sessionID })
        if (result?.outcome !== "detached" && result?.outcome !== "none") throw new Error("Invalid detach result")
      } catch {
        if (sameTarget(target(), value)) showToastNotification({ category: "opencode", variant: "error", message: t("integrations.error.retry") })
      }
    })
  }
  return { link, busy, detach }
}
