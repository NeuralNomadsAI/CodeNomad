import { parseRecurrenceDocument, type RecurrenceDocument } from "../../missions/recurrence-contract"
import type { RecurrenceAuthorizedAdmission } from "../../missions/recurrence-runner"
import { prepareMissionCreation } from "./mission-creation-pipeline"

type Preparation = Parameters<typeof prepareMissionCreation>[0]

/** Read-only extraction seam, NOT activated delivery. The existing authority
 * protocol has human-signed prepared creation and separate Play, but no standing
 * recurrence grant binding this passage/message/profile/roots/publication. Do
 * not substitute a boolean, ordinary host grant or raw native prompt for it. */
export function createMissionRecurrenceAdmissionPreparation(input: Pick<Preparation,
  "manager" | "fence" | "workspaceID" | "signal"> & {
  projectID: string; projectCanonical: string
}) {
  const prepare = async (raw: Readonly<RecurrenceDocument>) => {
    // Detached strict codec validates the durable passage/message derivation and
    // frozen profile/taskMode selections; caller aliases cannot retarget it.
    const document = parseRecurrenceDocument(raw, input.projectID, input.projectCanonical, raw.id)
    if (!document.pending || document.pending.admission || document.state === "stopped"
      || document.pending.passage.due.kind === "daily" && document.state !== "running") {
      throw new Error("Recurrence passage is not admissible")
    }
    const passage = document.pending.passage
    const prepared = await prepareMissionCreation({ ...input, expectedProjectID: document.projectID,
      request: { requestId: passage.id, objective: document.config.consigne, template: document.config.template,
        notes: document.config.notes,
        profiles: document.config.profiles, taskMode: document.config.taskMode, directory: document.config.roots[0].directory },
    })
    if (prepared.creationMessageID !== passage.messageID || prepared.request.objective !== document.config.consigne) {
      prepared.dispose()
      throw new Error("Recurrence creation identity differs from its durable passage")
    }
    // Deliberately do NOT expose prepared.execute: this extraction cannot grant
    // creation, environment writes, inbox reads, publication or model admission.
    return { request: prepared.request, missionID: prepared.missionID, sessionID: prepared.sessionID,
      passageID: passage.id, messageID: prepared.creationMessageID, dispose: prepared.dispose }
  }
  const admit: RecurrenceAuthorizedAdmission["admit"] = async (document, _beforeEffect) => {
    const prepared = await prepare(document)
    try { throw new Error("recurrence-standing-grant-unavailable") }
    finally { prepared.dispose() }
    // Throw preserves the runner's durable pending identity. Without exact
    // no-effect native evidence, never manufacture rejected/accepted receipts.
  }
  return { prepare, admit }
}
