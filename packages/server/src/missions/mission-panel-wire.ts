import type { MissionTaskRequest } from "./mission-panel-map"

export interface MissionPanelCursor { digest: string; index: number; offset: number }
export interface MissionPanelSelection { offset: number; order?: string }
export type MissionPanelPageRequest =
  | { source: "summaries"; window?: MissionPanelSelection; initial?: true; cursor?: MissionPanelCursor }
  | { source: "cleanups"; window?: MissionPanelSelection; cursor?: MissionPanelCursor }
  | { source: "mission"; missionID: string; field?: string; part?: "receipts" | "pending"; text?: true; header?: true; window?: MissionPanelSelection; cursor?: MissionPanelCursor }
  | { source: "tasks"; task: MissionTaskRequest & { missionID: string }; cursor?: MissionPanelCursor }
  | { source: "activity"; missionID: string; actorOffset?: number; actorOrder?: string; cursor?: MissionPanelCursor }
  | { source: "marks"; missionOffset?: number; missionOrder?: string; cursor?: MissionPanelCursor }
export interface MissionPanelPiece { index: number; offset: number; characters: number; text: string }
export interface MissionPanelPage {
  available: true; version: 1; projectID: string; source: MissionPanelPageRequest["source"]
  missionID?: string; field?: string; part?: "receipts" | "pending"; text?: true; revision?: number; header?: true; finishHighWater?: number
  phase?: "context" | "observed"; observedAt?: number
  discardedEvents?: number; controlUnavailable?: boolean; notificationUnavailable?: boolean; cleanupUnavailable?: boolean
  window?: { order: string; offset: number; end: number; total: number }
  page: { digest: string; total: number; pieces: MissionPanelPiece[]; next?: MissionPanelCursor }
}
export type MissionPanelPageFailure = { available: false; reason: "invalid-request" | "changed" | "mission-not-found" | "field-not-found" | "invalid-cursor" | "damaged" | "observation-unavailable" }
export type MissionPanelPageResult = MissionPanelPage | MissionPanelPageFailure
