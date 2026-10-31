import assert from "node:assert/strict"
import test from "node:test"
import Fastify from "fastify"
import { registerMissionPlaybookRoutes } from "./mission-playbooks"
import type { MissionMap, MissionTask, MissionTemplateId } from "../../missions/model"
import { missionProfileRoles } from "../../missions/playbook-profiles"
import { buildActorContext, buildAssignmentPrompt, getMissionRecipe, missionRecipeCatalog } from "../../missions/recipes"
import type { MissionPlaybookDetails } from "../../missions/playbook-details"

const templates = Object.keys(missionProfileRoles) as MissionTemplateId[]

function mission(template: MissionTemplateId, taskMode: MissionMap["taskMode"]): MissionMap {
  return { version: 1, id: "mission", projectID: "project", projectCanonical: "/repo", objective: "Objective", template, taskMode,
    status: "active", coordinatorSessionId: "ses_coordinator", actors: [{ sessionId: "ses_coordinator", kind: "coordinator", managed: false,
      title: "Coordinator", roles: ["coordinator"], location: { directory: "/repo" }, joinedAt: 1 }], tasks: [], reports: [], frontier: [],
    claims: [], createdAt: 1, updatedAt: 1, revision: 1, history: [], historyTruncated: false }
}

async function read(url: string) {
  const app = Fastify({ logger: false })
  registerMissionPlaybookRoutes(app)
  try { return await app.inject({ method: "GET", url }) } finally { await app.close() }
}

for (const taskMode of ["native", "independent"] as const) {
  test(`${taskMode} playbook details cover every playbook and role exactly as its prompts are built`, async () => {
    const response = await read(`/api/missions/playbooks${taskMode === "native" ? "" : "?taskMode=independent"}`)
    assert.equal(response.statusCode, 200)
    const details = response.json() as MissionPlaybookDetails
    assert.equal(details.taskMode, taskMode)
    assert.deepEqual(details.playbooks.map(playbook => playbook.id), missionRecipeCatalog().map(playbook => playbook.id))
    assert.deepEqual([...details.playbooks.map(playbook => playbook.id)].sort(), [...templates].sort())
    for (const playbook of details.playbooks) {
      assert.deepEqual(playbook, getMissionRecipe(playbook.id, taskMode))
      assert.deepEqual(playbook.roles.map(role => role.id).sort(), [...missionProfileRoles[playbook.id]].sort(), playbook.id)
      for (const role of playbook.roles) assert.ok(role.title && role.purpose && role.instructions, `${playbook.id}/${role.id}`)
      const map = mission(playbook.id, taskMode)
      // Everything after the generic preamble is shown: a new coordinator block must be exposed too.
      const contract = `Playbook sequence:\n${playbook.sequence.map(step => `- ${step}`).join("\n")}\nCoordinator contract: ${playbook.coordinator}`
      assert.ok(buildActorContext(map, "ses_coordinator", { completedFinalOnly: true })
        .endsWith(`${contract}\n${[...details.coordinator, details.oneTimeCoordinator].join("\n")}`), `${playbook.id} one-time coordinator`)
      assert.ok(buildActorContext(map, "ses_coordinator").endsWith(`${contract}\n${details.coordinator.join("\n")}`), `${playbook.id} recurring coordinator`)
      for (const role of playbook.roles) {
        const task: MissionTask = { id: role.id, key: `task-${role.id}`, title: "Task", brief: "Brief", role: role.id, status: "ready",
          blockedBy: [], createdAt: 1, updatedAt: 1, outstandingExecution: false,
          ...(taskMode === "native" ? { executionMode: { kind: "native", parentTaskKey: null } } : {}) }
        const prompt = buildAssignmentPrompt({ ...map, tasks: [task] }, task)
        for (const text of [role.instructions, ...role.reportContract ? [role.reportContract] : [], details.task.join("\n")])
          assert.ok(prompt.includes(text), `${playbook.id}/${role.id} receives: ${text.slice(0, 60)}`)
      }
    }
  })
}

test("playbook details refuse unknown task modes and fields", async () => {
  for (const url of ["/api/missions/playbooks?taskMode=root", "/api/missions/playbooks?template=debug"]) {
    assert.equal((await read(url)).statusCode, 400, url)
  }
})
