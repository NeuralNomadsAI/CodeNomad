import type { SessionMetadata } from "@opencode-ai/client"
import type { MissionActor, MissionJsonValue, MissionMap, MissionReportOutcome, MissionTemplateId } from "./model"
import type { MissionRecipe, missionRecipeCatalog } from "./recipes"

export interface NativeMissionSession {
  id: string
  parentID?: string
  projectID: string
  title?: string
  location: { directory: string; workspaceID?: string }
}

export interface MissionSessionAdapter {
  get(input: { sessionID: string }): Promise<NativeMissionSession>
  create(input: {
    id: string
    title: string
    location: { directory: string; workspaceID?: string }
    metadata: SessionMetadata
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

export interface MissionStartInput {
  objective: string
  template: MissionTemplateId
  notes?: string
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

export interface MissionInspection {
  mission: MissionMap | null
  actor: MissionActor | null
  templates: ReturnType<typeof missionRecipeCatalog>
  playbook?: MissionRecipe
}
