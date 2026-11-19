import type { MissionPanelMap } from "./mission-panel-map"

export type MissionCreationReceipt =
  | { requestId: string; state: "unknown" | "rejected" }
  | { requestId: string; state: "created"; mission: MissionPanelMap }
