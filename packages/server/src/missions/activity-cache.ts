import type { EventEmitter } from "node:events"
import type { OpenCodeClient, SessionInfo } from "@opencode/client"

import { sameLocation } from "../opencode/compatibility/location"
import type { NativeMissionFamilyTree } from "./native-session-family"

/** A kept family tree is read again after this long, whatever the events say. */
export const MISSION_FAMILY_TREE_TTL_MS = 60_000
const MAX_TREES = 512
const MAX_MISSING = 4096

/** Native events that can change a family's membership, parents, locations or titles.
 * Ordinary `session.updated` ticks do not alter parent/child topology and must not
 * flush every mission's cached tree on every model turn. */
const STRUCTURE_EVENTS = new Set(["session.created", "session.forked", "session.moved", "session.deleted",
  "session.archived", "session.renamed"])

interface ClientCache {
  trees: Map<string, { root: SessionInfo; tree: NativeMissionFamilyTree; at: number; epoch: number }>
  /** Sessions the daemon answered 404 for: deletion is final and IDs are never reused. */
  missing: Set<string>
  /** A session's parent, as read while walking a pending request's ancestry. */
  parents: Map<string, { parentID: string | undefined; epoch: number }>
}

/**
 * Display-only memory between Mission activity reads of one backend: bounded family
 * trees, kept until a structural native event, an event-stream gap or their TTL, and the
 * sessions known deleted. Keyed by the daemon client, so a new connection starts empty.
 * Native activity (active sessions, Shells, Forms, permissions, actor roots, inboxes)
 * is still read on every observation. Never authority.
 */
export class MissionActivityCache {
  private readonly clients = new WeakMap<OpenCodeClient, ClientCache>()
  /** Bumped by every structural event or stream status change: older trees are stale. */
  private epoch = 0
  /** Instances whose event stream is not connected: no tree is kept meanwhile. */
  private readonly disconnected = new Set<string>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Feed from the backend's routed instance events and stream statuses. */
  observeEvent(event: { type: string }): void {
    if (STRUCTURE_EVENTS.has(event.type)) this.epoch += 1
  }

  observeStatus(instanceId: string, status: string): void {
    this.epoch += 1
    if (status === "connected") this.disconnected.delete(instanceId)
    else this.disconnected.add(instanceId)
  }

  forgetInstance(instanceId: string): void {
    this.disconnected.delete(instanceId)
    this.epoch += 1
  }

  private of(client: OpenCodeClient): ClientCache {
    let cache = this.clients.get(client)
    if (!cache) this.clients.set(client, cache = { trees: new Map(), missing: new Set(), parents: new Map() })
    return cache
  }

  /** The kept parent of a session, while nothing structural happened since it was read. */
  parent(client: OpenCodeClient, sessionID: string): { parentID: string | undefined } | undefined {
    const kept = this.clients.get(client)?.parents.get(sessionID)
    return kept && kept.epoch === this.epoch && this.disconnected.size === 0 ? kept : undefined
  }

  keepParent(client: OpenCodeClient, sessionID: string, parentID: string | undefined, epoch: number): void {
    if (epoch !== this.epoch || this.disconnected.size > 0) return
    const parents = this.of(client).parents
    parents.delete(sessionID)
    if (parents.size >= MAX_MISSING) parents.delete(parents.keys().next().value!)
    parents.set(sessionID, { parentID, epoch })
  }

  isMissing(client: OpenCodeClient, sessionID: string): boolean {
    return this.clients.get(client)?.missing.has(sessionID) ?? false
  }

  markMissing(client: OpenCodeClient, sessionID: string): void {
    const missing = this.of(client).missing
    if (missing.size >= MAX_MISSING) missing.delete(missing.values().next().value!)
    missing.add(sessionID)
    // A deleted session leaves every family it belonged to.
    this.epoch += 1
  }

  /** The kept tree of `root`, when its root still reads the same and nothing structural happened since. */
  tree(client: OpenCodeClient, root: SessionInfo): NativeMissionFamilyTree | undefined {
    const kept = this.clients.get(client)?.trees.get(root.id)
    if (!kept) return undefined
    if (kept.epoch !== this.epoch || this.disconnected.size > 0 || this.now() - kept.at >= MISSION_FAMILY_TREE_TTL_MS
      || kept.root.parentID !== root.parentID || kept.root.projectID !== root.projectID || !sameLocation(kept.root.location, root.location)) {
      this.clients.get(client)!.trees.delete(root.id)
      return undefined
    }
    // The root was just read: its fresh record replaces the kept one.
    return new Map(kept.tree).set(root.id, root)
  }

  /** Keep a tree read at `epoch` (`currentEpoch()` before its reads began). */
  keepTree(client: OpenCodeClient, root: SessionInfo, tree: NativeMissionFamilyTree, epoch: number): void {
    if (epoch !== this.epoch || this.disconnected.size > 0) return
    const trees = this.of(client).trees
    trees.delete(root.id)
    if (trees.size >= MAX_TREES) trees.delete(trees.keys().next().value!)
    trees.set(root.id, { root, tree, at: this.now(), epoch })
  }

  currentEpoch(): number {
    return this.epoch
  }
}

type InstanceEvents = Pick<EventEmitter, "on" | "off">

/** Feeds `cache` from the backend's event bus; returns the unsubscribe. A stopped or
 * failed workspace no longer holds trees back; any other disconnection does. */
export function connectMissionActivityCache(bus: InstanceEvents, cache: MissionActivityCache): () => void {
  const onEvent = (payload: { instanceId: string; event: { type: string } }) => cache.observeEvent(payload.event)
  const onStatus = (payload: { instanceId: string; status: string; reason?: string }) => {
    if (payload.status === "disconnected" && (payload.reason === "workspace stopped" || payload.reason === "workspace error")) cache.forgetInstance(payload.instanceId)
    else cache.observeStatus(payload.instanceId, payload.status)
  }
  bus.on("instance.event", onEvent)
  bus.on("instance.eventStatus", onStatus)
  return () => { bus.off("instance.event", onEvent); bus.off("instance.eventStatus", onStatus) }
}
