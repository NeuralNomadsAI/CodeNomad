import type { LocationRef, OpenCodeClient } from "@opencode-ai/client"
import { getLogger } from "../lib/logger"
import { toRequestLocation } from "./request-locations"

const log = getLogger("api")
const pendingByClient = new WeakMap<OpenCodeClient, Map<string, Promise<void>>>()

function locationKey(location?: LocationRef): string {
  return `${location?.directory ?? ""}\0${location?.workspaceID ?? ""}`
}

/**
 * Waits for the current plugin generation before reading a location-scoped catalog.
 * A lagging runtime may not expose the beta route yet, so catalog reads remain the
 * fallback authority and a later plugin.updated event can reconcile them.
 */
export function waitForPluginActivation(client: OpenCodeClient, location?: LocationRef): Promise<void> {
  const awaitActivation = client.plugin?.awaitActivation
  if (typeof awaitActivation !== "function") return Promise.resolve()

  const key = locationKey(location)
  let pending = pendingByClient.get(client)
  const existing = pending?.get(key)
  if (existing) return existing
  if (!pending) {
    pending = new Map()
    pendingByClient.set(client, pending)
  }

  const requests = pending
  const request = Promise.resolve()
    .then(() => awaitActivation.call(
      client.plugin,
      location ? { location: toRequestLocation(location) } : undefined,
    ))
    .catch((error) => {
      log.warn("Failed to wait for plugin activation; continuing with authoritative catalog reads", {
        location,
        error,
      })
    })
    .finally(() => {
      if (requests.get(key) === request) requests.delete(key)
    })
  requests.set(key, request)
  return request
}
