import type { Session } from "../types/session"

type SessionUpdateInfo = Pick<Session, "id" | "title" | "version" | "time" | "revert"> & {
  parentID?: string | null
}

export function mapSessionRevert(revert: SessionUpdateInfo["revert"] | null | undefined): Session["revert"] {
  return revert
    ? {
        messageID: revert.messageID,
        partID: revert.partID,
        snapshot: revert.snapshot,
        diff: revert.diff,
      }
    : undefined
}

export function createSessionFromSessionUpdateInfo(
  instanceId: string,
  info: SessionUpdateInfo,
  untitledTitle: string,
  now = Date.now(),
): Session {
  return {
    id: info.id,
    instanceId,
    title: info.title || untitledTitle,
    parentId: info.parentID || null,
    agent: "",
    model: {
      providerId: "",
      modelId: "",
    },
    status: "idle",
    retry: null,
    idleSince: null,
    version: info.version || "0",
    time: info.time
      ? { ...info.time }
      : {
          created: now,
          updated: now,
        },
    revert: mapSessionRevert(info.revert),
  }
}
