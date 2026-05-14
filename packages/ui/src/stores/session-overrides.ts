/**
 * Session overrides track user-explicit agent/model selections.
 *
 * Invariant:
 *   `session.agent` / `session.model` = display state (what the client believes the server has).
 *   `overrides.agent` / `overrides.model` = user intent (what the user wants to force on the next request).
 *
 * Only overrides are sent in promptAsync / command request bodies.
 * Server-observed values (from SSE, message loading) update display state but do NOT create overrides.
 */

import { createSignal } from "solid-js"

export interface SessionOverride {
  agent?: string
  /** Format: "providerId/modelId" */
  model?: string
}

type OverrideMap = Map<string, Map<string, SessionOverride>>

const [overrides, setOverrides] = createSignal<OverrideMap>(new Map())

function getOverride(instanceId: string, sessionId: string): SessionOverride | undefined {
  return overrides().get(instanceId)?.get(sessionId)
}

function setOverride(instanceId: string, sessionId: string, patch: Partial<SessionOverride>): void {
  setOverrides((prev) => {
    const next = new Map(prev)
    const instanceMap = new Map(next.get(instanceId) ?? new Map<string, SessionOverride>())
    const existing = instanceMap.get(sessionId) ?? {}
    const merged: SessionOverride = { ...existing, ...patch }

    // Clean up undefined/empty values
    if (!merged.agent) delete merged.agent
    if (!merged.model) delete merged.model

    if (!merged.agent && !merged.model) {
      instanceMap.delete(sessionId)
    } else {
      instanceMap.set(sessionId, merged)
    }

    if (instanceMap.size === 0) {
      next.delete(instanceId)
    } else {
      next.set(instanceId, instanceMap)
    }
    return next
  })
}

/** Record that the user explicitly selected an agent for this session. */
function setAgentOverride(instanceId: string, sessionId: string, agent: string): void {
  setOverride(instanceId, sessionId, { agent })
}

/** Record that the user explicitly selected a model for this session. */
function setModelOverride(instanceId: string, sessionId: string, model: { providerId: string; modelId: string }): void {
  if (!model.providerId || !model.modelId) return
  setOverride(instanceId, sessionId, { model: `${model.providerId}/${model.modelId}` })
}

/** Clear the agent override (e.g., after server confirms the agent change). */
function clearAgentOverride(instanceId: string, sessionId: string): void {
  const current = getOverride(instanceId, sessionId)
  if (!current?.agent) return
  setOverride(instanceId, sessionId, { agent: undefined })
}

/** Clear the model override (e.g., after server confirms the model change). */
function clearModelOverride(instanceId: string, sessionId: string): void {
  const current = getOverride(instanceId, sessionId)
  if (!current?.model) return
  setOverride(instanceId, sessionId, { model: undefined })
}

/** Clear both overrides for a session (e.g., when server state diverges). */
function clearOverrides(instanceId: string, sessionId: string): void {
  setOverrides((prev) => {
    const next = new Map(prev)
    const instanceMap = next.get(instanceId)
    if (!instanceMap) return prev
    if (!instanceMap.has(sessionId)) return prev
    const updated = new Map(instanceMap)
    updated.delete(sessionId)
    if (updated.size === 0) {
      next.delete(instanceId)
    } else {
      next.set(instanceId, updated)
    }
    return next
  })
}

/** Clear all overrides for an instance (e.g., on disconnect). */
function clearInstanceOverrides(instanceId: string): void {
  setOverrides((prev) => {
    if (!prev.has(instanceId)) return prev
    const next = new Map(prev)
    next.delete(instanceId)
    return next
  })
}

/**
 * Parse a model override string back into providerId/modelId.
 * Returns undefined if no model override exists.
 */
function getModelOverrideValue(instanceId: string, sessionId: string): { providerId: string; modelId: string } | undefined {
  const raw = getOverride(instanceId, sessionId)?.model
  if (!raw) return undefined
  const slashIndex = raw.indexOf("/")
  if (slashIndex <= 0) return undefined
  return {
    providerId: raw.substring(0, slashIndex),
    modelId: raw.substring(slashIndex + 1),
  }
}

export {
  overrides,
  getOverride,
  setAgentOverride,
  setModelOverride,
  clearAgentOverride,
  clearModelOverride,
  clearOverrides,
  clearInstanceOverrides,
  getModelOverrideValue,
}
