import assert from "node:assert/strict"
import test from "node:test"
import { MissionControl } from "./control"
import { MISSION_INSPECT_OUTPUT_LIMIT } from "./inspect-view"
import { missionConfigurationTitle, normalizeMissionModels, parseMissionModel, validMissionModels } from "./model-library"
import { parseInspectInput } from "../opencode/missions-plugin"

const model = (index = 1) => ({ version: 1 as const, id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  name: "  Saved \n configuration  ", objective: "Brief", notes: "", template: "custom" as const,
  profiles: { coordinator: {}, roles: { specialist: {} } }, taskMode: "native" as const })

test("the shared saved configuration codec and title prefill preserve the editor's contract", () => {
  assert.equal(parseMissionModel(model()).name, "Saved \n configuration")
  assert.equal(missionConfigurationTitle(model().name), "Saved configuration")
  assert.equal(missionConfigurationTitle("x".repeat(59) + "😀"), "x".repeat(59))
  for (const value of [null, {}, [model(), model()], [{ ...model(), autoStart: true }], Array.from({ length: 21 }, (_, i) => model(i))]) {
    assert.equal(validMissionModels(value), false)
    assert.deepEqual(normalizeMissionModels(value), [])
  }
  assert.equal(validMissionModels(undefined), true)
})

test("saved configurations are read-only outside missions, short-listed and point-read with digest slices", async () => {
  let library: unknown = Array.from({ length: 20 }, (_, i) => ({ ...model(i), notes: "\0".repeat(20_000), objective: "\0".repeat(20_000) }))
  const initial = structuredClone(library)
  let reads = 0
  let directory = "/repo", onRead = () => {}
  const control = new MissionControl({
    project: { id: "project", canonical: "/repo", location: { directory: "/repo" } },
    storage: {
      get: async () => assert.fail("Configuration reads never touch the mission journal"),
      set: async () => assert.fail("Read-only"),
      scan: async () => assert.fail("Configuration reads never scan the journal"),
    },
    sessions: {
      get: async ({ sessionID }) => ({ id: sessionID, parentID: "ses_parent", projectID: "project", location: { directory } }),
      create: async () => assert.fail("Read-only"), prompt: async () => assert.fail("Read-only"), synthetic: async () => assert.fail("Read-only"),
    },
    transport: { readConfigurations: async () => { reads++; onRead(); return library }, prompt: async () => assert.fail(), synthetic: async () => assert.fail() },
  })
  const inspect = (input: unknown) => control.inspectTool("ses_owner", parseInspectInput(input), "read")
  const list = await inspect({ configurations: true }) as any
  assert.equal(list.configurations.length, 20)
  assert.deepEqual(Object.keys(list.configurations[0]), ["id", "name", "template"])
  const id = model(0).id
  const result = await inspect({ configurations: id }) as any
  assert.ok(JSON.stringify(result, null, 2).length <= MISSION_INSPECT_OUTPUT_LIMIT)
  const firstRead = result.configuration.read
  assert.equal(firstRead.content.kind, "configuration")
  assert.equal(firstRead.content.configurationID, id)
  assert.equal(firstRead.missionID, undefined)
  let read = firstRead, text = ""
  while (read) {
    const slice = await inspect(read) as any
    assert.ok(JSON.stringify(slice, null, 2).length <= MISSION_INSPECT_OUTPUT_LIMIT)
    text += slice.content.text
    read = slice.content.next
  }
  const record = JSON.parse(text)
  assert.equal(record.notes, "\0".repeat(20_000))
  assert.equal(record.title, "Saved configuration")
  assert.deepEqual(library, initial, "no normalization or repair writes")
  library = [{ ...model(0), notes: "Changed" }]
  await assert.rejects(inspect(firstRead), /changed since/)
  await assert.rejects(inspect({ configurations: model(20).id }), { code: "configuration-not-found" })
  library = undefined
  await assert.rejects(inspect({ configurations: true }), { code: "mission-preferences-invalid" })
  library = []
  assert.deepEqual(await inspect({ configurations: true }), { configurations: [] })
  assert.ok(reads >= 6)
  onRead = () => { directory = "/repo/moved" }
  await assert.rejects(inspect({ configurations: true }), { code: "foreign-session" })
})
