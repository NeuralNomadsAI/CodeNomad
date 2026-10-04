import type { SessionInfo, SessionMessageInfo, SessionToolProgress } from "@opencode/client"
import { MissionJournal, type MissionStorage } from "../journal"
import { stableToken } from "../receipt-identity"
import { validateMissionReportArtifact } from "../contracts"
import type { MissionEvent, MissionJsonValue, MissionReport } from "../model"

type NativeReads = {
  session(id: string): Promise<SessionInfo>
  messages(id: string): Promise<readonly SessionMessageInfo[]>
  idleFamily(root: SessionInfo): Promise<boolean>
}
type Contract = {
  missionID: string; taskKey: string; rootID: string; coordinatorID: string
  projectID: string; directory: string; revision: number; sourceToken: string
}
type Edge = { parentID: string; childID: string; messageID: string; toolID: string; launch: string; metadata: unknown }
const prefix = "native-observer-experiment/v1/"

/** Experimental attach-only seam. No session creation, prompt admission, executor
 * interception, workflow queue, or automatic completion. Coordinator owns writes. */
export function createNativeMissionObserver(storage: MissionStorage, native: NativeReads, projectID: string, canonical: string) {
  const journal = new MissionJournal(storage, projectID, canonical)
  let clock = Date.now()
  const now = () => clock = Math.max(clock + 1, Date.now())
  const key = (rootID: string) => `${prefix}${journal.projectToken}/${rootID}`
  const event = (missionID: string, id: string) => ({ version: 1 as const, projectID, missionID, id, createdAt: now() })
  const owned = async (id: string) => {
    const session = await native.session(id)
    if (session.id !== id || session.projectID !== projectID || session.location.directory !== canonical) throw new Error("UNKNOWN: project/location changed")
    return session
  }
  const mission = async (missionID: string) => {
    const snapshot = await journal.snapshot()
    const result = snapshot.missions.find(m => m.id === missionID)
    if (!result || snapshot.discardedEvents || result.status !== "active") throw new Error("UNKNOWN: mission unavailable")
    return result
  }
  const writer = async (caller: string, missionID: string, revision: number) => {
    await owned(caller)
    const map = await mission(missionID)
    if (map.coordinatorSessionId !== caller) throw new Error("DENY: coordinator-only writer")
    if (map.revision !== revision) throw new Error("DENY: target revision changed")
    return map
  }
  const parts = async (id: string) => {
    const messages = await native.messages(id)
    // ponytail: private fixture is capped at 100 messages; production needs a
    // bounded native ToolID index, not silently scanning arbitrary full histories.
    if (messages.length > 100) throw new Error("UNKNOWN: transcript bound exceeded")
    return messages.flatMap(message => message.type === "assistant"
      ? message.content.flatMap(part => part.type === "tool" && part.name === "subagent" ? [{ messageID: message.id, part }] : []) : [])
  }
  const persistedEdges = async (parentID: string, childID: string): Promise<Edge[]> => (await parts(parentID)).flatMap(({ messageID, part }) => {
    if (!("metadata" in part.state) || part.state.metadata?.sessionID !== childID) return []
    return [{ parentID, childID, messageID, toolID: part.id, launch: part.state.status, metadata: part.state.metadata }]
  })
  const edges = async (parentID: string, childID: string) => {
    const persisted = await persistedEdges(parentID, childID)
    const page = await storage.scan({ prefix: `${prefix}${journal.projectToken}/edge/${childID}/`, limit: 100 })
    if (page.next) throw new Error("UNKNOWN: correlation fact bound")
    const facts = page.entries.map(e => e.value as unknown as Edge)
    if (facts.some(e => e.parentID !== parentID || e.childID !== childID || !e.toolID || !e.messageID)) throw new Error("UNKNOWN: stored native edge changed")
    return [...persisted, ...facts.filter(e => !persisted.some(p => p.toolID === e.toolID))]
  }

  async function context(sourceID: string) {
    const source = await owned(sourceID)
    let current = source
    const path: Edge[][] = []
    const seen = new Set<string>()
    for (let depth = 0; depth <= 6; depth++) {
      if (seen.has(current.id)) throw new Error("UNKNOWN: ancestry cycle")
      seen.add(current.id)
      const stored = await storage.get(key(current.id)) as Contract | undefined
      if (stored) {
        if (stored.rootID !== current.id || stored.projectID !== projectID || stored.directory !== canonical) throw new Error("UNKNOWN: stored contract identity")
        const map = await mission(stored.missionID)
        const task = map.tasks.find(t => t.key === stored.taskKey)
        if (map.coordinatorSessionId !== stored.coordinatorID || task?.actorSessionId !== stored.rootID
          || task.status === "withdrawn" || stableToken(JSON.stringify([task.key, task.title, task.brief, task.role, task.blockedBy])) !== stored.sourceToken) throw new Error("UNKNOWN: source contract changed")
        return { status: "assigned" as const, contract: stored, sourceID, depth, path,
          correlation: path.some(edge => !edge.length) ? "pending" : "proved" }
      }
      if (!current.parentID) return { status: "unassigned" as const, sourceID, depth, path }
      const parent = await owned(current.parentID)
      const candidates = await edges(parent.id, current.id)
      // Parent/task scope is already unambiguous from authorized native ancestry.
      // Missing in-flight parts prevent invocation/evidence claims, not inherited
      // mission context. Never select a sibling tool by timing or prompt text.
      // Multiple native continuations are the same child, not competing task
      // assignments. Preserve every stable ToolID; never invent an invocation ID.
      path.push(candidates)
      current = parent
    }
    return { status: "unknown" as const, sourceID, depth: 7, path, reason: "ancestry limit" }
  }

  return {
    async intent(caller: string, missionID: string, objective: string, tasks: Array<{ key: string; blockedBy: string[] }>) {
      const coordinator = await owned(caller)
      if (coordinator.parentID) throw new Error("DENY: intent requires existing root coordinator")
      if (!objective.length || objective.length > 20_000 || !tasks.length || tasks.length > 8
        || new Set(tasks.map(t => t.key)).size !== tasks.length) throw new Error("DENY: invalid intent")
      for (const task of tasks) if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(task.key)
        || task.blockedBy.some(k => k === task.key || !tasks.some(t => t.key === k))) throw new Error("DENY: invalid dependency")
      if (await journal.event(missionID, "observer_created")) throw new Error("DENY: existing intent")
      await journal.append({ ...event(missionID, "observer_created"), type: "mission.created", projectCanonical: canonical,
        objective, template: "custom", coordinator: { sessionID: caller, title: coordinator.title ?? caller, location: coordinator.location } })
      for (const task of tasks) await journal.append({ ...event(missionID, `task_${task.key.replaceAll(/[.-]/g, "_")}`), type: "task.created",
        task: { id: stableToken(task.key), key: task.key, title: task.key, brief: objective, role: "prototype", blockedBy: task.blockedBy } })
      return journal.snapshot()
    },
    async attach(caller: string, missionID: string, taskKey: string, rootID: string, revision: number) {
      const map = await writer(caller, missionID, revision)
      const root = await owned(rootID)
      const task = map.tasks.find(t => t.key === taskKey)
      if (root.parentID || !task || task.report || task.status === "withdrawn" || task.status === "blocked") throw new Error("DENY: invalid existing-root attachment")
      const contract: Contract = { missionID, taskKey, rootID, coordinatorID: caller, projectID, directory: canonical,
        revision,
        sourceToken: stableToken(JSON.stringify([task.key, task.title, task.brief, task.role, task.blockedBy])) }
      const existing = await storage.get(key(rootID))
      if (existing && JSON.stringify(existing) !== JSON.stringify(contract)) throw new Error("UNKNOWN: overlapping root contracts")
      if (task.actorSessionId && task.actorSessionId !== rootID) throw new Error("DENY: root reassignment needs separate permission")
      // Existing reducer actor bookkeeping only: these events do not dispatch or
      // acknowledge any native execution. No inbox admission is asserted.
      if (!task.actorSessionId) {
        const bookkeeping = `observer_${stableToken(`${missionID}/${taskKey}`)}`
        await journal.append({ ...event(missionID, `${bookkeeping}_attached`), type: "task.dispatching", taskKey,
          actor: { sessionID: rootID, title: root.title ?? rootID, location: root.location, managed: false }, admissionID: bookkeeping, delivery: "queue" })
      }
      await owned(rootID)
      await writer(caller, missionID, revision + (task.actorSessionId ? 0 : 1))
      await storage.set(key(rootID), contract as unknown as MissionJsonValue)
      return contract
    },
    context,
    async observe(event: SessionToolProgress) {
      const childID = event.data.metadata.sessionID
      if (event.location?.directory !== canonical || typeof childID !== "string") return
      const child = await owned(childID), parent = await owned(event.data.sessionID)
      if (child.parentID !== parent.id) throw new Error("UNKNOWN: native progress parent mismatch")
      const edge: Edge = { parentID: parent.id, childID, messageID: event.data.assistantMessageID, toolID: event.data.id,
        launch: "observed", metadata: event.data.metadata }
      // Observed native facts, not task authority or completion. Event lag never
      // blocks ancestry inheritance, and persisted Tool parts supersede facts.
      await storage.set(`${prefix}${journal.projectToken}/edge/${childID}/${event.data.id}`, edge as unknown as MissionJsonValue)
    },
    async watch(ids: string[]) {
      if (ids.length > 33 || new Set(ids).size !== ids.length) throw new Error("UNKNOWN: native tree bound")
      return Promise.all(ids.map(async id => {
        const session = await owned(id)
        let observation
        try { observation = await context(id) }
        catch (error) { observation = { status: "unknown", sourceID: id, reason: String(error) } }
        return { session, observation, nativeSubagentParts: await parts(id) }
      }))
    },
    async report(caller: string, input: { missionID: string; taskKey: string; rootID: string; sourceID: string; revision: number;
      evidenceToolID: string; summary: string; reportID: string }) {
      const map = await writer(caller, input.missionID, input.revision)
      const observed = await context(input.sourceID)
      if (observed.status !== "assigned" || observed.contract.missionID !== input.missionID
        || observed.contract.taskKey !== input.taskKey || observed.contract.rootID !== input.rootID) throw new Error("DENY: report task/source mismatch")
      const task = map.tasks.find(t => t.key === input.taskKey)
      if (!task || task.report || !input.summary.length || input.summary.length > 20_000) throw new Error("DENY: invalid report")
      const source = await owned(input.sourceID)
      const stableEdge = observed.path.flat().find(e => e.toolID === input.evidenceToolID && e.childID === source.id)
      if (!stableEdge || source.outcome !== "succeeded" || stableEdge.launch !== "completed") throw new Error("UNKNOWN: evidence not terminal")
      const root = await owned(input.rootID)
      if (root.outcome !== "succeeded" || !await native.idleFamily(root)) throw new Error("UNKNOWN: root/native family still running or unavailable")
      validateMissionReportArtifact({ template: map.template, role: task.role, outcome: "completed" })
      await writer(caller, input.missionID, input.revision)
      const report: MissionReport = { id: input.reportID, taskKey: input.taskKey, sessionId: input.rootID, outcome: "completed",
        summary: input.summary, evidence: [JSON.stringify(stableEdge)], next: [], createdAt: now(),
        artifact: { sourceID: source.id, rootID: root.id, sourceOutcome: source.outcome, toolID: stableEdge.toolID, depth: observed.depth } }
      const record: MissionEvent = { ...event(input.missionID, `reported_${stableToken(input.reportID)}`), type: "task.reported", report }
      await journal.append(record)
      return journal.snapshot()
    },
    snapshot: () => journal.snapshot(),
  }
}
