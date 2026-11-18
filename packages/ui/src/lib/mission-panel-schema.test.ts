import assert from "node:assert/strict"
import test from "node:test"
import { panelHeaderSchema } from "./mission-panel-schema"

test("preparation provenance requires an author and accepts an optional source mission", () => {
  const schema = panelHeaderSchema.shape.root.shape.preparedBy
  for (const preparedBy of [
    { coordinatorSessionId: "ses_author" },
    { coordinatorSessionId: "ses_coordinator", missionId: "msn_source" },
  ]) assert.deepEqual(schema.parse(preparedBy), preparedBy)
  for (const preparedBy of [{}, { missionId: "msn_source" }, { coordinatorSessionId: "" },
    { coordinatorSessionId: "ses_author", missionId: null }]) {
    assert.equal(schema.safeParse(preparedBy).success, false)
  }
})
