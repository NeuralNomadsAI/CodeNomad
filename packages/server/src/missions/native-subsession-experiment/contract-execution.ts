import type { AgentListOutput, ModelListOutput, SessionInfo } from "@opencode/client"
import { Model } from "@opencode/schema/model"
import { matchesExecution, parseExecution, type MissionExecution } from "../execution"

export interface ContractReference { missionID: string; revision: number; taskKey: string }
export interface ContractBinding extends ContractReference {
  parentID: string; childID: string; callID: string; messageID: string; depth: number
}
export interface NativeContractTask { key: string; execution?: unknown; reuseFromTaskKey?: string }
type NativeSession = {
  id: string; parentID?: string; projectID: string; location: { directory: string; workspaceID?: string }
  agent?: string; model?: SessionInfo["model"]
}
export interface NativeContractContext {
  location: { directory: string; workspaceID?: string; project: { id: string } }
  agent: { list(input: { location: { directory: string } }): Promise<{ data: readonly Pick<AgentListOutput["data"][number], "id" | "mode" | "hidden">[] }> }
  model: { list(input: { location: { directory: string } }): Promise<{ data: readonly Pick<ModelListOutput["data"][number], "id" | "providerID" | "enabled" | "capabilities" | "variants">[] }> }
  session: { get(input: { sessionID: string }): Promise<NativeSession> }
}
export interface ContractExecutionReads {
  readCurrent(sessionID: string): Promise<ContractBinding | undefined>
  readReport(ref: ContractReference): Promise<{ id: string; contract: ContractReference; sessionId: string; outcome: string } | undefined>
  readReturned(binding: ContractBinding): Promise<(ContractBinding & { contract: ContractReference; nativeReturned: boolean; reportID: string | null }) | undefined>
  /** REQUIRED trusted private authenticated observation; throw on busy/unknown.
   * Plugin SessionDomain has no active(). Do not infer idle from time/outcome. */
  assertNativeIdle(sessionID: string): Promise<void>
}
export interface PreparedNativeContractExecution {
  readonly request: MissionExecution | undefined
  /** Call under the wrapper project critical section immediately before native
   * invocation. Release that project lock BEFORE awaiting the native executor. */
  revalidateBeforeNative(): Promise<void>
  /** Call before binding/writing/forwarding structured native child progress. */
  assertProgressChild(sessionID: string): Promise<void>
  /** Entire native call (including returned-receipt write) owns the claim.
   * Wrapper MUST call in finally, including native errors/cancellation. */
  release(): void
}

// In-process exclusion only: not a durable claim or hostile-plugin authority.
const childClaims = new Map<string, symbol>()
const sameRef = (a: ContractReference, b: ContractReference) => a.missionID === b.missionID && a.revision === b.revision && a.taskKey === b.taskKey
const sameBinding = (a: ContractBinding, b: ContractBinding) => sameRef(a, b) && a.parentID === b.parentID && a.childID === b.childID
  && a.callID === b.callID && a.messageID === b.messageID && a.depth === b.depth

/** Use with ctx.session.hook("context", draft): readonly draft.agent/model are
 * actual resolved execution. Also accepts the real session.get selection. */
export function assertActualExecution(request: MissionExecution | undefined, actual: MissionExecution): void {
  if (!matchesExecution(request, actual)) throw new Error("Actual native execution does not match the Mission task selection")
}

async function validateCatalog(ctx: NativeContractContext, request: MissionExecution | undefined) {
  if (!request?.agent && !request?.model) return
  const input = { location: { directory: ctx.location.directory } }
  const [agents, models] = await Promise.all([ctx.agent.list(input), ctx.model.list(input)])
  // Installed native SubagentTool rejects primary-only agents; unlike root
  // Mission actors it allows subagent mode (and all mode).
  if (request.agent && !agents.data.some(agent => agent.id === request.agent && !agent.hidden && agent.mode !== "primary")) {
    throw new Error("Choose a visible native subagent/all agent for the Mission child")
  }
  if (request.model) {
    const selected = request.model
    const model = models.data.find(model => model.id === selected.id && model.providerID === selected.providerID)
    if (!model?.enabled || !model.capabilities.tools || (selected.variant !== undefined && !model.variants.some(v => v.id === selected.variant))) {
      throw new Error("Choose an enabled tool-capable native model and variant")
    }
  }
}

function inputExecution(nativeInput: Readonly<Record<string, unknown>>): MissionExecution {
  if (nativeInput.agent !== undefined && typeof nativeInput.agent !== "string") throw new Error("Invalid native subagent agent")
  if (nativeInput.model !== undefined && typeof nativeInput.model !== "string") throw new Error("Native subagent model must be provider/model#variant")
  // Installed @opencode/schema Model.Ref.parse splits the first slash and #;
  // model IDs may contain further slashes. Never invent a separate variant field.
  return { agent: nativeInput.agent as string | undefined,
    model: nativeInput.model === undefined ? undefined : Model.Ref.parse(nativeInput.model as string) }
}

/** Read-only preparation. No input rewrites, session switches or storage writes.
 * Parent/task admission and duplicate-owner checks stay in the wrapper. */
export async function prepareNativeContractExecution(
  ctx: NativeContractContext, task: NativeContractTask, ref: ContractReference, parentID: string,
  nativeInput: Readonly<Record<string, unknown>>, reads: ContractExecutionReads, previousBinding?: ContractBinding,
): Promise<PreparedNativeContractExecution> {
  if (task.key !== ref.taskKey) throw new Error("Task/reference mismatch")
  if (nativeInput.sessionID !== undefined && (typeof nativeInput.sessionID !== "string" || !nativeInput.sessionID)) throw new Error("Invalid native continuation sessionID")
  const childID = nativeInput.sessionID as string | undefined
  const reuseFromTaskKey = task.reuseFromTaskKey
  // Explicit reuse chooses the existing child; it never permits a fresh birth.
  // Refuse before any async catalog, storage or native ownership reads.
  if (reuseFromTaskKey !== undefined && childID === undefined) throw new Error("reuseFromTaskKey requires an explicit native continuation sessionID")
  const request = parseExecution(task.execution)
  assertActualExecution(request, inputExecution(nativeInput))
  await validateCatalog(ctx, request)
  const reference = { ...ref }
  const expected = childID ? await reads.readCurrent(childID) : undefined
  if (previousBinding && (!expected || !sameBinding(previousBinding, expected))) throw new Error("Previous native child binding changed")
  const previous = expected ? { ...expected } : undefined
  const location = { directory: ctx.location.directory, workspaceID: ctx.location.workspaceID }
  const projectID = ctx.location.project.id
  let claimedID: string | undefined
  let started = false
  let admitted = false
  let released = false
  const token = Symbol("native-contract-call")
  const claimKey = (id: string) => JSON.stringify([projectID, id])
  const claim = (id: string) => {
    if (released) throw new Error("Native execution claim already released")
    if (id === parentID) throw new Error("Cannot continue own parent session")
    if (claimedID && claimedID !== id) throw new Error("Native call changed its actual child identity")
    const key = claimKey(id)
    const owner = childClaims.get(key)
    if (owner && owner !== token) throw new Error("Native child already claimed by another execution")
    childClaims.set(key, token); claimedID = id
  }
  const release = () => {
    if (claimedID && childClaims.get(claimKey(claimedID)) === token) childClaims.delete(claimKey(claimedID))
    released = true
  }
  const owned = async (id: string, parent?: string) => {
    const session = await ctx.session.get({ sessionID: id })
    if (session.id !== id || session.projectID !== projectID || session.location.directory !== location.directory
      || session.location.workspaceID !== location.workspaceID || (parent !== undefined && session.parentID !== parent)) {
      throw new Error("Native parent/child project or Location ownership mismatch")
    }
    return session
  }
  const checkPrevious = async () => {
    if (!childID || !previous) throw new Error("Continuation has no current native contract binding")
    const current = await reads.readCurrent(childID)
    if (!current || !sameBinding(previous, current) || current.childID !== childID || current.parentID !== parentID
      || current.missionID !== reference.missionID) throw new Error("Foreign or changed native continuation contract")
    if (sameRef(reference, current)) return
    if (current.taskKey === reference.taskKey) throw new Error("Same-task continuation requires its exact current contract revision")
    if (reuseFromTaskKey !== current.taskKey) throw new Error("Cross-task continuation requires explicit reuseFromTaskKey")
    const report = await reads.readReport(current)
    if (!report || !report.id || report.outcome !== "completed" || report.sessionId !== childID || !sameRef(report.contract, current)) {
      throw new Error("Previous task requires its exact completed actual child report")
    }
    const returned = await reads.readReturned(current)
    if (!returned || returned.nativeReturned !== true || !sameBinding(returned, current) || !sameRef(returned.contract, current)
      || returned.reportID !== report.id) throw new Error("Previous task requires its exact native returned receipt")
  }
  const checkInput = () => {
    if (nativeInput.sessionID !== childID) throw new Error("Native continuation input changed")
    assertActualExecution(request, inputExecution(nativeInput))
  }
  return {
    request,
    async revalidateBeforeNative() {
      if (started || released) throw new Error("Native execution preparation is single-use")
      started = true
      try {
        // Original input stays untouched and must still match after async reads.
        checkInput()
        await validateCatalog(ctx, request)
        await owned(parentID)
        if (!childID) { checkInput(); admitted = true; return }
        claim(childID) // Refuse, never wait on own/ancestor/differently keyed task.
        await owned(childID, parentID)
        await checkPrevious()
        if (typeof reads.assertNativeIdle !== "function") throw new Error("Authoritative native idle observation unavailable")
        await reads.assertNativeIdle(childID)
        // Required under wrapper project lock: async idle cannot bless a stale
        // binding. This does not exclude external/native hostile sibling writes.
        await checkPrevious()
        await owned(childID, parentID)
        checkInput()
        admitted = true
      } catch (error) { release(); throw error }
    },
    async assertProgressChild(id) {
      if (!admitted || released) throw new Error("Native execution was not admitted or was released")
      if (childID && childID !== id) throw new Error("Native continuation returned a different child")
      claim(id) // New children become known only at actual structured progress.
      const child = await owned(id, parentID)
      assertActualExecution(request, { agent: child.agent, model: child.model })
    },
    release,
  }
}
