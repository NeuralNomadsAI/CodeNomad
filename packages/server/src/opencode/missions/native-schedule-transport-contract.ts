export type NativeScheduleWake = Readonly<{
  missionID: string
  generation: number
  scheduleID: string
  run: number
  sessionID: string
  messageID: string
}>
export type NativeSchedulePreflight = Readonly<{ cutoff: number; issuedAt: number; signature: string }>

export const nativeScheduleWakeKey = (wake: NativeScheduleWake) => JSON.stringify([
  wake.missionID, wake.generation, wake.scheduleID, wake.run, wake.sessionID, wake.messageID,
])
export const nativeScheduleWakeIdentity = (wake: NativeScheduleWake): NativeScheduleWake => {
  const { missionID, generation, scheduleID, run, sessionID, messageID } = wake
  return { missionID, generation, scheduleID, run, sessionID, messageID }
}

export function assertNativeScheduleWake(wake: NativeScheduleWake): void {
  if (!wake || ![wake.missionID, wake.scheduleID, wake.sessionID, wake.messageID].every(value =>
    typeof value === "string" && value.length > 0 && value.length <= 1024)
    || !Number.isSafeInteger(wake.generation) || wake.generation < 1
    || !Number.isSafeInteger(wake.run) || wake.run < 1
    || wake.messageID !== `msg_${wake.scheduleID}_${wake.run}`) throw new Error("schedule-wake-identity")
}

const text = { type: "string", minLength: 1, maxLength: 4096 } as const
const preflight = { type: "object", properties: { cutoff: { type: "integer", minimum: 0 }, issuedAt: { type: "integer", minimum: 0 },
  signature: { type: "string", minLength: 64, maxLength: 64 } }, required: ["cutoff", "issuedAt", "signature"], additionalProperties: false } as const
const input = {
  type: "object", additionalProperties: false, required: ["wake", "incarnation", "registrationFile"],
  properties: {
    registrationFile: text,
    preflight,
    wake: { type: "object", additionalProperties: false,
      required: ["missionID", "generation", "scheduleID", "run", "sessionID", "messageID"],
      properties: { missionID: text, generation: { type: "integer", minimum: 1 }, scheduleID: text,
        run: { type: "integer", minimum: 1 }, sessionID: text, messageID: text } },
    incarnation: { type: "object", additionalProperties: false, required: ["id", "pid", "url"],
      properties: { id: text, pid: { type: "integer", minimum: 1 }, url: text, version: text } },
  },
} as const
const output = { type: "object", additionalProperties: false, required: ["key", "state"],
  properties: { key: { type: "string", maxLength: 32768 }, state: { enum: ["applied", "pending", "rejected", "unknown"] },
    messagePresent: { type: "boolean" }, ready: { type: "boolean" }, preflight } } as const

/** Internal service-owned adapter. Register wake with CAS and status as a pure read. */
export const NativeScheduleTransportRpc = {
  id: "codenomad.missions.schedule", methods: { wake: { input, output }, status: { input, output } }, events: {},
} as const

export type NativeScheduleTransportReply = { key: string; state: "applied" | "pending" | "rejected" | "unknown"; messagePresent?: boolean;
  ready?: boolean; preflight?: NativeSchedulePreflight }
