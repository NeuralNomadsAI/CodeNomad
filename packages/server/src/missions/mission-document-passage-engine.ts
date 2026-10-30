import { missionDocumentChanges as changes } from "./mission-document-state"
import { missionLaunchLimit } from "./launch-policy"
import type { MissionDocument, MissionSourceCheckpoint, MissionWake } from "./mission-document"
import type { NativeMissionDocumentStore } from "./mission-document-store"

export type DocumentPassageWake = { missionID: string; generation: number; scheduleID: string; sessionID: string; run: number; messageID: string; dueAt?: number }
export type DocumentFanInWindow = { incarnation: string; cutoff: number; timeGeneration: number; principalIDs: string[]; completed: boolean; suppress: boolean }
export type DocumentPassageResult = "idle" | "ignored" | "started" | "pending" | "settled" | "unknown"
export type DocumentPassagePreflight = { messagePresent: boolean; ready: boolean; cutoff: number }
export type DocumentPassageAdmission = { kind: "admitted" | "recorded"; passageID: string; messageID: string; coordinatorSessionID: string; at: number }
  | { kind: "not-started"; current(): true } | { kind: "unknown" }
export interface DocumentPassagePorts {
  incarnation: string
  now(): number
  /** Pure invocation/incarnation guard, also called inside the short SQL CAS. */
  current(): true
  verifyWake(doc: MissionDocument, wake: DocumentPassageWake): Promise<{ wake: MissionWake; current(): true }>
  coverage(doc: MissionDocument, window: DocumentFanInWindow): Promise<{ complete: boolean; wakes: MissionWake[]; current(): true }>
  snapshot(doc: MissionDocument): Promise<{ changed: boolean; checkpoints: MissionSourceCheckpoint[]; current(): true; revalidate?(): Promise<void> }>
  admit(doc: MissionDocument, locked: NativeMissionDocumentStore): Promise<DocumentPassageAdmission>
  observe(doc: MissionDocument, locked: NativeMissionDocumentStore): Promise<{ outcome: "completed" | "failed" | "ended-without-report"; current(): true } | undefined>
  retired?(doc: MissionDocument): void
}

/** Business state machine only. All native I/O runs while holding the same
 * document exclusion as controls, never while holding a SQLite transaction. */
export class MissionDocumentPassageEngine {
  constructor(private readonly store: NativeMissionDocumentStore, private readonly ports: DocumentPassagePorts) {}

  /** Read-only prerequisite for claiming a technical wake. The transport owns
   * receipt authentication and prior-claim admission; this method publishes nothing. */
  preflight(input: { missionID: string; wake: DocumentPassageWake; cutoff?: number }): Promise<DocumentPassagePreflight> {
    return this.store.withExclusion(async locked => {
      const doc = await this.read(locked, input.missionID)
      const cutoff = doc?.fanIn && !doc.fanIn.completed ? doc.fanIn.cutoff : input.cutoff ?? this.ports.now()
      if (!Number.isSafeInteger(cutoff) || cutoff < 0) throw new Error("Invalid passage preflight cutoff")
      const reply = (messagePresent: boolean, ready = false) => ({ messagePresent, ready, cutoff })
      if (!doc || doc.oneTime && !doc.dormantJournal || doc.preparation?.pending) return reply(false)
      const wake = input.wake, calendar = doc.calendars.find(item => item.scheduleID === wake.scheduleID)
      if (!calendar || calendar.sessionID !== wake.sessionID || calendar.timeGeneration !== wake.generation || wake.missionID !== doc.id)
        return reply(false)
      let verified: Awaited<ReturnType<DocumentPassagePorts["verifyWake"]>>
      try { verified = await this.ports.verifyWake(doc, wake); verified.current() }
      catch { this.ports.current(); return reply(false) }
      if (wake.run <= calendar.highWater) return reply(true, true)
      if (calendar.role === "reconciliation" || doc.pending || doc.state !== "running")
        return reply(true, wake.run === calendar.highWater + 1)
      if (doc.blocked || doc.synchronization || doc.deletion || doc.calendarOwner?.operation.pending || verified.wake.dueAt > cutoff) return reply(true)
      const window = doc.fanIn && !doc.fanIn.completed ? doc.fanIn : this.windowValue(doc, cutoff, false)
      try {
        const coverage = await this.ports.coverage(doc, window)
        const observed = coverage.wakes.filter(item => item.dueAt <= cutoff)
        if (!coverage.complete || !this.contiguous(doc, coverage.wakes) || !this.contiguous(doc, observed)
          || !observed.some(item => item.scheduleID === verified.wake.scheduleID && item.run === verified.wake.run
            && item.messageID === verified.wake.messageID && item.dueAt === verified.wake.dueAt)) return reply(true)
        coverage.current(); this.ports.current()
        return reply(true, true)
      } catch { this.ports.current(); return reply(true) }
    })
  }

  wake(input: { missionID: string; wake?: DocumentPassageWake; cutoff?: number }): Promise<DocumentPassageResult> {
    return this.store.withExclusion(async locked => {
      let doc = await this.read(locked, input.missionID)
      if (!doc || doc.oneTime && !doc.dormantJournal || doc.preparation?.pending) return "idle"
      const incoming = input.wake
      const calendar = incoming && doc.calendars.find(item => item.scheduleID === incoming.scheduleID)
      if (incoming && (!calendar || calendar.sessionID !== incoming.sessionID || calendar.timeGeneration !== incoming.generation
        || incoming.missionID !== doc.id)) return "ignored"
      // Durable technical admission outlives native carrier-message retention.
      if (incoming && incoming.run <= calendar!.highWater) return "ignored"
      const verified = incoming ? await this.ports.verifyWake(doc, incoming) : undefined
      verified?.current()
      const auxiliary = calendar?.role === "reconciliation" || !incoming
      if (auxiliary && verified && incoming!.run > calendar!.highWater) {
        doc = await this.change(locked, doc, next => changes.processWake(next, verified.wake), verified.current)
      }
      // An incarnation window remembers overlap even if settlement succeeds fast.
      if (doc.pending && (!doc.fanIn || doc.fanIn.completed))
        doc = await this.window(locked, doc, input.cutoff, true)
      if (doc.pending) {
        if (!auxiliary && verified && incoming!.run === calendar!.highWater + 1)
          doc = await this.change(locked, doc, next => changes.processWake(next, verified.wake), verified.current)
        await this.closeSuppressedWindow(locked, doc)
        return this.reconcileLocked(locked, doc.id)
      }
      if (auxiliary) {
        await this.closeSuppressedWindow(locked, doc)
        return "idle" // An auxiliary never reserves business work.
      }
      if (!verified || incoming!.run <= calendar!.highWater) return "ignored"
      if (doc.state !== "running" || doc.blocked || doc.synchronization || doc.deletion) {
        await this.change(locked, doc, next => changes.processWake(next, verified.wake), verified.current)
        return "ignored"
      }
      for (let pass = 0; pass < 2; pass++) {
        if (!doc.fanIn || doc.fanIn.completed) doc = await this.window(locked, doc, input.cutoff, false)
        const window = doc.fanIn!, coverage = await this.ports.coverage(doc, window)
        if (!coverage.complete) return "unknown"
        coverage.current()
        const observed = coverage.wakes.filter(wake => wake.dueAt <= window.cutoff)
        const wakes = observed.filter(wake => doc!.slotEndsAt === null || wake.dueAt <= doc!.slotEndsAt)
        if (!this.contiguous(doc, coverage.wakes) || !this.contiguous(doc, observed) || !this.contiguous(doc, wakes)) return "unknown"
        if (window.suppress || !wakes.length) {
          doc = await this.consume(locked, doc, observed, coverage.current)
          if (incoming!.run <= doc.calendars.find(item => item.scheduleID === incoming!.scheduleID)!.highWater) return "ignored"
          continue
        }
        const snapshot = await this.ports.snapshot(doc)
        snapshot.current(); coverage.current()
        if (!snapshot.changed) {
          await this.consume(locked, doc, wakes, () => { snapshot.current(); return coverage.current() }, snapshot.revalidate, true)
          return "ignored"
        }
        // reserve accepts one next occurrence per principal. Older contiguous
        // occurrences are ignored in the SAME CAS, preserving the latest fan-in.
        await this.change(locked, doc, next => {
          this.recordCheck(next)
          const selected: MissionWake[] = []
          for (const principal of next.calendars.filter(item => item.role === "principal")) {
            const group = wakes.filter(wake => wake.scheduleID === principal.scheduleID).sort((a, b) => a.run - b.run)
            for (const wake of group.slice(0, -1)) changes.processWake(next, wake)
            const last = group.at(-1)
            if (last) { changes.prepareWake(next, last); selected.push(last) }
          }
          changes.reserve(next, { kind: "wake", wakes: selected }, this.ports.now(), snapshot.checkpoints)
          for (const wake of [...coverage.wakes].sort((a, b) => a.run - b.run)) {
            const principal = next.calendars.find(item => item.scheduleID === wake.scheduleID)
            if (principal && wake.run > principal.highWater) changes.processWake(next, wake)
          }
          next.fanIn!.completed = true
        }, () => { snapshot.current(); return coverage.current() }, snapshot.revalidate)
        const reconciled = await this.reconcileLocked(locked, doc.id)
        return reconciled === "pending" ? "started" : reconciled
      }
      return "unknown"
    })
  }

  reconcile(input: { missionID: string }): Promise<DocumentPassageResult> {
    return this.store.withExclusion(async locked => {
      let doc = await this.read(locked, input.missionID)
      if (doc?.pending) {
        if (!doc.fanIn || doc.fanIn.completed) doc = await this.window(locked, doc, undefined, true)
      }
      if (doc) await this.closeSuppressedWindow(locked, doc)
      return this.reconcileLocked(locked, input.missionID)
    })
  }

  runNow(input: { missionID: string; requestID: string; expectedRevision: number }): Promise<DocumentPassageResult> {
    return this.store.withExclusion(async locked => {
      const doc = await this.read(locked, input.missionID)
      if (!doc || doc.oneTime && !doc.dormantJournal || doc.preparation?.pending) throw new Error("Scheduled document unavailable")
      if (doc.firstPlayedAt === null) throw new Error("Scheduled Mission requires first Play before Run now")
      if (doc.pending?.origin.kind === "manual" && doc.pending.origin.requestID === input.requestID) {
        if (doc.pending.manualExpectedRevision === undefined) throw new Error("Manual passage request identity unknown")
        if (doc.pending.manualExpectedRevision !== input.expectedRevision) throw new Error("Manual passage request conflict")
        return this.reconcileLocked(locked, doc.id)
      }
      const receipt = doc.history.find(item => item.origin.kind === "manual" && item.origin.requestID === input.requestID)
      if (receipt) {
        if (receipt.manualExpectedRevision === undefined) throw new Error("Manual passage request identity unknown")
        if (receipt.manualExpectedRevision !== input.expectedRevision) throw new Error("Manual passage request conflict")
        return "settled"
      }
      if (doc.revision !== input.expectedRevision || doc.pending || doc.deletion || doc.blocked || doc.synchronization
        || doc.state === "stopped" || doc.state === "finished" || doc.fanIn && !doc.fanIn.completed) throw new Error("Manual passage conflict")
      const maximum = missionLaunchLimit(doc.configuration.launch)
      if (maximum !== null && doc.launchedCount >= maximum) throw new Error("Mission launch budget exhausted")
      const snapshot = await this.ports.snapshot(doc)
      snapshot.current()
      await this.change(locked, doc, next => {
        this.recordCheck(next)
        // The owner validates/persists the paused manual control. The temporary
        // state exists only inside this atomic reservation, never arms a calendar.
        const state = next.state
        next.state = "running"
        changes.reserve(next, { kind: "manual", requestID: input.requestID }, this.ports.now(), snapshot.checkpoints)
        next.pending!.manualExpectedRevision = input.expectedRevision
        next.pending!.manualAllowed = true
        next.state = state
      }, snapshot.current, snapshot.revalidate)
      return this.reconcileLocked(locked, doc.id)
    })
  }

  private async reconcileLocked(locked: NativeMissionDocumentStore, id: string): Promise<DocumentPassageResult> {
    let doc = await this.read(locked, id)
    if (!doc?.pending) return "idle"
    let admission: DocumentPassageAdmission
    try { admission = await this.ports.admit(doc, locked) } catch { return "unknown" }
    if (admission.kind === "unknown") return "unknown"
    // Admission may publish its write-ahead attempt before the native call.
    const passageID = doc.pending.id
    doc = await this.read(locked, id)
    if (!doc?.pending || doc.pending.id !== passageID) throw new Error("Passage changed during admission")
    if (admission.kind === "not-started") {
      if (doc.pending.admittedAt !== null || doc.pending.admissionAttempted) return "unknown"
      await this.change(locked, doc, next => changes.settle(next, doc!.pending!.id, "failed", this.ports.now(), true), admission.current)
      this.ports.retired?.(doc)
      return "settled"
    }
    if (admission.passageID !== doc.pending.id || admission.messageID !== doc.pending.messageID
      || admission.coordinatorSessionID !== doc.pending.coordinatorSessionID) throw new Error("Original passage admission differs")
    if (doc.pending.admittedAt === null)
      doc = await this.change(locked, doc, next => changes.admitted(next, next.pending!.id, admission.at))
    let observed: Awaited<ReturnType<DocumentPassagePorts["observe"]>>
    try { observed = await this.ports.observe(doc, locked) } catch { return "unknown" }
    if (!observed) return "pending"
    const at = Math.max(this.ports.now(), doc.pending!.createdAt, doc.pending!.admittedAt ?? 0, doc.history.at(-1)?.settledAt ?? 0)
    const settled = await this.change(locked, doc, next => {
      changes.settle(next, next.pending!.id, observed!.outcome, at)
      // Persist the end-of-flight cutoff in the archive CAS: even a passage that
      // finishes before sibling hooks run cannot turn an overlap into new work.
      if (next.calendars.some(item => item.role === "principal")) next.fanIn = this.windowValue(next, at, true)
    }, observed.current)
    await this.closeSuppressedWindow(locked, settled)
    this.ports.retired?.(doc)
    return "settled"
  }
  private async closeSuppressedWindow(locked: NativeMissionDocumentStore, doc: MissionDocument) {
    if (!doc.fanIn || doc.fanIn.completed || !doc.fanIn.suppress) return
    let coverage: Awaited<ReturnType<DocumentPassagePorts["coverage"]>>
    try { coverage = await this.ports.coverage(doc, doc.fanIn) } catch { return }
    const wakes = doc.pending ? coverage.wakes : coverage.wakes.filter(wake => wake.dueAt <= doc.fanIn!.cutoff)
    if (coverage.complete && this.contiguous(doc, wakes)) await this.consume(locked, doc, wakes, coverage.current)
  }
  private async window(locked: NativeMissionDocumentStore, doc: MissionDocument, cutoff: number | undefined, suppress: boolean) {
    if (!doc.calendars.some(item => item.role === "principal")) return doc
    return this.change(locked, doc, next => {
      next.fanIn = this.windowValue(next, cutoff ?? this.ports.now(), suppress)
    })
  }
  private windowValue(doc: MissionDocument, cutoff: number, suppress: boolean): DocumentFanInWindow {
    return { incarnation: this.ports.incarnation, cutoff, timeGeneration: doc.timeGeneration,
      principalIDs: doc.calendars.filter(item => item.role === "principal").map(item => item.scheduleID).sort(), completed: false, suppress }
  }
  private consume(locked: NativeMissionDocumentStore, doc: MissionDocument, wakes: MissionWake[], current: () => true, prepare?: () => Promise<void>, checked = false) {
    return this.change(locked, doc, next => {
      if (checked) this.recordCheck(next)
      for (const wake of [...wakes].sort((a, b) => a.run - b.run)) changes.processWake(next, wake)
      next.fanIn!.completed = true
    }, current, prepare)
  }
  private recordCheck(doc: MissionDocument) {
    if (!doc.configuration.launch.condition) return
    // Commit the verified observation together with its high-water/reservation.
    // Records without tracking begin here; never invent their earlier total.
    doc.checks ??= { count: 0, since: this.ports.now() }
    doc.checks.count++
  }
  private contiguous(doc: MissionDocument, wakes: MissionWake[]) {
    if (wakes.length > 256 || new Set(wakes.map(wake => `${wake.scheduleID}:${wake.run}`)).size !== wakes.length) return false
    const high = new Map(doc.calendars.filter(item => item.role === "principal").map(item => [item.scheduleID, item.highWater]))
    for (const wake of [...wakes].sort((a, b) => a.run - b.run)) {
      if (!high.has(wake.scheduleID) || wake.run !== high.get(wake.scheduleID)! + 1) return false
      high.set(wake.scheduleID, wake.run)
    }
    return true
  }
  private async read(locked: NativeMissionDocumentStore, id: string) {
    this.ports.current()
    const doc = await locked.read(id)
    return doc && !("deletedAt" in doc) ? doc : undefined
  }
  private change(locked: NativeMissionDocumentStore, doc: MissionDocument, mutate: (next: MissionDocument) => void, proof?: () => true,
    prepare?: () => Promise<void>) {
    return locked.change(doc.id, doc.revision, () => { proof?.(); return this.ports.current() }, mutate, prepare)
  }
}
