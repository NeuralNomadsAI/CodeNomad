import assert from "node:assert/strict"
import { realpath } from "node:fs/promises"
import { tsImport } from "tsx/esm/api"

// Called only by the isolated location fixture, using its synthetic repository,
// native client and private daemon. Never discovers the user's service.
export async function testNativeWorktreeFamily({ client, profile, rootLocation, worktreeLocation }) {
  const { moveProjectSessionFamily, removeProjectWorktree } = await tsImport("../packages/server/src/workspaces/project-session-families.ts", import.meta.url)
  const { locationRequestOptions, readLocationRef } = await tsImport("../packages/server/src/opencode/compatibility/location.ts", import.meta.url)
  const source = { directory: rootLocation.directory, ...(profile === "legacy" ? { workspaceID: "wrk_family_fixture" } : {}) }
  const root = await client.session.create({ location: { directory: source.directory }, title: "Synthetic family root" }, locationRequestOptions(source))
  const seed = await client.session.create({ location: { directory: source.directory }, title: "Synthetic family child" }, locationRequestOptions(source))
  const exported = await client.session.export({ sessionID: seed.id })
  await client.session.remove({ sessionID: seed.id })
  const child = await client.session.import({ ...exported, info: { ...exported.info, parentID: root.id }, location: { directory: source.directory } }, locationRequestOptions(source))
  assert.equal(child.parentID, root.id)
  const resolveExactDirectory = directory => realpath(directory).catch(() => undefined)
  try {
    await client.worktree.refresh({ projectID: rootLocation.project.id }, locationRequestOptions(readLocationRef(rootLocation), { includeDirectory: true }))
    const moved = await moveProjectSessionFamily({
      client, projectLocation: source, sessionId: child.id,
      targetDirectory: worktreeLocation.directory, resolveExactDirectory,
    })
    assert.deepEqual(new Set(moved.sessionIds), new Set([root.id, child.id]))
    for (const session of [root, child]) {
      assert.deepEqual(readLocationRef((await client.session.get({ sessionID: session.id })).location), readLocationRef(worktreeLocation))
    }
    await assert.rejects(removeProjectWorktree({
      client, projectLocation: readLocationRef(worktreeLocation), targetDirectory: worktreeLocation.directory,
      rootDirectory: rootLocation.directory, resolveExactDirectory, isTargetRegistered: async () => true,
      remove: async () => {
        for (const session of [root, child]) {
          assert.deepEqual(readLocationRef((await client.session.get({ sessionID: session.id })).location), readLocationRef(rootLocation))
        }
        throw new Error("Synthetic family Git removal refusal")
      },
    }), /Synthetic family Git removal refusal/)
    for (const session of [root, child]) {
      assert.deepEqual(readLocationRef((await client.session.get({ sessionID: session.id })).location), readLocationRef(worktreeLocation))
    }
    console.log(`PASS: native ${profile} complete family move, worktree refresh and verified evacuation rollback`)
  } finally {
    await Promise.allSettled([child, root].map(session => client.session.remove({ sessionID: session.id })))
  }
}
