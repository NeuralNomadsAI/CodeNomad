import type { SessionMetadata } from "@opencode/client"
import type { MissionExecution } from "./execution"
import type { MissionTaskExecutionMode, MissionTaskMode } from "./task-execution-mode"
import type { MissionActor, MissionJsonValue, MissionMap, MissionReportOutcome, MissionTemplateId, MissionNativeBinding } from "./model"
import type { TaskContractReference } from "./task-declaration"
import type { MissionRecipe, missionRecipeCatalog } from "./recipes"
import type { MissionProfiles } from "./playbook-profiles"

export interface NativeMissionSession extends MissionExecution {
  id: string
  parentID?: string
  projectID: string
  title?: string
  metadata?: SessionMetadata
  location: { directory: string; workspaceID?: string }
}

export interface MissionSessionAdapter {
  get(input: { sessionID: string }): Promise<NativeMissionSession>
  remove?(input: { sessionID: string }): Promise<void>
  list?(input: { parentID: string; limit: number }): Promise<{ data: readonly { id: string }[]; cursor?: { next?: string | null } }>
  create(input: {
    id: string
    title: string
    location: { directory: string; workspaceID?: string }
    metadata: SessionMetadata
    agent?: MissionExecution["agent"]
    model?: MissionExecution["model"]
  }): Promise<NativeMissionSession>
  prompt(input: {
    sessionID: string
    id: string
    text: string
    metadata: SessionMetadata
    delivery: "queue" | "steer"
    resume: true
  }): Promise<unknown>
  synthetic(input: {
    sessionID: string
    id: string
    text: string
    description: string
    metadata: SessionMetadata
    delivery: "queue"
    resume: true
  }): Promise<unknown>
}

export interface MissionProject {
  id: string
  canonical: string
  location: { directory: string; workspaceID?: string }
}

export type MissionManagedRootCreation = (coordinatorID: string,
  input: { missionID: string; taskKey: string }) => Promise<NativeMissionSession>

export interface MissionStartInput {
  objective: string
  template: MissionTemplateId
  notes?: string
  profiles?: MissionProfiles
  taskMode?: MissionTaskMode
}

export interface MissionInspectInput {
  missionID?: string
  start?: MissionStartInput
}

export interface MissionDelegateInput {
  missionID?: string
  taskKey: string
  title: string
  brief: string
  role: string
  blockedBy: string[]
  targetSessionID?: string
  delivery: "queue" | "steer"
  execution?: MissionExecution
  executionMode?: MissionTaskExecutionMode
}

/** Business declaration only. Native OpenCode owns child creation and prompting. */
export interface MissionDeclareInput {
  missionID?: string
  taskKey: string
  title: string
  brief: string
  role: string
  blockedBy: string[]
  execution?: MissionExecution
  executionMode?: MissionTaskExecutionMode
}

export interface MissionReportInput {
  missionID?: string
  taskKey?: string
  outcome: MissionReportOutcome
  summary: string
  evidence: string[]
  next: string[]
  artifact?: MissionJsonValue
  final: boolean
}

/** Actual tool identities are supplied by the trusted adapter, never model JSON. */
export interface MissionNativeReportRequest {
  contract: TaskContractReference
  sessionID: string
  toolCallID: string
  messageID: string
}
export type MissionNativeReportAuthorization = (request: MissionNativeReportRequest) => Promise<{
  call: MissionNativeBinding
  current(): true
}>

export interface MissionInspection {
  mission: MissionMap | null
  actor: MissionActor | null
  templates: ReturnType<typeof missionRecipeCatalog>
  playbook?: MissionRecipe
  catalog?: {
    agents: Array<{ id: string; mode: string; description?: string }>
    models: Array<{ providerID: string; id: string; variants: string[] }>
  }
}

export interface MissionCreateInput extends MissionStartInput {
  prepared?: boolean
  requestID: string
  coordinatorSessionID?: string
  expectedCoordinatorLocation?: NativeMissionSession["location"]
}

export interface MissionUpdateInput {
  missionID: string
  objective: string
  notes?: string
  expectedRevision: number
  requestID: string
}

export interface MissionDeleteInput {
  missionID: string
  expectedRevision: number
  requestID: string
  deleteManagedSessions?: boolean
}

export interface MissionReviseInput {
  missionID?: string
  expectedRevision: number
  requestID: string
  reason: string
  objective?: string
  notes?: string
  retireTasks: Array<{ taskKey: string; replacementTaskKey?: string }>
  addTasks: Array<{
    taskKey: string
    title: string
    brief: string
    role: string
    execution?: MissionExecution
    executionMode?: MissionTaskExecutionMode
    blockedBy: string[]
    replacesTaskKey?: string
  }>
  dependencyUpdates: Array<{ taskKey: string; blockedBy: string[] }>
}

export interface MissionInputTransport {
  lifecycle?(coordinatorID: string, input: { missionID: string; operationID: string; sessionID: string;
    recurrence?: import("./lifecycle-model").MissionLifecycleInput["recurrence"] }): Promise<unknown>
  cleanup?(coordinatorID: string, input: { missionID: string; deletionID: string; sessionID: string }): Promise<{ outcome: "removed" | "retained"; reason?: import("./model").MissionCleanupReason }>
  prompt(coordinatorID: string, input: Parameters<MissionSessionAdapter["prompt"]>[0]): Promise<unknown>
  synthetic(coordinatorID: string, input: Parameters<MissionSessionAdapter["synthetic"]>[0]): Promise<unknown>
}
